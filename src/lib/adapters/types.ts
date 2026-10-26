import type { Extension, EditorState, StateEffect } from '@codemirror/state';

import type { Sound } from '$lib/ipc';

export type LanguageId = 'strudel' | 'tidal';

export type EngineStatus = 'stopped' | 'booting' | 'ready' | 'playing' | 'error' | 'unavailable';

export interface EngineState {
  status: EngineStatus;
  /** Track whose code was last evaluated successfully in this engine. */
  nowPlaying: string | null;
}

export interface Range {
  from: number;
  to: number;
}

export interface EvalError {
  message: string;
  /** Absolute document position, when the engine can report one. */
  pos?: number;
}

/** Editor state effects an engine wants applied to the track it's playing. */
export type Effects = StateEffect<unknown>[];

export type EvalResult = { ok: true; effects?: Effects } | { ok: false; error: EvalError };

/** What a keybinding asks to evaluate; each language decides what that means. */
export type EvalScope = 'main' | 'line';

export interface LanguageAdapter {
  id: LanguageId;
  name: string;
  extensions: string[];
  /** Reactive ($state) engine status. */
  state: EngineState;
  editorExtensions(): Extension[];
  /** The region a keybinding evaluates. A selection always wins over this. */
  regionFor(state: EditorState, scope: EvalScope): Range;
  boot(): Promise<void>;
  /** A track in this language became the active one (optional; e.g. start processes). */
  activate?(): void;
  /** Must be called synchronously from a user gesture so audio can start. */
  unlockAudio(): void;
  /** `path` is the track the code comes from. */
  evaluate(code: string, range: Range, path: string): Promise<EvalResult>;
  hush(): Promise<void>;
  /**
   * Live highlighting (optional). The app sets onFrame; the engine calls it
   * with effects for a track, by default the one it's playing. clearHighlights()
   * returns effects that remove all highlighting, applied when another track
   * takes over the engine.
   */
  onFrame?: ((effects: Effects, path?: string) => void) | null;
  clearHighlights?(): Effects;
  /** Makes the workspace sample library playable by name (optional). */
  loadSamples?(sounds: Sound[]): Promise<void>;
  /** Plays one sample once, outside any pattern (optional). */
  preview?(sound: string, n: number): Promise<void>;
  /** Linear gain, 0..1, already tapered. */
  setVolume(gain: number): void;
  dispose(): Promise<void>;
}
