// Tidal through the backend: GHCi running Tidal, sending to SuperDirt in
// sclang (src-tauri/src/tidal). The processes start when a .tidal track is
// first opened; their state arrives as tidal-status events. While patterns
// play, the code they came from lights up (./highlight.ts). If GHCi crashes,
// the backend restarts it and the blocks that were playing are sent again.

import { StreamLanguage } from '@codemirror/language';
import { haskell } from '@codemirror/legacy-modes/mode/haskell';
import type { EditorState } from '@codemirror/state';

import * as ipc from '$lib/ipc';
import { addLog } from '$lib/log.svelte';
import { referenceHints } from '$lib/reference/hints';
import { blockAt, lineOrSelection } from '../regions';
import type { Effects, EngineState, EvalResult, EvalScope, LanguageAdapter, Range } from '../types';
import { claimIds, lineStarts, patternIds, releaseIds, showEvents, tidalHighlighting } from './highlight';

/** How long to wait for GHCi and SuperDirt to come up. */
const START_TIMEOUT_MS = 120_000;

const stopped: ipc.ProcState = { status: 'stopped', message: null };

interface Sounding {
  event: ipc.TidalHighlight;
  path: string;
  /** performance.now() when it stops. */
  until: number;
}

export class TidalAdapter implements LanguageAdapter {
  readonly id = 'tidal' as const;
  readonly name = 'Tidal';
  readonly extensions = ['.tidal'];
  state = $state<EngineState>({ status: 'stopped', nowPlaying: null });
  procs = $state<ipc.TidalStatus>({ sclang: stopped, ghci: stopped, output: null, recovering: false });
  /** Null until the first check finishes. */
  prereqs = $state<ipc.Prereq[] | null>(null);
  checking = $state(false);

  private playing = false;
  private booted: Promise<void> | null = null;
  private settled: (() => void)[] = [];
  /** Which track each pattern id was last evaluated from. */
  private owners = new Map<string, string>();
  /** The block that last set each pattern id, oldest first, for replaying after a crash. */
  private blocks = new Map<string, string>();
  /** The last block that set the tempo without setting a pattern (a hush keeps the tempo). */
  private tempo: string | null = null;
  private sounding: Sounding[] = [];
  /** Tracks that had marks last frame, so they can be cleared. */
  private lit = new Set<string>();
  private frame = 0;
  onFrame: ((effects: Effects, path?: string) => void) | null = null;

  /** Both processes are up. A getter, so TypeScript doesn't narrow it across awaits. */
  get running() {
    return this.state.status === 'ready' || this.state.status === 'playing';
  }

  get missing() {
    return (this.prereqs ?? []).filter((p) => p.required && !p.ok);
  }

  editorExtensions() {
    return [StreamLanguage.define(haskell), tidalHighlighting, referenceHints('tidal')];
  }

  regionFor(state: EditorState, scope: EvalScope): Range {
    return scope === 'main' ? blockAt(state) : lineOrSelection(state);
  }

  boot() {
    this.booted ??= this.doBoot();
    return this.booted;
  }

  private async doBoot() {
    void ipc.onTidalStatus((s) => this.applyStatus(s));
    void ipc.onTidalHighlight((events) => this.onEvents(events));
    void ipc.onTidalRecovered(() => void this.replay());
    this.applyStatus(await ipc.tidalStatus());
    await this.check();
  }

  /** Looks for GHC, Tidal, SuperCollider and SuperDirt. */
  async check() {
    this.checking = true;
    try {
      this.prereqs = await ipc.tidalCheck();
    } finally {
      this.checking = false;
    }
    if (this.missing.length) {
      addLog('tidal', `Not set up: missing ${this.missing.map((p) => p.name).join(', ')}`, 'warning');
    }
    this.applyStatus(this.procs);
  }

  private applyStatus(s: ipc.TidalStatus) {
    this.procs = s;
    const both = [s.sclang.status, s.ghci.status];
    if (this.missing.length && both.every((b) => b === 'stopped')) this.state.status = 'unavailable';
    else if (both.includes('error')) this.state.status = 'error';
    else if (both.every((b) => b === 'ready')) this.state.status = this.playing ? 'playing' : 'ready';
    else if (both.every((b) => b === 'stopped')) this.state.status = 'stopped';
    else this.state.status = 'booting';
    // While a crashed process restarts, keep what's playing so it can resume.
    if (!both.every((b) => b === 'ready') && !s.recovering) {
      this.playing = false;
      this.releaseAll();
    }
    if (this.state.status !== 'booting') {
      for (const resolve of this.settled.splice(0)) resolve();
    }
  }

  private setPlaying(playing: boolean) {
    this.playing = playing;
    this.applyStatus(this.procs);
  }

  activate() {
    void this.boot().then(() => {
      if (this.state.status === 'stopped') void this.start();
    });
  }

  async start() {
    try {
      await ipc.tidalStart();
    } catch (err) {
      addLog('tidal', `Couldn't start: ${err}`, 'error');
    }
    // Status events can trail the command; this one is definitive.
    this.applyStatus(await ipc.tidalStatus());
  }

  async stop() {
    this.tempo = null;
    await ipc.tidalStop();
  }

  async restart() {
    this.tempo = null;
    await ipc.tidalStop();
    await ipc.tidalStart();
  }

  /** Starts the processes if needed and waits until both are up. */
  async ensureRunning() {
    await this.boot();
    if (this.running) return;
    if (this.state.status === 'unavailable') {
      throw new Error(
        `Tidal isn't set up: ${this.missing.map((p) => p.name).join(', ')} missing. Click Tidal in the status bar for setup help.`,
      );
    }
    const settled = new Promise<void>((resolve) => this.settled.push(resolve));
    if (this.state.status !== 'booting') await this.start();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Tidal took too long to start; see the log.')), START_TIMEOUT_MS),
    );
    await Promise.race([settled, timeout]);
    if (!this.running) {
      const failed = [this.procs.ghci, this.procs.sclang].find((p) => p.status === 'error');
      throw new Error(`Tidal didn't start: ${failed?.message ?? this.state.status}`);
    }
  }

  unlockAudio() {}

  async evaluate(code: string, range: Range, path: string): Promise<EvalResult> {
    try {
      await this.ensureRunning();
      const reply = await ipc.tidalEval(code);
      if (!reply.ok) {
        return { ok: false, error: { message: tidyError(reply.output), pos: position(code, range, reply) } };
      }
    } catch (err) {
      return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
    }
    if (/\b(hush|panic)\b/.test(code)) this.releaseAll();
    this.setPlaying(!/^\s*(hush|panic)\s*$/.test(code));
    const ids = patternIds(code);
    this.remember(ids, code);
    return { ok: true, effects: this.claim(ids, code, range, path) };
  }

  // ---- crash recovery ---------------------------------------------------

  private remember(ids: string[], code: string) {
    if (/\b(hush|panic)\b/.test(code)) return;
    for (const id of ids) {
      this.blocks.delete(id);
      this.blocks.set(id, code);
    }
    if (!ids.length && /\bset(cps|bpm)\b/.test(code)) this.tempo = code;
  }

  /** Sends the blocks that were playing to a GHCi that came back from a crash. */
  private async replay() {
    const ids = [...this.blocks.keys()].filter((id) => this.owners.has(id));
    const codes = [...new Set([...(this.tempo ? [this.tempo] : []), ...ids.map((id) => this.blocks.get(id)!)])];
    if (!codes.length) return addLog('tidal', 'Tidal restarted after a crash');
    addLog('tidal', `Tidal restarted after a crash; playing ${ids.length === 1 ? 'the pattern' : `${ids.length} patterns`} again`, 'warning');
    for (const code of codes) {
      const reply = await ipc.tidalEval(code).catch((err) => ({ ok: false, output: String(err) }));
      if (!reply.ok) addLog('tidal', `Couldn't replay a block: ${tidyError(reply.output)}`, 'error');
    }
    if (ids.length) this.setPlaying(true);
  }

  // ---- highlighting -----------------------------------------------------

  /** Makes `path` the source of `ids`, taking them from other tracks. */
  private claim(ids: string[], code: string, range: Range, path: string): Effects {
    if (!ids.length) return [];
    const taken = new Map<string, string[]>();
    for (const id of ids) {
      const owner = this.owners.get(id);
      if (owner && owner !== path) taken.set(owner, [...(taken.get(owner) ?? []), id]);
      this.owners.set(id, path);
    }
    for (const [owner, lost] of taken) this.onFrame?.([releaseIds.of(lost)], owner);
    return [claimIds.of({ ids, lineStarts: lineStarts(code, range.from) })];
  }

  private releaseAll() {
    const owners = new Set(this.owners.values());
    this.owners.clear();
    this.blocks.clear();
    this.sounding = [];
    for (const owner of owners) this.onFrame?.([releaseIds.of(null)], owner);
    this.lit.clear();
  }

  private onEvents(events: ipc.TidalHighlight[]) {
    const now = performance.now();
    for (const event of events) {
      const path = this.owners.get(event.id);
      if (path) this.sounding.push({ event, path, until: now + event.duration * 1000 });
    }
    this.draw(true); // at once, so a mark is never late
    this.frame ||= requestAnimationFrame(this.tick);
  }

  private tick = () => {
    this.frame = 0;
    this.draw();
    if (this.sounding.length) this.frame = requestAnimationFrame(this.tick);
  };

  /** Shows what's sounding on each track, and clears tracks that went quiet. */
  private draw(changed = false) {
    const now = performance.now();
    const before = this.sounding.length;
    this.sounding = this.sounding.filter((s) => s.until > now);
    const byTrack = new Map<string, ipc.TidalHighlight[]>();
    for (const s of this.sounding) byTrack.set(s.path, [...(byTrack.get(s.path) ?? []), s.event]);
    if (!changed && before === this.sounding.length) return;
    for (const path of this.lit) if (!byTrack.has(path)) this.onFrame?.([showEvents.of([])], path);
    for (const [path, events] of byTrack) this.onFrame?.([showEvents.of(events)], path);
    this.lit = new Set(byTrack.keys());
  }

  async hush() {
    if (!this.running) return;
    await ipc.tidalEval('hush').catch((err) => addLog('tidal', `hush failed: ${err}`, 'error'));
    this.setPlaying(false);
  }

  async loadSamples() {
    await ipc.tidalReloadSamples();
  }

  setVolume(gain: number) {
    void ipc.tidalVolume(gain);
  }

  async dispose() {
    await ipc.tidalStop();
  }
}

/** Drops GHCi's `<interactive>:L:C:` prefixes; the editor marks the place. */
function tidyError(output: string) {
  return output.replace(/<interactive>:[\d:,()-]+: /g, '').trim() || 'GHCi reported an error';
}

/** Document position of GHCi's 1-based line/column within `code`. */
function position(code: string, range: Range, reply: ipc.TidalEvalReply) {
  if (!reply.line) return undefined;
  const lines = code.split('\n');
  if (reply.line > lines.length) return undefined;
  let offset = 0;
  for (let i = 0; i < reply.line - 1; i++) offset += lines[i].length + 1;
  const column = Math.min((reply.column ?? 1) - 1, lines[reply.line - 1].length);
  return range.from + offset + column;
}
