// Open tracks, tabs, autosave and reconciling with changes made on disk.

import type { EditorState, StateEffect } from '@codemirror/state';

import { adapterFor, adapters } from '$lib/adapters';
import type { Editor } from '$lib/editor/editor';
import * as ipc from '$lib/ipc';
import { addLog } from '$lib/log.svelte';

const AUTOSAVE_MS = 1000;

interface Buffer {
  /** Stored state for inactive tracks; the active track's lives in the view. */
  state: EditorState;
  /** Content as last read from or written to disk. */
  saved: string;
  timer?: ReturnType<typeof setTimeout>;
}

export class TrackStore {
  tracks = $state<string[]>([]);
  /** Tab order. */
  open = $state<string[]>([]);
  active = $state<string | null>(null);
  dirty = $state<Record<string, boolean>>({});
  /** Tracks changed on disk while they had unsaved edits. */
  conflicts = $state<string[]>([]);

  private buffers = new Map<string, Buffer>();
  private editor: Editor | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  attach(editor: Editor) {
    this.editor = editor;
  }

  /**
   * Called before the editor is destroyed. Stashes the active track's state
   * and clears `active`, so a new editor (which starts empty) gets the track
   * swapped back in rather than its empty doc being saved over the file.
   */
  detach() {
    if (this.active && this.editor) {
      const buf = this.buffers.get(this.active);
      if (buf) buf.state = this.editor.state;
      const path = this.active;
      this.active = null;
      void this.save(path);
    }
    this.editor = null;
  }

  /** Forgets every track, for a move to another workspace (after detach). */
  reset() {
    clearTimeout(this.refreshTimer);
    this.tracks = [];
    this.open = [];
    this.active = null;
    this.dirty = {};
    this.conflicts = [];
    this.buffers.clear();
  }

  async refresh() {
    this.tracks = (await ipc.listTracks()).map((t) => t.path);
  }

  private content(path: string): string {
    return path === this.active && this.editor
      ? this.editor.state.doc.toString()
      : (this.buffers.get(path)?.state.doc.toString() ?? '');
  }

  /** Opens (or focuses) a track, stashing the current one's editor state. */
  async switchTo(path: string) {
    if (path === this.active || !this.editor) return;
    let buf = this.buffers.get(path);
    if (!buf) {
      const text = await ipc.readTrack(path);
      buf = { state: this.editor.createState(text, adapterFor(path)), saved: text };
      this.buffers.set(path, buf);
    }
    if (this.active) {
      const current = this.buffers.get(this.active);
      if (current) current.state = this.editor.state;
      void this.save(this.active);
    }
    if (!this.open.includes(path)) this.open.push(path);
    this.active = path;
    this.editor.setState(buf.state);
    this.editor.focus();
  }

  async create(path: string, content = '') {
    await ipc.createTrack(path, content);
    await this.refresh();
    await this.switchTo(path);
  }

  async close(path: string) {
    await this.save(path);
    const idx = this.open.indexOf(path);
    if (idx < 0) return;
    this.open.splice(idx, 1);
    if (path === this.active) {
      this.active = null;
      const next = this.open[Math.min(idx, this.open.length - 1)];
      if (next) await this.switchTo(next);
      else this.editor?.setState(this.editor.createState('', undefined));
    }
    this.buffers.delete(path);
    delete this.dirty[path];
  }

  cycle(step: 1 | -1) {
    if (!this.active || this.open.length < 2) return;
    const idx = this.open.indexOf(this.active);
    void this.switchTo(this.open[(idx + step + this.open.length) % this.open.length]);
  }

  async rename(from: string, to: string) {
    await this.save(from);
    await ipc.renameTrack(from, to);
    for (const adapter of adapters) {
      if (adapter.state.nowPlaying === from) adapter.state.nowPlaying = to;
    }
    const buf = this.buffers.get(from);
    if (buf && this.editor) {
      const wasActive = from === this.active;
      if (wasActive) buf.state = this.editor.state;
      // A new extension can mean a new language, so rebuild the state then.
      if (adapterFor(from) !== adapterFor(to)) {
        buf.state = this.editor.createState(buf.state.doc.toString(), adapterFor(to));
      }
      this.buffers.delete(from);
      this.buffers.set(to, buf);
      this.open = this.open.map((p) => (p === from ? to : p));
      if (wasActive) {
        this.active = to;
        this.editor.setState(buf.state);
      }
    }
    await this.refresh();
  }

  async duplicate(path: string, to: string) {
    await this.save(path);
    await this.create(to, this.content(path));
  }

  async remove(path: string) {
    if (this.open.includes(path)) await this.close(path);
    await ipc.deleteTrack(path);
    await this.refresh();
  }

  /** Applies engine effects (e.g. highlighting) to a track, open in the view or not. */
  applyEffects(path: string, effects: StateEffect<unknown>[]) {
    if (path === this.active && this.editor) {
      this.editor.view.dispatch({ effects });
    } else {
      const buf = this.buffers.get(path);
      if (buf) buf.state = buf.state.update({ effects }).state;
    }
  }

  /** Called by the editor on every doc change in the active track. */
  markDirty() {
    const path = this.active;
    const buf = path && this.buffers.get(path);
    if (!path || !buf) return;
    this.dirty[path] = this.content(path) !== buf.saved;
    clearTimeout(buf.timer);
    buf.timer = setTimeout(() => void this.save(path), AUTOSAVE_MS);
  }

  async save(path: string, force = false) {
    const buf = this.buffers.get(path);
    if (!buf) return;
    clearTimeout(buf.timer);
    const text = this.content(path);
    if (text === buf.saved && !force) return;
    try {
      await ipc.writeTrack(path, text);
      buf.saved = text;
      this.dirty[path] = this.content(path) !== text;
    } catch (err) {
      addLog('uaithne', `Couldn't save ${path}: ${err}`, 'error');
    }
  }

  async saveAll() {
    await Promise.all(this.open.map((p) => this.save(p)));
  }

  /** Handles `tracks-changed` from the backend watcher. */
  onDiskChange(paths: string[]) {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 150);
    for (const path of paths) {
      if (this.buffers.has(path)) void this.reconcile(path);
    }
  }

  private async reconcile(path: string) {
    const buf = this.buffers.get(path);
    if (!buf) return;
    let disk: string;
    try {
      disk = await ipc.readTrack(path);
    } catch {
      return; // deleted or mid-rename; the buffer stays open and a save recreates it
    }
    if (disk === buf.saved) return; // our own write
    if (this.dirty[path]) {
      if (!this.conflicts.includes(path)) this.conflicts.push(path);
      addLog('uaithne', `${path} changed on disk while you had unsaved edits`, 'warning');
      return;
    }
    this.load(path, disk);
  }

  /** Resolves a conflict by taking the disk version. */
  async reloadFromDisk(path: string) {
    this.load(path, await ipc.readTrack(path));
  }

  /** Resolves a conflict by keeping the buffer and overwriting the disk. */
  async keepMine(path: string) {
    this.conflicts = this.conflicts.filter((p) => p !== path);
    await this.save(path, true);
  }

  private load(path: string, text: string) {
    const buf = this.buffers.get(path);
    if (!buf || !this.editor) return;
    buf.saved = text;
    if (path === this.active) {
      this.editor.replaceDoc(text);
    } else {
      buf.state = buf.state.update({ changes: { from: 0, to: buf.state.doc.length, insert: text } }).state;
    }
    this.dirty[path] = false;
    this.conflicts = this.conflicts.filter((p) => p !== path);
  }
}
