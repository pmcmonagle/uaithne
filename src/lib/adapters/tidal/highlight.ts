// Outlines the Tidal code that's sounding. Tidal reports each event's place
// relative to the block it was evaluated from (src-tauri/src/tidal/highlight.rs),
// so each track remembers, per pattern id, where its block's lines started at
// evaluation and the edits made since, which map those places to today's text.

import { ChangeSet, StateEffect, StateField, type ChangeDesc, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

import type { TidalHighlight } from '$lib/ipc';

/** A block was evaluated: these pattern ids now come from it. */
export const claimIds = StateEffect.define<{ ids: string[]; lineStarts: number[] }>();
/** These ids (all, for null) no longer come from this track. */
export const releaseIds = StateEffect.define<string[] | null>();
/** The events sounding now, replacing the last set. */
export const showEvents = StateEffect.define<TidalHighlight[]>();

interface Source {
  /** Document position of each block line when it was evaluated. */
  lineStarts: number[];
  /** Edits since then. */
  since: ChangeDesc;
}

interface Highlights {
  sources: Map<string, Source>;
  marks: DecorationSet;
}

const mark = Decoration.mark({ class: 'cm-tidal-active' });

const field = StateField.define<Highlights>({
  create: () => ({ sources: new Map(), marks: Decoration.none }),
  update(value, tr) {
    let { sources, marks } = value;
    if (tr.docChanged) {
      sources = new Map([...sources].map(([id, s]) => [id, { ...s, since: s.since.composeDesc(tr.changes.desc) }]));
      marks = marks.map(tr.changes);
    }
    for (const e of tr.effects) {
      if (e.is(claimIds)) {
        sources = new Map(sources);
        const since = ChangeSet.empty(tr.newDoc.length).desc;
        for (const id of e.value.ids) sources.set(id, { lineStarts: e.value.lineStarts, since });
      } else if (e.is(releaseIds)) {
        sources = e.value ? new Map([...sources].filter(([id]) => !e.value!.includes(id))) : new Map();
        marks = Decoration.none;
      } else if (e.is(showEvents)) {
        marks = build(e.value, sources, tr.newDoc.length);
      }
    }
    return sources === value.sources && marks === value.marks ? value : { sources, marks };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.marks),
});

function build(events: TidalHighlight[], sources: Map<string, Source>, length: number): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const done = new Set<string>();
  for (const e of events) {
    const source = sources.get(e.id);
    const start = source?.lineStarts[e.line - 1];
    const end = source?.lineStarts[e.endLine - 1];
    if (!source || start === undefined || end === undefined) continue;
    const from = source.since.mapPos(start + e.column, 1);
    const to = Math.min(source.since.mapPos(end + e.endColumn, -1), length);
    const key = `${from}:${to}`;
    if (from < to && !done.has(key)) {
      done.add(key);
      ranges.push(mark.range(from, to));
    }
  }
  return Decoration.set(ranges, true);
}

/** The marked ranges (for the self-test). */
export function activeRanges(state: EditorState) {
  const out: { from: number; to: number }[] = [];
  state.field(field, false)?.marks.between(0, state.doc.length, (from, to) => void out.push({ from, to }));
  return out;
}

const theme = EditorView.baseTheme({
  '.cm-tidal-active': { outline: '2px solid var(--foreground)', borderRadius: '2px' },
});

export const tidalHighlighting = [field, theme];

/**
 * The pattern ids a block sets, as Tidal names them: `d1` and `p 1` are "1",
 * `p "name"` is "name". `once` and friends play without an id ("unknown").
 */
export function patternIds(code: string): string[] {
  const ids = new Set<string>();
  const strip = code.replace(/--.*$/gm, '');
  for (const m of strip.matchAll(/\bd(\d+)\b/g)) ids.add(m[1]);
  const transitions =
    'p|xfade|xfadeIn|histpan|wait|waitT|jump|jumpIn|jumpIn\'|jumpMod|jumpMod\'|mortal|interpolate|interpolateIn|clutch|clutchIn|anticipate|anticipateIn|forId';
  const withId = new RegExp(`(?<![\\w'])(?:${transitions})\\s+(?:(\\d+)|"([^"]*)")`, 'g');
  for (const m of strip.matchAll(withId)) ids.add(m[1] ?? m[2]);
  if (/\b(once|asap|first)\b/.test(strip)) ids.add('unknown');
  return [...ids];
}

/** Document positions of each line of a block that starts at `from`. */
export function lineStarts(code: string, from: number): number[] {
  const starts = [from];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(from + i + 1);
  return starts;
}
