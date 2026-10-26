// Top-level controller: workspace, editor, engines, volume and shortcuts.

import { adapterFor, adapters, trackExtensions } from '$lib/adapters';
import { usesVisuals, type StrudelAdapter } from '$lib/adapters/strudel/index.svelte';
import { visuals } from '$lib/adapters/strudel/visuals.svelte';
import { setWidgets } from '$lib/adapters/strudel/widgets';
import { activeRanges, patternIds } from '$lib/adapters/tidal/highlight';
import type { TidalAdapter } from '$lib/adapters/tidal/index.svelte';
import type { Effects, EvalScope, LanguageAdapter, LanguageId } from '$lib/adapters/types';
import { Tap } from '$lib/audio/recorder';
import { taper } from '$lib/audio/volume';
import { Editor } from '$lib/editor/editor';
import { applyVimMappings, defineExCommands } from '$lib/editor/vim';
import * as ipc from '$lib/ipc';
import { keymap, type CommandId } from '$lib/keys.svelte';
import { LAYOUT_DEFAULTS, loadLayout, saveLayout } from '$lib/layout';
import { addLog } from '$lib/log.svelte';
import { callAt, setSoundNames } from '$lib/reference/hints';
import { loadReference, ReferencePanel } from '$lib/reference/index.svelte';
import { entryHtml } from '$lib/reference/markdown';
import { SampleLibrary } from '$lib/samples/library.svelte';
import { applyTheme, THEMES } from '$lib/themes';
import { TrackStore } from '$lib/tracks/store.svelte';
import { CompletionContext, type CompletionSource } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { getCM, Vim } from '@replit/codemirror-vim';
import { tick, untrack } from 'svelte';

export interface PromptRequest {
  title: string;
  /** Present for text input; absent for a yes/no confirmation. */
  initial?: string;
  resolve: (value: string | null) => void;
}

const VOLUME_STEP = 0.05;
/** What an engine is "playing" after a reference example is tried; not a track. */
const REFERENCE_PATH = '(reference)';
/** Tidal lines that run as they are; anything else is a pattern to play on d1. */
const TIDAL_STATEMENT =
  /^\s*(d\d+\b|p\s|once|asap|first|hush|panic|setcps|resetCycles|setCycle|xfade|jump|clutch|interpolate|anticipate|histpan|wait|mortal|solo|unsolo|mute|unmute|all\b|only|let\b|import\b|:)/;

class App {
  workspace = $state<ipc.WorkspaceInfo | null>(null);
  /** Moving to another workspace: the workbench is unmounted meanwhile. */
  switching = $state(false);
  tracks = new TrackStore();
  samples = new SampleLibrary();
  editor: Editor | null = null;
  vimMode = $state('normal');
  volume = $state(0.8);
  muted = $state(false);
  quickSwitcherOpen = $state(false);
  consoleOpen = $state(false);
  tidalOpen = $state(false);
  reference = new ReferencePanel();
  helpOpen = $state(false);
  settingsOpen = $state(false);
  settings = $state<ipc.Settings | null>(null);
  visualsOpen = $state(false);
  /** The recording in progress: when it began and the files it's writing. */
  recording = $state<{ since: number; files: string[] } | null>(null);
  private tap: Tap | null = null;
  /** The visuals panel before the self-test opened it. */
  private visualsWereOpen = false;
  visualsHeight = $state(LAYOUT_DEFAULTS.visualsHeight);
  sidebarWidth = $state(LAYOUT_DEFAULTS.sidebarWidth);
  referenceWidth = $state(LAYOUT_DEFAULTS.referenceWidth);
  consoleHeight = $state(LAYOUT_DEFAULTS.consoleHeight);
  consoleTab = $state(LAYOUT_DEFAULTS.consoleTab);
  /** The reference example last tried: which block, and for Tidal the pattern ids it plays. */
  trying = $state<{ key: string; language: LanguageId; ids: string[] } | null>(null);
  prompt = $state<PromptRequest | null>(null);

  private volumeSaveTimer: ReturnType<typeof setTimeout> | undefined;

  get activeAdapter(): LanguageAdapter | undefined {
    return this.tracks.active ? adapterFor(this.tracks.active) : undefined;
  }

  async init() {
    applyTheme('auto', null, () => {}); // until the settings arrive
    const settings = await ipc.getSettings();
    this.settings = settings;
    keymap.load(settings.keybindings);
    await this.reloadTheme();
    this.volume = settings.volume;
    this.muted = settings.muted;
    this.applyVolume();
    defineExCommands(this);
    this.restoreLayout();
    setSoundNames((language) => {
      const library = this.samples.sounds.filter((s) => !s.shadowed).map((s) => s.name);
      const strudel = adapters.find((a) => a.id === 'strudel') as StrudelAdapter;
      return language === 'strudel' ? [...library, ...strudel.soundNames()] : library;
    });
    void ipc.onTracksChanged((paths) => this.tracks.onDiskChange(paths));
    void ipc.onEngineLog((line) => addLog(line.source, line.message, line.level));
    // Opening a track gives its engine a chance to start (Tidal's processes).
    $effect.root(() => {
      $effect(() => {
        const adapter = this.activeAdapter;
        untrack(() => adapter?.activate?.());
      });
    });
    for (const adapter of adapters) {
      adapter.boot().catch(() => {}); // failures are logged by the adapter
      if (adapter.onFrame !== undefined) {
        adapter.onFrame = (effects, path = adapter.state.nowPlaying ?? undefined) => {
          if (path) this.tracks.applyEffects(path, effects);
        };
      }
    }
    if (settings.workspace) {
      await this.openWorkspace(settings.workspace).catch((err) =>
        addLog('uaithne', `Couldn't open ${settings.workspace}: ${err}`, 'error'),
      );
    }
  }

  async openWorkspace(root: string) {
    this.workspace = await ipc.openWorkspace(root);
    await this.tracks.refresh();
    void this.samples.init().catch((err) => addLog('samples', String(err), 'error'));
  }

  /**
   * Moves to another workspace folder. The workbench is unmounted first, so
   * open tracks are saved (and the session remembered) in the old folder
   * before the backend lets go of it; Tidal restarts on the new one.
   */
  async switchWorkspace(root: string) {
    if (root === this.workspace?.root) return;
    this.settingsOpen = false;
    this.switching = true;
    await tick();
    await this.tracks.saveAll();
    this.hush(true);
    await this.stopRecording();
    const tidal = adapters.find((a) => a.id === 'tidal') as TidalAdapter;
    const tidalWasUp = !['stopped', 'error', 'unavailable'].includes(tidal.state.status);
    if (tidalWasUp) await tidal.stop();
    this.tracks.reset();
    try {
      await this.openWorkspace(root);
      if (this.settings) this.settings.workspace = root;
      addLog('uaithne', `Opened workspace ${root}`);
    } catch (err) {
      addLog('uaithne', `Couldn't open ${root}: ${err}`, 'error');
      await this.tracks.refresh();
    } finally {
      this.switching = false;
    }
    if (tidalWasUp) void tidal.start();
  }

  /** Called once the editor's container exists (after a workspace opens). */
  async mountEditor(parent: HTMLElement) {
    const config = this.workspace!.config.editor;
    this.editor = new Editor(
      parent,
      {
        onDocChanged: () => this.tracks.markDirty(),
        onVimMode: (mode) => (this.vimMode = mode),
      },
      { vim: config.vim, fontSize: config.font_size },
    );
    for (const problem of applyVimMappings(config.vim_mappings ?? [], config.leader ?? '\\')) {
      addLog('uaithne', `uaithne.toml vim_mappings: ${problem}`, 'warning');
    }
    this.tracks.attach(this.editor);
    await this.restoreSession();
    if (await ipc.selftestEnabled()) void this.selfTest();
  }

  /**
   * Dev aid (UAITHNE_SELFTEST=1): plays the first Strudel track for a few
   * seconds and logs the output level, so a run can be checked from the
   * terminal. Plays audibly at the current volume.
   */
  private async selfTest() {
    // Once per page: a hot-swapped app module would otherwise start a second
    // run alongside the first, and the two trip over each other.
    const w = window as { uaithneSelfTested?: boolean };
    if (w.uaithneSelfTested) return;
    w.uaithneSelfTested = true;
    this.selfTestThemes();
    this.selfTestKeys();
    await this.selfTestReference();
    await this.selfTestStrudel();
    if (await ipc.selftestTidal()) await this.selfTestTidal();
    addLog('selftest', 'done');
  }

  /**
   * Self-test, reference: both indexes load and every entry renders; search
   * finds by name; completion offers functions, and sample names in strings.
   */
  private async selfTestReference() {
    const cases: Record<LanguageId, { search: string; code: string; inString: string; calls: [string, string][] }> = {
      strudel: {
        search: 'jux',
        code: 's("bd").ju',
        inString: 's("b',
        calls: [
          ['s("bd").lpf(', 'lpf:0'],
          ['note("c e").euclid(3, ', 'euclid:1'],
          ['s("bd").every(2, x => x.fast(', 'fast:0'],
        ],
      },
      tidal: {
        search: 'jux',
        code: 'd1 $ ju',
        inString: 'd1 $ s "b',
        calls: [
          ['d1 $ every 3 ', 'every:1'],
          ['d1 $ every 3 (fast ', 'fast:0'],
          ['d1 $ s "bd" # speed ', 'speed:0'],
          ['d1 $ sometimesBy 0.3 (# crush 4) $ n "0 .. 7" # s "arpy" # room ', 'room:0'],
        ],
      },
    };
    for (const adapter of adapters) {
      const started = performance.now();
      const ref = await loadReference(adapter.id);
      let blocks = 0;
      let failed = 0;
      for (const entry of ref.entries) {
        try {
          blocks += entryHtml(entry).code.length;
        } catch {
          failed++;
        }
      }
      const ms = (performance.now() - started).toFixed(0);
      const { search, code, inString } = cases[adapter.id];
      const top = ref.search(search).slice(0, 3).map((e) => e.name);
      const complete = async (doc: string) => {
        const state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: adapter.editorExtensions() });
        const options: string[] = [];
        for (const source of state.languageDataAt<CompletionSource>('autocomplete', doc.length)) {
          if (typeof source !== 'function') continue;
          const result = await source(new CompletionContext(state, doc.length, false));
          const typed = result ? state.sliceDoc(result.from, doc.length) : '';
          for (const o of result?.options ?? []) if (o.label.startsWith(typed)) options.push(o.label);
        }
        return options;
      };
      const functions = await complete(code);
      const sounds = await complete(inString);
      const calls = cases[adapter.id].calls.map(([doc, want]) => {
        const state = EditorState.create({ doc, selection: { anchor: doc.length } });
        const call = callAt(state, adapter.id);
        const got = call ? `${call.entry.name}:${call.arg}` : 'none';
        return got === want ? got : `${got}≠${want}`;
      });
      const callsOk = calls.every((c) => !c.includes('≠'));
      addLog(
        'selftest',
        `reference ${adapter.id}: ${ref.entries.length} entries, ${blocks} code blocks, ${failed} failed to render, ${ms}ms; ` +
          `search "${search}" → ${top.join(', ')}; complete "${code}" → ${functions.slice(0, 4).join(', ')}; ` +
          `in string "${inString}" → ${sounds.length} sounds (${sounds.slice(0, 3).join(', ')}); signature hints ${calls.join(' ')}`,
        failed || !functions.length || !sounds.length || !callsOk ? 'error' : 'info',
      );
    }
  }

  private async selfTestStrudel() {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const strudel = adapters.find((a) => a.id === 'strudel') as StrudelAdapter;
    const track = this.tracks.tracks.find((t) => adapterFor(t) === strudel);
    if (!track) return addLog('selftest', 'no .strudel track to play', 'error');
    await this.tracks.switchTo(track);
    await sleep(1500);
    addLog('selftest', `playing ${track} at volume ${this.muted ? 'muted' : this.volume}`);
    if (!this.editor?.state.doc.length) return addLog('selftest', `${track} is empty; nothing to play`, 'warning');
    this.visualsWereOpen = this.visualsOpen;
    this.toggleVisuals(true);
    await this.evaluate('main');
    for (let i = 1; i <= 8; i++) {
      await sleep(500);
      const level = strudel.outputLevel();
      const lit = this.editor?.view.dom.querySelectorAll('.cm-content [style*="outline"]').length ?? 0;
      addLog('selftest', `t+${i * 0.5}s status=${strudel.state.status} rms=${level?.toFixed(4) ?? 'n/a'} highlighted=${lit}`);
    }
    const shownBy = visuals.lanes.length
      ? visuals.lanes.map((l) => `${l.kind} lane ${paintedShare(l.canvas)}%`).join(', ')
      : `punchcard ${paintedShare()}%`;
    addLog('selftest', `visuals of ${track}: ${shownBy}`);
    this.hush(true);
    await this.selfTestSamples(strudel);
  }

  /**
   * Self-test, Tidal (UAITHNE_SELFTEST_TIDAL=1): start GHCi and SuperDirt, play
   * a sample pattern and meter SuperCollider's output, then check that an
   * error maps back to its line.
   */
  /** Checks shortcuts run, can be rebound and taken, and that vim mappings with <leader> work. */
  private selfTestKeys() {
    const saved = keymap.overrides;
    const press = (keys: string) => {
      const parts = keys.split('+');
      const key = parts.pop()!;
      const code = /^[A-Z]$/.test(key) ? `Key${key}` : key;
      const e = new KeyboardEvent('keydown', {
        cancelable: true,
        key: key.toLowerCase(),
        code,
        ctrlKey: parts.includes('Ctrl'),
        altKey: parts.includes('Alt'),
        shiftKey: parts.includes('Shift'),
      });
      this.onKeydown(e);
      return e.defaultPrevented;
    };
    const wasOpen = this.reference.open;
    const checks: string[] = [];
    const check = (name: string, ok: boolean) => checks.push(`${name}=${ok ? 'ok' : 'WRONG'}`);
    check('default', press('Ctrl+K') && this.reference.open !== wasOpen);
    press('Ctrl+K');
    keymap.bind('reference', 'Ctrl+Alt+K');
    check('rebound', !press('Ctrl+K') && press('Ctrl+Alt+K') && this.reference.open !== wasOpen);
    press('Ctrl+Alt+K');
    keymap.bind('visuals', 'Ctrl+Alt+K');
    check('taken', keymap.keysFor('reference').length === 0 && keymap.keysFor('visuals')[0] === 'Ctrl+Alt+K');
    keymap.reset('reference');
    keymap.reset('visuals');
    check('reset', keymap.hint('reference') === 'Ctrl+K' && keymap.hint('visuals') === 'Ctrl+J' && !Object.keys(keymap.overrides).length);
    keymap.overrides = saved;
    this.reference.open = wasOpen;

    const cm = this.editor && getCM(this.editor.view);
    if (cm) {
      // The default leader, so the test doesn't take a key's meaning away.
      const problems = applyVimMappings(['nnoremap <leader>q :keys<CR>', 'bogus'], '\\');
      Vim.handleKey(cm, '<Esc>', 'user');
      Vim.handleKey(cm, '\\', 'user');
      Vim.handleKey(cm, 'q', 'user');
      check('vim-leader', this.helpOpen && problems.length === 1);
      this.helpOpen = false;
      const config = this.workspace!.config.editor;
      applyVimMappings(config.vim_mappings ?? [], config.leader ?? '\\');
    }
    addLog('selftest', `keys: ${checks.join(' ')}`, checks.every((c) => c.endsWith('=ok')) ? 'info' : 'error');
  }

  /** Applies each theme and checks the page and the editor take its colours. */
  private selfTestThemes() {
    const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
    const results = THEMES.map((theme) => {
      applyTheme(theme.id, null, () => {});
      const body = getComputedStyle(document.body);
      const editor = document.querySelector('.cm-editor');
      // Strings in the open track are drawn in the theme's string colour.
      const spans = [...document.querySelectorAll('.cm-content span')];
      const strings = spans.some((span) => getComputedStyle(span).color === rgb(theme.palette.string));
      const ok =
        body.backgroundColor === rgb(theme.palette.bg) &&
        body.color === rgb(theme.palette.fg) &&
        (!editor || (getComputedStyle(editor).backgroundColor === rgb(theme.palette.bg) && strings));
      return `${theme.id}=${ok ? 'ok' : `WRONG(body ${body.backgroundColor}, editor ${editor && getComputedStyle(editor).backgroundColor}, strings ${strings})`}`;
    });
    void this.reloadTheme();
    const ok = results.every((r) => r.endsWith('=ok'));
    addLog('selftest', `themes: ${results.join(' ')}`, ok ? 'info' : 'error');
  }

  /** Kills each process in turn while `code` plays, and checks it comes back playing. */
  private async selfTestRecovery(tidal: TidalAdapter, code: string) {
    const until = async (done: () => boolean, ms: number) => {
      for (const end = Date.now() + ms; !done() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
      return done();
    };
    await tidal.evaluate(code, { from: 0, to: code.length }, '');
    for (const which of ['ghci', 'sclang', 'scsynth'] as const) {
      const started = Date.now();
      try {
        await ipc.selftestCrash(which);
      } catch (err) {
        addLog('selftest', `recovery ${which}: ${err}`, 'error');
        continue;
      }
      const noticed = await until(() => !tidal.running, 5000);
      const back = noticed && (await until(() => tidal.running, 90_000));
      await new Promise((r) => setTimeout(r, 1500)); // replay, and SuperDirt's first events
      const peak = back ? await ipc.tidalMeter(1.5).catch((err) => `meter failed: ${err}`) : 'n/a';
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      addLog('selftest', `recovery ${which}: ${back ? 'ok' : noticed ? 'not back' : 'crash not noticed'} after ${seconds}s, status=${tidal.state.status} peak=${peak}`, back ? 'info' : 'error');
    }
  }

  private async selfTestTidal() {
    const tidal = adapters.find((a) => a.id === 'tidal') as TidalAdapter;
    const started = Date.now();
    try {
      await tidal.ensureRunning();
    } catch (err) {
      return addLog('selftest', `tidal: ${err}`, 'error');
    }
    addLog('selftest', `tidal ready after ${((Date.now() - started) / 1000).toFixed(1)}s; audio output=${tidal.procs.output ?? 'not linked'}`);
    const sound = this.samples.sounds.find((s) => !s.shadowed && s.name === 'bd') ?? this.samples.sounds.find((s) => !s.shadowed);
    const code = `d1 $ s "${sound?.name ?? 'superpiano'}*4"`;
    const played = await tidal.evaluate(code, { from: 0, to: code.length }, '');
    const level = await ipc.tidalMeter(2).catch((err) => `meter failed: ${err}`);
    addLog('selftest', `tidal ${code}: ok=${played.ok} peak=${level}${played.ok ? '' : ' ' + played.error.message}`);
    const bad = 'd1 $ s "bd"\n  # speed nope';
    const failed = await tidal.evaluate(bad, { from: 100, to: 100 + bad.length }, '');
    const where = failed.ok ? 'n/a' : failed.error.pos;
    addLog('selftest', `tidal error check: ok=${failed.ok} pos=${where} (expect ${100 + bad.indexOf('nope')})`);
    await this.selfTestTidalHighlight(tidal);
    await this.selfTestTryStop(tidal);
    await this.selfTestRecording();
    await this.selfTestOutputs(tidal);
    await this.selfTestRecovery(tidal, code);
    await tidal.hush();
    await new Promise((r) => setTimeout(r, 1000)); // let scheduled events and tails finish
    const quiet = await ipc.tidalMeter(1).catch((err) => `meter failed: ${err}`);
    addLog('selftest', `tidal after hush: status=${tidal.state.status} peak=${quiet}`);
  }

  /**
   * Self-test, MIDI and OSC out, against the system's Midi Through port:
   * Strudel's .midi() and Tidal's s "midi" should arrive on its input side,
   * and Strudel's .osc() should play through SuperDirt.
   */
  private async selfTestOutputs(tidal: TidalAdapter) {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const strudel = adapters.find((a) => a.id === 'strudel') as StrudelAdapter;
    const through = (await ipc.midiOutputs().catch(() => [])).find((p) => p.includes('Midi Through'));
    if (!through) {
      addLog('selftest', 'midi: no Midi Through port, skipped', 'warning');
    } else {
      await tidal.hush();
      const capture = ipc.selftestMidiCapture('Midi Through', 1500);
      await sleep(200);
      const code = 'note("c4 e4").midichan(2).midi("Midi Through")';
      const played = await strudel.evaluate(code, { from: 0, to: code.length });
      const seen = await capture.catch((err) => [`failed: ${err}`]);
      await strudel.hush();
      // Note on, channel 2 (0x91), C4 = 60 = 0x3c and E4 = 64 = 0x40.
      const ok = played.ok && seen.some((m) => m.startsWith('91 3c')) && seen.some((m) => m.startsWith('81 3c'));
      addLog('selftest', `midi strudel: ${ok ? 'ok' : 'WRONG'} ${seen.slice(0, 6).join(', ')} (${seen.length} messages)`, ok ? 'info' : 'error');

      await ipc.selftestTidalMidi(through);
      // A cycle is ~1.8 s at Tidal's default tempo; listen for longer.
      const tidalCapture = ipc.selftestMidiCapture('Midi Through', 3000);
      await sleep(200);
      await ipc.tidalEval('d1 $ n "0 7" # s "midi"');
      const tidalSeen = await tidalCapture.catch((err) => [`failed: ${err}`]);
      await tidal.hush();
      await ipc.selftestTidalMidi(this.settings?.tidalMidiOutput ?? '');
      // n "0 7" on channel 1: C4 (0x3c) and G4 (0x43), velocity from SuperDirt's amp.
      const tidalOk = tidalSeen.some((m) => /^90 (3c|43)/.test(m));
      addLog(
        'selftest',
        `midi tidal: ${tidalOk ? 'ok' : 'WRONG'} ${tidalSeen.slice(0, 6).join(', ')} (${tidalSeen.length} messages)`,
        tidalOk ? 'info' : 'error',
      );
    }
    const oscCode = 's("bd*4").osc()';
    const sent = await strudel.evaluate(oscCode, { from: 0, to: oscCode.length });
    await sleep(300);
    const peak = await ipc.tidalMeter(1.5).catch(() => 0);
    await strudel.hush();
    const oscOk = sent.ok && Number(peak) > 0.01;
    addLog('selftest', `osc strudel → SuperDirt: ${oscOk ? 'ok' : 'WRONG'} SC peak=${peak}`, oscOk ? 'info' : 'error');
  }

  /**
   * Self-test, recording: with Strudel and Tidal both playing and the volume
   * muted, record 3 s. Both stems should be ~3 s long and not silent (the
   * recording is taken before the volume control). The files are deleted.
   */
  private async selfTestRecording() {
    const strudel = adapters.find((a) => a.id === 'strudel') as StrudelAdapter;
    await ipc.tidalEval('d1 $ s "hh*8"');
    await strudel.evaluate('s("bd*4")', { from: 0, to: 9 });
    // Silence the engines without touching the saved volume (a reload
    // mid-test would otherwise leave the app muted).
    for (const adapter of adapters) adapter.setVolume(0);
    await this.toggleRecording();
    const files = this.recording?.files ?? [];
    await new Promise((r) => setTimeout(r, 3000));
    await this.stopRecording();
    this.applyVolume();
    await strudel.hush();
    await new Promise((r) => setTimeout(r, 800)); // SuperCollider closes its file
    for (const file of files) {
      const stats = await ipc.selftestWav(file).catch((err) => `failed: ${err}`);
      const [, seconds, peak] = stats.match(/([\d.]+)s peak=([\d.]+)/) ?? [];
      const ok = stats.startsWith('2ch') && Number(seconds) > 2.5 && Number(seconds) < 3.6 && Number(peak) > 0.01;
      addLog('selftest', `recording ${relative(file)}: ${stats}${ok ? '' : ' WRONG'}`, ok ? 'info' : 'error');
    }
    if (files.length !== 2) addLog('selftest', `recording: expected two stems, got ${files.length}`, 'error');
  }

  /**
   * Self-test, reference Try/Stop in Tidal: with d2 playing (as from a track),
   * try a bare pattern (it plays on d1), then Stop: d1 goes, d2 keeps playing.
   */
  private async selfTestTryStop(tidal: TidalAdapter) {
    const key = 'tidal:selftest#0';
    // Alone, Stop silences it.
    await tidal.hush();
    await this.tryCode('s "bd*4"', 'tidal', key);
    await this.stopTry();
    await new Promise((r) => setTimeout(r, 1000));
    const alone = await ipc.tidalMeter(1).catch(() => 1);
    // With a track's d2 playing, Stop leaves d2 alone.
    await ipc.tidalEval('d2 $ s "hh*8" # gain 0.8');
    const error = await this.tryCode('s "bd*4"', 'tidal', key);
    const playing = this.tryPlaying;
    await this.stopTry();
    await new Promise((r) => setTimeout(r, 1000));
    const after = this.tryPlaying;
    const d2 = await ipc.tidalMeter(1).catch(() => 0);
    const ok = !error && playing === key && after === null && Number(alone) < 0.01 && Number(d2) > 0.01;
    addLog(
      'selftest',
      `tidal try/stop: ${ok ? 'ok' : 'WRONG'} error=${error ?? 'none'} playing=${playing} after stop=${after} ` +
        `alone after stop peak=${alone}; with d2, d2 still sounding peak=${d2}`,
      ok ? 'info' : 'error',
    );
  }

  /**
   * Self-test, Tidal highlighting: evaluates into a scratch editor state (no
   * track is touched), inserts a line above after evaluating, and logs which
   * text lit up, which should be the mini-notation words.
   */
  private async selfTestTidalHighlight(tidal: TidalAdapter) {
    const code = 'd1 $ s "bd*2 [sn hh]"\n  # n "<0 3>"';
    let state = EditorState.create({ doc: code, extensions: tidal.editorExtensions() });
    const appFrame = tidal.onFrame;
    const lit = new Map<string, number>();
    tidal.onFrame = (effects, path) => {
      if (path !== '\0selftest') return appFrame?.(effects, path);
      state = state.update({ effects }).state;
      for (const { from, to } of activeRanges(state)) {
        const text = state.sliceDoc(from, to);
        lit.set(text, (lit.get(text) ?? 0) + 1);
      }
    };
    try {
      const result = await tidal.evaluate(code, { from: 0, to: code.length }, '\0selftest');
      if (!result.ok) return addLog('selftest', `tidal highlight: eval failed: ${result.error.message}`, 'error');
      state = state.update({ effects: result.effects }).state;
      state = state.update({ changes: { from: 0, insert: '-- moved down a line\n' } }).state;
      await new Promise((r) => setTimeout(r, 2500));
    } finally {
      tidal.onFrame = appFrame;
    }
    const words = [...lit.keys()].sort();
    // The 2 of bd*2 is a pattern too, so Tidal reports it.
    const expected = ['0', '2', '3', 'bd', 'hh', 'sn'];
    const ok = expected.every((w) => lit.has(w)) && words.every((w) => expected.includes(w));
    addLog('selftest', `tidal highlight: ${ok ? 'ok' : 'WRONG'} lit=${words.map((w) => `${w}(${lit.get(w)})`).join(' ')}`, ok ? 'info' : 'error');
  }

  /** Self-test, continued: optionally install a pack, then preview and play a sample. */
  private async selfTestSamples(strudel: StrudelAdapter) {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const pack = await ipc.selftestPack();
    const entry = pack && this.samples.catalogue.find((c) => c.id === pack);
    if (entry && !this.samples.installed(entry.id)) {
      const started = Date.now();
      const ticker = setInterval(() => {
        const p = this.samples.progress[entry.id];
        if (p) addLog('selftest', `downloading ${entry.id}: ${p.done}/${p.total} failed=${p.failed}`);
      }, 1000);
      await this.samples.install(entry.id, entry.name, entry.source);
      clearInterval(ticker);
      addLog('selftest', `install took ${((Date.now() - started) / 1000).toFixed(1)}s; error=${this.samples.errors[entry.id] ?? 'none'}`);
    }
    // An all-digit name like "808" reads as a number in mini-notation, so skip those.
    const playable = this.samples.sounds.filter((s) => !s.shadowed && !/^\d+$/.test(s.name));
    const sound =
      playable.find((s) => (!pack || s.origin === pack) && s.name === 'bd') ??
      playable.find((s) => s.name === 'bd') ??
      playable[0];
    if (!sound) return addLog('selftest', 'no samples to test');
    const peak = async (ms: number) => {
      let max = 0;
      for (let t = 0; t < ms; t += 50) {
        await sleep(50);
        max = Math.max(max, strudel.outputLevel() ?? 0);
      }
      return max.toFixed(4);
    };
    await strudel.preview(sound.name, 0);
    addLog('selftest', `preview ${sound.origin}/${sound.name}:0 peak rms=${await peak(600)}`);
    const code = `s("${sound.name}*4")`;
    const result = await strudel.evaluate(code, { from: 0, to: code.length });
    addLog('selftest', `pattern ${code}: ok=${result.ok} peak rms=${await peak(2000)}`);
    // Two panel visuals (a lane each) and one inline one (a widget under its line).
    const visualCode = [
      '$: note("c3 e3 g3 b3").s("triangle").gain(0.2).pianoroll()',
      '$: s("bd*4").gain(0.3).punchcard()',
      '$: note("c4").s("sine").gain(0.05)._scope()',
    ].join('\n');
    const shown = await strudel.evaluate(visualCode, { from: 0, to: visualCode.length });
    await sleep(1200);
    const lanes = visuals.lanes.map((l) => `${l.kind} ${paintedShare(l.canvas)}%`).join(', ');
    const widgets = shown.ok ? (shown.effects ?? []).flatMap((e) => (e.is(setWidgets) ? e.value : [])) : [];
    const inline = widgets.map((w) => `${w.id} ${paintedShare(visuals.getInline(w.id))}%`).join(', ');
    // A lane with only its playhead line is ~0.3% painted; notes make it more.
    const drawn = visuals.lanes.every((l) => parseFloat(paintedShare(l.canvas)) > 1);
    const visualsOk = shown.ok && visuals.lanes.length === 2 && drawn && widgets.length === 1;
    addLog(
      'selftest',
      `visuals: ${visualsOk ? 'ok' : 'WRONG'} lanes: ${lanes || 'none'}; inline: ${inline || 'none'}`,
      visualsOk ? 'info' : 'error',
    );
    await strudel.hush();
    this.toggleVisuals(this.visualsWereOpen);
  }

  unmountEditor() {
    this.saveSession();
    this.tracks.detach();
    this.editor?.destroy();
    this.editor = null;
  }

  private restoreLayout() {
    const saved = loadLayout();
    this.sidebarWidth = saved.sidebarWidth;
    this.referenceWidth = saved.referenceWidth;
    this.consoleHeight = saved.consoleHeight;
    this.visualsHeight = saved.visualsHeight;
    this.consoleOpen = saved.consoleOpen;
    this.consoleTab = saved.consoleTab;
    this.reference.open = saved.referenceOpen;
    if (saved.visualsOpen) this.toggleVisuals(true);
    $effect.root(() => {
      $effect(() => {
        saveLayout({
          sidebarWidth: this.sidebarWidth,
          referenceWidth: this.referenceWidth,
          consoleHeight: this.consoleHeight,
          visualsHeight: this.visualsHeight,
          consoleOpen: this.consoleOpen,
          consoleTab: this.consoleTab,
          visualsOpen: this.visualsOpen,
          referenceOpen: this.reference.open,
        });
      });
    });
  }

  private sessionKey() {
    return `uaithne.session:${this.workspace?.root}`;
  }

  saveSession() {
    try {
      localStorage.setItem(
        this.sessionKey(),
        JSON.stringify({ open: this.tracks.open, active: this.tracks.active }),
      );
    } catch {}
  }

  private async restoreSession() {
    let session: { open: string[]; active: string | null } = { open: [], active: null };
    try {
      session = JSON.parse(localStorage.getItem(this.sessionKey()) ?? '') ?? session;
    } catch {}
    const exists = (p: string) => this.tracks.tracks.includes(p);
    const open = session.open.filter(exists);
    if (!open.length && this.tracks.tracks.length) open.push(this.tracks.tracks[0]);
    for (const path of open) await this.tracks.switchTo(path);
    if (session.active && exists(session.active)) await this.tracks.switchTo(session.active);
  }

  // ---- evaluation -------------------------------------------------------

  /** Must be called synchronously from the key handler (audio unlock). */
  async evaluate(scope: EvalScope) {
    const path = this.tracks.active;
    const adapter = this.activeAdapter;
    if (!path || !adapter || !this.editor) return;
    adapter.unlockAudio();
    const state = this.editor.state;
    const range = adapter.regionFor(state, scope);
    if (range.to <= range.from) return;
    this.editor.flash(range);
    void this.tracks.save(path);

    const code = state.sliceDoc(range.from, range.to);
    const result = await adapter.evaluate(code, range, path);
    const stillHere = this.tracks.active === path && this.editor;
    if (result.ok) {
      this.played(adapter, path, result.effects);
      if (adapter.id === 'strudel' && usesVisuals(code)) this.toggleVisuals(true);
      if (stillHere) this.editor!.clearErrors();
    } else {
      addLog(adapter.id, result.error.message, 'error');
      if (stillHere) this.editor!.showError(result.error.message, range, result.error.pos);
    }
  }

  /** `path` is now what `adapter` plays. */
  private played(adapter: LanguageAdapter, path: string, effects?: Effects) {
    const previous = adapter.state.nowPlaying;
    if (previous && previous !== path && adapter.clearHighlights) {
      this.tracks.applyEffects(previous, adapter.clearHighlights());
    }
    adapter.state.nowPlaying = path;
    if (effects) this.tracks.applyEffects(path, effects);
  }

  /** The language the reference panel shows: the active track's, else the last one. */
  get referenceLanguage(): LanguageId {
    const id = this.activeAdapter?.id;
    if (id) this.lastLanguage = id;
    return id ?? this.lastLanguage;
  }
  private lastLanguage: LanguageId = 'strudel';

  /**
   * Plays a reference example in its language's engine. Call from the click
   * (audio unlock). Returns an error message, if any.
   */
  async tryCode(code: string, language: LanguageId, key: string): Promise<string | null> {
    const adapter = adapters.find((a) => a.id === language);
    if (!adapter) return null;
    adapter.unlockAudio();
    const run = language === 'tidal' && !TIDAL_STATEMENT.test(code) ? `d1 $ ${code}` : code;
    const result = await adapter.evaluate(run, { from: 0, to: run.length }, REFERENCE_PATH);
    if (result.ok) {
      this.played(adapter, REFERENCE_PATH, result.effects);
      if (language === 'strudel' && usesVisuals(run)) this.toggleVisuals(true);
      this.trying = { key, language, ids: language === 'tidal' ? patternIds(run).filter((id) => id !== 'unknown') : [] };
      return null;
    }
    addLog(adapter.id, result.error.message, 'error');
    return result.error.message;
  }

  /**
   * Starts or stops recording to the workspace's recordings/ folder. Strudel
   * is recorded if its audio is running, Tidal if SuperCollider is up; with
   * both, each gets its own file.
   */
  async toggleRecording() {
    if (this.recording) return this.stopRecording();
    const strudel = adapters.find((a) => a.id === 'strudel') as StrudelAdapter;
    const source = strudel.recordingSource();
    try {
      const files = await ipc.recordStart(source ? source.context.sampleRate : null);
      if (source) {
        this.tap = new Tap();
        await this.tap.start(source);
      }
      this.recording = { since: Date.now(), files };
      addLog('uaithne', `Recording to ${files.map(relative).join(' and ')}`);
    } catch (err) {
      addLog('uaithne', `Couldn't record: ${err}`, 'error');
    }
  }

  async stopRecording() {
    if (!this.recording) return;
    this.recording = null;
    await this.tap?.stop();
    this.tap = null;
    const files = await ipc.recordStop();
    if (files.length) addLog('uaithne', `Saved ${files.map(relative).join(' and ')}`);
  }

  /** Applies the theme in settings, re-reading the user's theme.css. */
  async reloadTheme() {
    const css = await ipc.userThemeCss().catch((err) => {
      addLog('uaithne', `Couldn't read theme.css: ${err}`, 'error');
      return null;
    });
    applyTheme(this.settings?.theme ?? 'auto', css, () => {
      const strudel = adapters.find((a) => a.id === 'strudel') as StrudelAdapter;
      strudel.syncDrawTheme();
    });
  }

  async setTheme(theme: string) {
    this.settings = await ipc.updateSettings({ theme });
    await this.reloadTheme();
  }

  /** Shows or hides the visuals panel (toggles without an argument). */
  toggleVisuals(open = !this.visualsOpen) {
    this.visualsOpen = open;
    const strudel = adapters.find((a) => a.id === 'strudel') as StrudelAdapter;
    if (open) strudel.syncDrawTheme();
    strudel.setVisualsPanel(open);
  }

  /** The key of the tried example that's still playing, if any. */
  get tryPlaying(): string | null {
    const t = this.trying;
    const adapter = t && adapters.find((a) => a.id === t.language);
    if (!t || !adapter || adapter.state.nowPlaying !== REFERENCE_PATH || adapter.state.status !== 'playing') return null;
    return t.language === 'tidal' && !t.ids.length ? null : t.key;
  }

  /**
   * Stops the tried example. Strudel plays one pattern, so that's a hush; in
   * Tidal only the example's own pattern ids are silenced.
   */
  async stopTry() {
    const t = this.trying;
    const adapter = t && adapters.find((a) => a.id === t.language);
    if (!t || !adapter) return;
    this.trying = null;
    if (t.language === 'strudel') return adapter.hush();
    const ids = t.ids.map((id) => JSON.stringify(id)).join(', ');
    await ipc.tidalEval(`mapM_ (\\i -> p i silence) [${ids}]`).catch((err) => addLog('tidal', `Couldn't stop: ${err}`, 'error'));
    if (adapter.state.nowPlaying === REFERENCE_PATH) adapter.state.nowPlaying = null;
  }

  /** Inserts code as its own block below the cursor's line. */
  insertCode(code: string) {
    this.editor?.insertBlock(code);
  }

  /** `:q`: stops the track if it's what its engine is playing, otherwise closes it. */
  async quit(path: string) {
    const adapter = adapterFor(path);
    if (adapter?.state.status === 'playing' && adapter.state.nowPlaying === path) await adapter.hush();
    else await this.tracks.close(path);
  }

  hush(all: boolean) {
    for (const adapter of all ? adapters : [this.activeAdapter]) {
      void adapter?.hush();
    }
  }

  // ---- volume -----------------------------------------------------------

  setVolume(volume: number, muted = this.muted) {
    this.volume = Math.min(1, Math.max(0, volume));
    this.muted = muted;
    this.applyVolume();
    clearTimeout(this.volumeSaveTimer);
    this.volumeSaveTimer = setTimeout(() => void ipc.setVolume(this.volume, this.muted), 300);
  }

  private applyVolume() {
    const gain = this.muted ? 0 : taper(this.volume);
    for (const adapter of adapters) adapter.setVolume(gain);
  }

  // ---- tracks -----------------------------------------------------------

  /** Turns user input like "live/intro" into a track path with an extension. */
  trackPath(input: string): string | null {
    let name = input.trim().replace(/^\/+/, '').replace(/^tracks\//, '');
    if (!name) return null;
    if (!trackExtensions.some((ext) => name.endsWith(ext))) {
      name += this.activeAdapter?.extensions[0] ?? trackExtensions[0];
    }
    return name;
  }

  /** `:e name` and the quick switcher: open the track, creating it if needed. */
  async openOrCreate(input: string) {
    const path = this.trackPath(input);
    if (!path) return;
    try {
      if (this.tracks.tracks.includes(path)) await this.tracks.switchTo(path);
      else await this.tracks.create(path);
    } catch (err) {
      addLog('uaithne', String(err), 'error');
    }
  }

  ask(title: string, initial?: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.prompt = {
        title,
        initial,
        resolve: (value) => {
          this.prompt = null;
          resolve(value);
          this.editor?.focus();
        },
      };
    });
  }

  async newTrackPrompt() {
    const name = await this.ask('New track (e.g. groove.strudel or live/intro.tidal)', '');
    if (name) await this.openOrCreate(name);
  }

  async renamePrompt(path: string) {
    const name = await this.ask(`Rename ${path}`, path);
    const to = name && this.trackPath(name);
    if (to && to !== path) await this.tracks.rename(path, to).catch((e) => addLog('uaithne', String(e), 'error'));
  }

  async duplicatePrompt(path: string) {
    const name = await this.ask(`Duplicate ${path} as`, path.replace(/(\.\w+)$/, '-copy$1'));
    const to = name && this.trackPath(name);
    if (to) await this.tracks.duplicate(path, to).catch((e) => addLog('uaithne', String(e), 'error'));
  }

  async deletePrompt(path: string) {
    const ok = await this.ask(`Delete ${path}? It will be moved to .uaithne/trash.`);
    if (ok !== null) await this.tracks.remove(path).catch((e) => addLog('uaithne', String(e), 'error'));
  }

  // ---- samples ----------------------------------------------------------

  /** Inserts `name` (or `name:n`) into the active track at the cursor. */
  insertSound(name: string, n = 0) {
    const adapter = this.activeAdapter;
    if (!adapter || !this.editor) return;
    this.editor.insertSound(n ? `${name}:${n}` : name, adapter.id);
  }

  // ---- shortcuts --------------------------------------------------------

  /** Window keydown, capture phase, so these beat vim's own bindings. */
  /** True while the help window is waiting for new keys for a shortcut. */
  capturingKeys = false;

  onKeydown(e: KeyboardEvent) {
    for (const adapter of adapters) adapter.unlockAudio();
    if (this.capturingKeys) return;
    const command = keymap.commandFor(e);
    if (command && this.runCommand(command)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /** Runs a shortcut's command; false when it doesn't apply now (so the key does its usual thing). */
  private runCommand(command: CommandId): boolean {
    const modal =
      this.prompt || this.quickSwitcherOpen || this.samples.managerOpen || this.tidalOpen || this.helpOpen || this.settingsOpen;
    switch (command) {
      case 'evaluate':
        if (modal) return false;
        void this.evaluate('main');
        return true;
      case 'evaluateLine':
        if (modal || !this.editor?.view.hasFocus) return false;
        void this.evaluate('line');
        return true;
      case 'hush':
        this.hush(false);
        return true;
      case 'hushAll':
        this.hush(true);
        return true;
      case 'record':
        if (modal) return false;
        void this.toggleRecording();
        return true;
      case 'switcher':
        this.quickSwitcherOpen = !this.quickSwitcherOpen;
        return true;
      case 'reference':
        if (modal) return false;
        this.reference.toggle();
        return true;
      case 'log':
        this.consoleOpen = !this.consoleOpen;
        return true;
      case 'visuals':
        if (modal) return false;
        this.toggleVisuals();
        return true;
      case 'settings':
        if (modal) return false;
        this.settingsOpen = true;
        return true;
      case 'help':
        if (modal && !this.helpOpen) return false;
        this.helpOpen = !this.helpOpen;
        return true;
      case 'volumeUp':
        this.setVolume(this.volume + VOLUME_STEP);
        return true;
      case 'volumeDown':
        this.setVolume(this.volume - VOLUME_STEP);
        return true;
      case 'mute':
        this.setVolume(this.volume, !this.muted);
        return true;
    }
  }

  /** Saves the shortcuts as changed in the help window. */
  async saveKeybindings() {
    try {
      this.settings = await ipc.updateSettings({ keybindings: keymap.overrides });
    } catch (err) {
      addLog('uaithne', `Couldn't save the shortcuts: ${err}`, 'error');
    }
  }
}

/** A path inside the workspace, as `recordings/…`. */
function relative(path: string) {
  const root = app.workspace?.root;
  return root && path.startsWith(root) ? path.slice(root.length).replace(/^\//, '') : path;
}

/** Share (%) of a canvas (the panel's by default) with anything drawn on it (self-test). */
function paintedShare(canvas = document.getElementById('test-canvas') as HTMLCanvasElement | null | undefined) {
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx || !canvas.width || !canvas.height) return 'no canvas: 0';
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let painted = 0;
  let sampled = 0;
  for (let i = 3; i < data.length; i += 4 * 16) {
    sampled++;
    if (data[i] > 0) painted++;
  }
  return `${((painted / sampled) * 100).toFixed(1)} (canvas ${canvas.width}x${canvas.height})`;
}

export const app = new App();
export type { App };
