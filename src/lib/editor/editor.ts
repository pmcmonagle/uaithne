// One EditorView shared by all tracks. Each open track keeps its own
// EditorState (and so its own undo history and cursor), swapped in on switch.

import { basicSetup } from 'codemirror';
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { setDiagnostics } from '@codemirror/lint';
import { getCM, vim } from '@replit/codemirror-vim';

import type { LanguageAdapter, LanguageId, Range } from '$lib/adapters/types';
import { editorTheme } from '$lib/themes';

export interface EditorHooks {
  onDocChanged(): void;
  onVimMode(mode: string): void;
}

export interface EditorOptions {
  vim: boolean;
  fontSize: number;
}

const setFlash = StateEffect.define<Range | null>();
const flashMark = Decoration.mark({ class: 'cm-uaithne-flash' });

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setFlash)) {
        deco = e.value && e.value.to > e.value.from ? Decoration.set([flashMark.range(e.value.from, e.value.to)]) : Decoration.none;
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export class Editor {
  readonly view: EditorView;
  private shared: Extension[];
  private flashTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(parent: HTMLElement, private hooks: EditorHooks, options: EditorOptions) {
    this.shared = [
      // vim() must come before other keymaps so it sees keys first. App-wide
      // shortcuts (Ctrl+Enter, Shift+Enter, Ctrl+.…) are handled on window
      // instead, so they can be rebound ($lib/keys.svelte.ts).
      options.vim ? vim() : [],
      basicSetup,
      editorTheme,
      EditorView.theme({
        '&': { height: '100%', fontSize: `${options.fontSize}px` },
        '.cm-scroller': { fontFamily: 'var(--font-mono)' },
        '.cm-uaithne-flash': { backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent)' },
      }),
      flashField,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) hooks.onDocChanged();
      }),
    ];
    this.view = new EditorView({ parent, state: EditorState.create() });
  }

  createState(doc: string, adapter: LanguageAdapter | undefined): EditorState {
    return EditorState.create({ doc, extensions: [this.shared, adapter?.editorExtensions() ?? []] });
  }

  /** Swaps in a track's state. The vim plugin is rebuilt, so re-subscribe. */
  setState(state: EditorState) {
    this.view.setState(state);
    this.hooks.onVimMode('normal');
    getCM(this.view)?.on('vim-mode-change', (e: { mode: string; subMode?: string }) =>
      this.hooks.onVimMode(e.subMode ? `${e.mode} ${e.subMode}` : e.mode),
    );
  }

  get state() {
    return this.view.state;
  }

  /** Replaces the document, keeping it as one undoable change. */
  replaceDoc(content: string) {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: content } });
  }

  flash(range: Range) {
    clearTimeout(this.flashTimer);
    this.view.dispatch({ effects: setFlash.of(range) });
    this.flashTimer = setTimeout(() => this.view.dispatch({ effects: setFlash.of(null) }), 200);
  }

  showError(message: string, range: Range, pos?: number) {
    const from = pos ?? range.from;
    const to = pos !== undefined ? Math.min(pos + 1, this.state.doc.length) : range.to;
    this.view.dispatch(setDiagnostics(this.state, [{ from, to, severity: 'error', message }]));
  }

  clearErrors() {
    this.view.dispatch(setDiagnostics(this.state, []));
  }

  /**
   * Inserts a sample reference at the cursor: bare inside a pattern string
   * (spaced from its neighbours), otherwise wrapped as `s("bd:3")`/`s "bd:3"`.
   */
  insertSound(token: string, language: LanguageId) {
    const state = this.state;
    const pos = state.selection.main.head;
    let text: string;
    if (inString(state, pos, language)) {
      const before = state.sliceDoc(pos - 1, pos);
      const after = state.sliceDoc(pos, pos + 1);
      const pad = (c: string, ok: RegExp) => (c && !ok.test(c) ? ' ' : '');
      text = pad(before, /[\s"'`[<{(]/) + token + pad(after, /[\s"'`\]>})]/);
    } else {
      text = language === 'tidal' ? `s "${token}"` : `s("${token}")`;
    }
    this.view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length }, scrollIntoView: true });
    this.view.focus();
  }

  /** Inserts code below the cursor's line, as its own block, and puts the cursor on it. */
  insertBlock(code: string) {
    const state = this.state;
    const line = state.doc.lineAt(state.selection.main.head);
    const blank = !line.text.trim();
    const from = blank ? line.from : line.to;
    const text = blank ? code : `\n\n${code}`;
    const start = blank ? from : from + 2;
    this.view.dispatch({
      changes: { from, to: blank ? line.to : from, insert: text },
      selection: { anchor: start },
      scrollIntoView: true,
    });
    this.flash({ from: start, to: start + code.length });
    this.view.focus();
  }

  focus() {
    this.view.focus();
  }

  destroy() {
    this.view.destroy();
  }
}

/** Whether `pos` is inside a string (where mini-notation and sample names go). */
export function inString(state: EditorState, pos: number, language: LanguageId): boolean {
  if (language === 'tidal') {
    const line = state.doc.lineAt(pos);
    return (state.sliceDoc(line.from, pos).match(/"/g)?.length ?? 0) % 2 === 1;
  }
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if ((node.name === 'String' || node.name === 'TemplateString') && node.from < pos) {
      // An unclosed string (still being typed) runs to the end of the line.
      const quote = state.sliceDoc(node.from, node.from + 1);
      const closed = node.to - node.from > 1 && state.sliceDoc(node.to - 1, node.to) === quote;
      if (pos < node.to || (pos === node.to && !closed)) return true;
    }
  }
  return false;
}
