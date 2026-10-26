import type { EditorState } from '@codemirror/state';
import type { Range } from './types';

export function lineOrSelection(state: EditorState): Range {
  const sel = state.selection.main;
  if (!sel.empty) return { from: sel.from, to: sel.to };
  const line = state.doc.lineAt(sel.head);
  return { from: line.from, to: line.to };
}

/** The run of non-blank lines around the cursor (Tidal's unit of evaluation). */
export function blockAt(state: EditorState): Range {
  const sel = state.selection.main;
  if (!sel.empty) return { from: sel.from, to: sel.to };
  const doc = state.doc;
  const isBlank = (n: number) => doc.line(n).text.trim() === '';
  let first = doc.lineAt(sel.head).number;
  if (isBlank(first)) return { from: sel.head, to: sel.head };
  let last = first;
  while (first > 1 && !isBlank(first - 1)) first--;
  while (last < doc.lines && !isBlank(last + 1)) last++;
  return { from: doc.line(first).from, to: doc.line(last).to };
}
