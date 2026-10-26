// Inline visuals (`._pianoroll()` and friends): a block under the line of
// each call, holding the canvas the visual draws on (./visuals.svelte.ts).
// Blocks follow edits, and are replaced on each evaluation.

import { StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

import { visuals } from './visuals.svelte';

/** Where each inline visual's call ends (document position) and its widget id. */
export const setWidgets = StateEffect.define<{ to: number; id: string }[]>();

class CanvasWidget extends WidgetType {
  constructor(readonly id: string) {
    super();
  }
  eq(other: CanvasWidget) {
    return other.id === this.id;
  }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-visual-inline';
    const canvas = visuals.getInline(this.id);
    if (canvas) wrap.append(canvas);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(widgets, tr) {
    widgets = widgets.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setWidgets)) continue;
      const ranges: Range<Decoration>[] = [];
      for (const { to, id } of e.value) {
        if (to > tr.newDoc.length) continue;
        // After the whole line, so the code above stays as typed.
        const lineEnd = tr.newDoc.lineAt(to).to;
        ranges.push(Decoration.widget({ widget: new CanvasWidget(id), block: true, side: 1 }).range(lineEnd));
      }
      widgets = Decoration.set(ranges, true);
    }
    return widgets;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const theme = EditorView.baseTheme({
  '.cm-visual-inline': { padding: '2px 0 4px' },
  '.cm-visual-inline canvas': { display: 'block', maxWidth: '100%', borderRadius: '3px' },
});

export const inlineVisuals = [field, theme];
