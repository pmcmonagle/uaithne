import { javascript } from '@codemirror/lang-javascript';
import type { EditorState } from '@codemirror/state';
import { evalScope } from '@strudel/core';
import { getWidgetID, transpiler } from '@strudel/transpiler';
import {
  getAudioContext,
  getSampleInfo,
  initAudio,
  loadBuffer,
  registerSynthSounds,
  registerZZFXSounds,
  samples,
  soundMap,
  superdough,
  webaudioRepl,
} from '@strudel/webaudio';
import { registerSoundfonts } from '@strudel/soundfonts';
import { cleanupDraw, Drawer, getDrawContext, getPunchcardPainter, getTheme, setTheme } from '@strudel/draw';
import { highlightExtension, setMiniLocations, showMiniLocations } from '@strudel/codemirror/highlight.mjs';

import { sampleUrl, type Sound } from '$lib/ipc';
import { addLog, type LogLevel } from '$lib/log.svelte';
import { referenceHints } from '$lib/reference/hints';
import { lineOrSelection } from '../regions';
import type { Effects, EngineState, EvalResult, EvalScope, LanguageAdapter, Range } from '../types';
import { createAudioContext, installMasterGain, type Master } from './master';
import { installOutputs } from './outputs';
import { fitCanvas, installVisuals, visuals, VISUALS } from './visuals.svelte';
import { inlineVisuals, setWidgets } from './widgets';

/** Previews share a cut group, so a new one stops the last. */
const PREVIEW_CUT = 4242;
/** Cycles before and after now that the visuals panel shows. */
const DRAW_TIME: [number, number] = [-2, 2];

/** A visual for the panel: `.pianoroll(`, `scope(`, but not the inline `._pianoroll(`. */
const PANEL_VISUAL = new RegExp(`(^|[^\\w$])(${VISUALS.join('|')})\\s*\\(`);

/** Whether Strudel code asks for a visual in the panel, so the panel should open. */
export function usesVisuals(code: string) {
  return PANEL_VISUAL.test(code);
}

export class StrudelAdapter implements LanguageAdapter {
  readonly id = 'strudel' as const;
  readonly name = 'Strudel';
  readonly extensions = ['.strudel'];
  state = $state<EngineState>({ status: 'stopped', nowPlaying: null });

  private repl: any;
  private output: Master | null = null;
  private analyser: AnalyserNode | null = null;
  private gain = 1;
  private booted: Promise<void> | null = null;
  private audioReady: Promise<void> | null = null;
  private lastError: any = null;
  private lastMeta: any = null;
  /** Sample names registered from the library, to unregister ones that go away. */
  private sampleNames = new Set<string>();
  /** Where the playing code started in its document (non-zero for Shift+Enter evals). */
  private offset = 0;
  onFrame: ((effects: Effects) => void) | null = null;
  /** The visuals panel is open: draw a punchcard if the code asks for no visual. */
  private panelOpen = false;
  private punchcard = getPunchcardPainter({ labels: 0 });

  // Each animation frame while playing: outline the mini-notation behind
  // the events sounding right now, as strudel.cc does, and paint the
  // visuals. Painters (punchcard(), spiral(), …) bring their own canvas
  // (./visuals.svelte.ts), so the ctx passed here only matters to none.
  private drawer = new Drawer((haps: any[], time: number, _drawer: unknown, painters: any[]) => {
    const active = haps.filter((h) => h.isActive(time)).map((h) => this.shiftHap(h));
    this.onFrame?.([showMiniLocations.of({ atTime: time, haps: active })]);
    for (const paint of painters) paint(getDrawContext(), time, haps, DRAW_TIME);
    if (this.panelOpen && !visuals.lanes.length) {
      const ctx = getDrawContext();
      fitCanvas(ctx.canvas);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      this.punchcard(ctx, time, haps, DRAW_TIME);
    }
  }, [0, 0]);

  /** The app tells the engine when the visuals panel opens or closes. */
  setVisualsPanel(open: boolean) {
    this.panelOpen = open;
    if (!open) {
      const ctx = getDrawContext();
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
    this.updateDrawTime();
  }

  /** Draw colours from Uaithne's theme (call when the panel opens or the theme changes). */
  syncDrawTheme() {
    const css = getComputedStyle(document.documentElement);
    const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    setTheme({ ...getTheme(), foreground: color('--accent', '#75baff'), background: color('--bg', '#222') });
  }

  /** Highlighting needs only now; painting needs cycles either side. */
  private updateDrawTime() {
    const painters = this.repl?.scheduler?.pattern?.getPainters?.().length ?? 0;
    const wide = painters > 0 || (this.panelOpen && !visuals.lanes.length);
    this.drawer.setDrawTime(wide ? DRAW_TIME : [0, 0]);
    if (this.repl?.scheduler?.started) this.drawer.invalidate(this.repl.scheduler);
  }

  editorExtensions() {
    return [javascript(), highlightExtension, inlineVisuals, referenceHints('strudel')];
  }

  /** Every sound Strudel can play now: samples, synths and soundfonts. */
  soundNames(): string[] {
    return Object.keys(soundMap.get() ?? {});
  }

  clearHighlights(): Effects {
    return [setMiniLocations.of([]), showMiniLocations.of({ atTime: 0, haps: [] }), setWidgets.of([])];
  }

  /** Hap source locations are relative to the evaluated code; make them document-relative. */
  private shiftHap(hap: any) {
    const locations = hap.context?.locations;
    if (!this.offset || !locations) return hap;
    return {
      whole: hap.whole,
      value: hap.value,
      context: {
        ...hap.context,
        locations: locations.map((l: { start: number; end: number }) => ({
          start: l.start + this.offset,
          end: l.end + this.offset,
        })),
      },
    };
  }

  regionFor(state: EditorState, scope: EvalScope): Range {
    // Strudel replaces the whole pattern on each eval, so "main" is the buffer.
    return scope === 'main' ? { from: 0, to: state.doc.length } : lineOrSelection(state);
  }

  boot() {
    this.booted ??= this.doBoot();
    return this.booted;
  }

  private async doBoot() {
    this.state.status = 'booting';
    document.addEventListener('strudel.log', (e) => {
      const { message, type } = (e as CustomEvent).detail;
      // superdough logs this for its own internals every few notes.
      if (String(message).includes('Deprecation warning')) return;
      // Runtime errors (e.g. "sound x not found") arrive untyped as "[origin] error: …".
      const isError = type === 'error' || /^\[\w+\] error:/.test(String(message));
      const level: LogLevel = isError ? 'error' : type === 'warning' ? 'warning' : 'info';
      addLog('strudel', message, level);
    });
    try {
      // Before anything calls getAudioContext(), so ours is the shared one.
      createAudioContext();
      await evalScope(
        import('@strudel/core'),
        import('@strudel/mini'),
        import('@strudel/tonal'),
        import('@strudel/webaudio'),
        import('@strudel/soundfonts'),
      );
      await Promise.all([registerSynthSounds(), registerZZFXSounds(), registerSoundfonts()]);
      installOutputs();
      installVisuals();
      this.repl = webaudioRepl({
        transpiler,
        onEvalError: (err: unknown) => (this.lastError = err),
        afterEval: ({ meta }: { meta: any }) => (this.lastMeta = meta),
        onToggle: (started: boolean) => {
          this.state.status = started ? 'playing' : 'ready';
          if (started) {
            this.drawer.start(this.repl.scheduler);
          } else {
            this.drawer.stop();
            cleanupDraw(true);
            this.onFrame?.([showMiniLocations.of({ atTime: 0, haps: [] })]);
          }
        },
      });
      this.state.status = 'ready';
    } catch (err) {
      this.state.status = 'error';
      addLog('strudel', `boot failed: ${err}`, 'error');
      throw err;
    }
  }

  unlockAudio() {
    // resume() has to start inside the gesture; the rest can follow.
    const resumed = getAudioContext().resume();
    this.audioReady ??= this.startAudio(resumed).catch((err: unknown) => {
      this.audioReady = null; // retry on the next gesture
      addLog('strudel', `audio init failed: ${err}`, 'error');
    });
  }

  /** Builds superdough's output only once the context runs: WebKitGTK reports 0 channels before that. */
  private async startAudio(resumed: Promise<void>) {
    await this.boot();
    await resumed;
    const ctx = getAudioContext();
    const dest = ctx.destination;
    addLog(
      'strudel',
      `audio: ${ctx.state}, ${ctx.sampleRate} Hz, base latency ${Math.round((ctx.baseLatency ?? 0) * 1000)} ms, ` +
        `destination channels ${dest.channelCount}/${dest.maxChannelCount}`,
    );
    this.output ??= installMasterGain(ctx);
    this.output.gain.gain.value = this.gain;
    await initAudio();
  }

  async evaluate(code: string, range: Range): Promise<EvalResult> {
    await this.boot();
    if (!this.audioReady) this.unlockAudio();
    await this.audioReady;
    this.lastError = null;
    this.lastMeta = null;
    // Stops the last code's own drawing (pianoroll() etc.) and clears the canvas.
    cleanupDraw(true);
    visuals.beginEvaluation();
    await this.repl.evaluate(code);
    const err = this.lastError;
    visuals.endEvaluation(!err);
    if (!err) {
      this.offset = range.from;
      this.updateDrawTime();
      this.drawer.invalidate(this.repl.scheduler);
      const locations: [number, number][] = this.lastMeta?.miniLocations ?? [];
      const shifted = locations.map(([from, to]) => [from + range.from, to + range.from]);
      const widgets = (this.lastMeta?.widgets ?? []).map((w: any) => ({ to: w.to + range.from, id: getWidgetID(w) }));
      return { ok: true, effects: [setMiniLocations.of(shifted), setWidgets.of(widgets)] };
    }
    // acorn syntax errors carry an offset into the evaluated code.
    const pos = typeof err.pos === 'number' ? range.from + err.pos : undefined;
    let message: string = err.message ?? String(err);
    // The transpiler's wording when the region holds only comments or blank lines.
    if (message.includes('without body expression')) message = 'Nothing to evaluate here: only comments or blank lines.';
    return { ok: false, error: { message, pos } };
  }

  async loadSamples(sounds: Sound[]) {
    await this.boot();
    const map: Record<string, string[] | Record<string, string[]>> = {};
    for (const sound of sounds) {
      if (sound.shadowed) continue;
      const urls = sound.files.map((f) => sampleUrl(f, sound.stamp));
      map[sound.name] = sound.notes
        ? Object.fromEntries(Object.entries(sound.notes).map(([note, idx]) => [note, idx.map((i) => urls[i])]))
        : urls;
    }
    for (const name of this.sampleNames) {
      if (!(name in map)) soundMap.setKey(name, undefined);
    }
    this.sampleNames = new Set(Object.keys(map));
    await samples(map, '');
  }

  async preview(sound: string, n: number) {
    if (!this.audioReady) this.unlockAudio();
    await this.audioReady;
    const ctx = getAudioContext();
    const value = { s: sound, n, cut: PREVIEW_CUT };
    // Load first: superdough drops a sample that isn't ready by its start time.
    const bank = soundMap.get()[sound]?.data?.samples;
    if (bank) await loadBuffer(getSampleInfo(value, bank).url, ctx, sound, n);
    await superdough(value, ctx.currentTime + 0.03, 0.25);
  }

  /** Strudel's audio before the volume control, for recording; null until audio has started. */
  recordingSource(): GainNode | null {
    return this.output?.input ?? null;
  }

  /** RMS level after the master gain (0..1), or null before audio starts. Used by the self-test. */
  outputLevel(): number | null {
    if (!this.output) return null;
    if (!this.analyser) {
      this.analyser = this.output.gain.context.createAnalyser();
      this.output.gain.connect(this.analyser);
    }
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    return Math.sqrt(buf.reduce((sum, x) => sum + x * x, 0) / buf.length);
  }

  async hush() {
    this.repl?.stop();
  }

  setVolume(gain: number) {
    this.gain = gain;
    if (this.output) {
      const { gain: node } = this.output;
      node.gain.setTargetAtTime(gain, node.context.currentTime, 0.02);
    }
  }

  async dispose() {
    this.repl?.stop();
  }
}
