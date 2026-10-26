// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.

import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface Settings {
  workspace: string | null;
  volume: number;
  muted: boolean;
  /** Strudel's .midi() output when the code names none; empty: the first port. */
  midiOutput: string;
  /** Where Tidal's s "midi" plays; empty: off. */
  tidalMidiOutput: string;
  /** Strudel's .osc() target, "host:port". */
  oscTarget: string;
  /** Colour theme id, or "auto" to follow the system. */
  theme: string;
  /** Shortcuts changed from their defaults: command id → keys. */
  keybindings: Record<string, string[]>;
}

export interface EditorConfig {
  vim: boolean;
  font_size: number;
  /** What <leader> means in vim_mappings. */
  leader: string;
  /** vimrc-style mappings, e.g. "inoremap jk <Esc>". */
  vim_mappings: string[];
}

export interface WorkspaceInfo {
  root: string;
  config: { editor: EditorConfig };
}

export interface TrackInfo {
  path: string;
}

export interface Sound {
  name: string;
  /** `local` or a pack id. */
  origin: string;
  /** Workspace-relative paths in sample-index order. */
  files: string[];
  /** Pitched sounds: note → indices into `files`. */
  notes?: Record<string, number[]>;
  stamp: number;
  /** An earlier sound with the same name wins (local first, then packs by id). */
  shadowed: boolean;
}

export interface InstalledPack {
  id: string;
  name: string;
  source: string | null;
  sounds: number;
  files: number;
  bytes: number;
}

export interface Library {
  sounds: Sound[];
  packs: InstalledPack[];
}

export interface CatalogueEntry {
  id: string;
  name: string;
  source: string;
  description: string;
  sounds: number;
  files: number;
}

export interface PackProgress {
  id: string;
  done: number;
  total: number;
  failed: number;
}

export const frontendLog = (level: string, source: string, message: string) =>
  invoke<void>('frontend_log', { level, source, message });
export const selftestEnabled = () => invoke<boolean>('selftest_enabled');
export const selftestPack = () => invoke<string | null>('selftest_pack');
export const getSettings = () => invoke<Settings>('get_settings');
export const setVolume = (volume: number, muted: boolean) => invoke<void>('set_volume', { volume, muted });
/** Changes just the settings given. */
export const updateSettings = (patch: Partial<Settings>) => invoke<Settings>('update_settings', { patch });
/** The user's theme.css from the app config dir, if there is one. */
export const userThemeCss = () => invoke<string | null>('user_theme_css');
export const openWorkspace = (root: string) => invoke<WorkspaceInfo>('open_workspace', { root });
export const listTracks = () => invoke<TrackInfo[]>('list_tracks');
export const readTrack = (path: string) => invoke<string>('read_track', { path });
export const writeTrack = (path: string, content: string) => invoke<void>('write_track', { path, content });
export const createTrack = (path: string, content = '') => invoke<void>('create_track', { path, content });
export const renameTrack = (from: string, to: string) => invoke<void>('rename_track', { from, to });
export const deleteTrack = (path: string) => invoke<void>('delete_track', { path });

export const onTracksChanged = (handler: (paths: string[]) => void): Promise<UnlistenFn> =>
  listen<{ paths: string[] }>('tracks-changed', (e) => handler(e.payload.paths));

export const sampleLibrary = () => invoke<Library>('sample_library');
export const packCatalogue = () => invoke<CatalogueEntry[]>('pack_catalogue');
export const packIdFor = (source: string) => invoke<string>('pack_id_for', { source });
export const installPack = (id: string, name: string, source: string) =>
  invoke<void>('install_pack', { id, name, source });
export const cancelPack = (id: string) => invoke<void>('cancel_pack', { id });
export const deletePack = (id: string) => invoke<void>('delete_pack', { id });

export const onSamplesChanged = (handler: () => void): Promise<UnlistenFn> =>
  listen('samples-changed', () => handler());
export const onPackProgress = (handler: (p: PackProgress) => void): Promise<UnlistenFn> =>
  listen<PackProgress>('pack-progress', (e) => handler(e.payload));

/** URL the webview fetches a sample from; `stamp` busts caches when files change. */
export const sampleUrl = (path: string, stamp: number) => `${convertFileSrc(path, 'uaithne')}?v=${stamp}`;

export type ProcStatus = 'stopped' | 'starting' | 'ready' | 'error';

export interface ProcState {
  status: ProcStatus;
  message: string | null;
}

export interface TidalStatus {
  sclang: ProcState;
  ghci: ProcState;
  /** The audio output SuperCollider is linked to, when Uaithne linked it. */
  output: string | null;
  /** A crashed process is being restarted; what was playing comes back with it. */
  recovering: boolean;
}

export interface Prereq {
  id: string;
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

export interface TidalEvalReply {
  ok: boolean;
  output: string;
  /** 1-based, within the evaluated code. */
  line: number | null;
  column: number | null;
}

/** An event sounding now, at its place in the block it was evaluated from. */
export interface TidalHighlight {
  /** Tidal's pattern id: "1" for d1, the name for p "name". */
  id: string;
  /** 1-based lines, 0-based columns, end exclusive. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /** Seconds. */
  duration: number;
}

export interface EngineLogLine {
  source: string;
  level: 'info' | 'warning' | 'error';
  message: string;
}

export const selftestTidal = () => invoke<boolean>('selftest_tidal');
export const tidalCheck = () => invoke<Prereq[]>('tidal_check');
export const tidalStatus = () => invoke<TidalStatus>('tidal_status');
export const tidalStart = () => invoke<void>('tidal_start');
export const tidalStop = () => invoke<void>('tidal_stop');
export const tidalEval = (code: string) => invoke<TidalEvalReply>('tidal_eval', { code });
export const tidalVolume = (gain: number) => invoke<void>('tidal_volume', { gain });
export const tidalRelink = () => invoke<string>('tidal_relink');
export const tidalReloadSamples = () => invoke<void>('tidal_reload_samples');
export const tidalMeter = (seconds: number) => invoke<number>('tidal_meter', { seconds });

export const onTidalStatus = (handler: (s: TidalStatus) => void): Promise<UnlistenFn> =>
  listen<TidalStatus>('tidal-status', (e) => handler(e.payload));
/** GHCi is back after a crash, with nothing playing. */
export const onTidalRecovered = (handler: () => void): Promise<UnlistenFn> => listen('tidal-recovered', () => handler());
/** Dev aid: kills `ghci`, `sclang` or `scsynth` as a crash would. */
export const selftestCrash = (which: 'ghci' | 'sclang' | 'scsynth') => invoke<void>('selftest_crash', { which });

/** A MIDI message to send `delayMs` from now. */
export interface TimedMidi {
  delayMs: number;
  bytes: number[];
}

export const midiOutputs = () => invoke<string[]>('midi_outputs');
/** `port`: a name or part of one; empty uses the default from settings. */
export const midiSend = (port: string, messages: TimedMidi[]) => invoke<void>('midi_send', { port, messages });
/** `target` "host:port", or null for the one in settings. */
export const oscSend = (target: string | null, address: string, args: (string | number)[], delayMs: number) =>
  invoke<void>('osc_send', { target, address, args, delayMs });
/** Dev aids for the self-test. */
export const selftestMidiCapture = (port: string, ms: number) => invoke<string[]>('selftest_midi_capture', { port, ms });
export const selftestTidalMidi = (port: string) => invoke<void>('selftest_tidal_midi', { port });
export const setIoSettings = (midiOutput: string, tidalMidiOutput: string, oscTarget: string) =>
  invoke<Settings>('set_io_settings', { midiOutput, tidalMidiOutput, oscTarget });

/** Starts recording; `strudelRate` when Strudel's audio is to be recorded. Returns the files. */
export const recordStart = (strudelRate: number | null) => invoke<string[]>('record_start', { strudelRate });
/** Raw interleaved f32 stereo for Strudel's file. */
export const recordChunk = (bytes: Uint8Array) => invoke<void>('record_chunk', bytes);
/** Stops recording; returns the files written. */
export const recordStop = () => invoke<string[]>('record_stop');
/** Dev aid: a WAV's format, length and peak; deletes the file. */
export const selftestWav = (path: string) => invoke<string>('selftest_wav', { path });

export const onTidalHighlight = (handler: (events: TidalHighlight[]) => void): Promise<UnlistenFn> =>
  listen<TidalHighlight[]>('tidal-highlight', (e) => handler(e.payload));
export const onEngineLog = (handler: (line: EngineLogLine) => void): Promise<UnlistenFn> =>
  listen<EngineLogLine>('engine-log', (e) => handler(e.payload));
