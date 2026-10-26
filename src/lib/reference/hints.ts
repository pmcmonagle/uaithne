// Editor hints from the reference: completion (function names, and sample
// names inside strings), hover docs, and the signature of the call being
// typed, with the current argument picked out.

import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { EditorState, Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, hoverTooltip, showTooltip, type Tooltip } from '@codemirror/view';

import type { LanguageId } from '$lib/adapters/types';
import { inString } from '$lib/editor/editor';
import { loadReference, referenceIfLoaded, type RefEntry, type Reference } from './index.svelte';

/** Sound names each language can play, for completion inside strings; the app sets this. */
let soundNames: (language: LanguageId) => string[] = () => [];
export function setSoundNames(get: (language: LanguageId) => string[]) {
  soundNames = get;
}

const WORD = /[\w$']*/;

function wordAt(state: EditorState, pos: number) {
  const line = state.doc.lineAt(pos);
  const text = line.text;
  let from = pos - line.from;
  let to = from;
  while (from > 0 && /[\w$']/.test(text[from - 1])) from--;
  while (to < text.length && /[\w$']/.test(text[to])) to++;
  if (from === to) return null;
  return { from: line.from + from, to: line.from + to, text: text.slice(from, to) };
}

// ---- completion ---------------------------------------------------------

function functionOptions(ref: Reference): Completion[] {
  const options: Completion[] = [];
  for (const e of ref.entries) {
    const detail = shortSignature(e, ref.language);
    const info = e.synopsis || undefined;
    const boost = e.description ? 0 : -10;
    options.push({ label: e.name, type: 'function', detail, info, boost });
    for (const alias of e.aliases ?? []) options.push({ label: alias, type: 'function', detail: `= ${e.name}`, info, boost: boost - 1 });
  }
  return options;
}

/** `jux :: (…) -> …` → `(…) -> …`; Strudel signatures already read as calls. */
function shortSignature(e: RefEntry, language: LanguageId) {
  if (!e.signature) return undefined;
  const sig = language === 'tidal' ? e.signature.replace(/^.*?::\s*/, '') : e.signature.replace(/^[\w$]+/, '');
  return sig.length > 48 ? sig.slice(0, 47) + '…' : sig;
}

function completionSource(language: LanguageId) {
  let cached: { ref: Reference; options: Completion[] } | null = null;
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    if (inString(ctx.state, ctx.pos, language)) {
      const word = ctx.matchBefore(/[\w.-]*/);
      if (!word || (word.from === word.to && !ctx.explicit)) return null;
      const names = [...new Set(soundNames(language))];
      return { from: word.from, options: names.map((label) => ({ label, type: 'constant', detail: 'sound' })), validFor: /^[\w.-]*$/ };
    }
    const word = ctx.matchBefore(WORD);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    const ref = await loadReference(language);
    if (cached?.ref !== ref) cached = { ref, options: functionOptions(ref) };
    return { from: word.from, options: cached.options, validFor: /^[\w$']*$/ };
  };
}

// ---- hover --------------------------------------------------------------

function tooltipDom(entry: RefEntry, language: LanguageId, highlight?: number) {
  const dom = document.createElement('div');
  dom.className = 'cm-ref-tooltip';
  if (entry.signature) {
    const sig = document.createElement('code');
    sig.className = 'cm-ref-signature';
    const parts = signatureParts(entry, language);
    parts.forEach((part, i) => {
      const span = document.createElement('span');
      span.textContent = part.text;
      if (part.arg !== undefined && part.arg === highlight) span.className = 'cm-ref-current';
      sig.append(span);
      if (i < parts.length - 1 && language === 'strudel' && part.arg !== undefined && parts[i + 1].arg !== undefined) {
        sig.append(', ');
      }
    });
    dom.append(sig);
  }
  if (entry.synopsis) {
    const p = document.createElement('div');
    p.className = 'cm-ref-synopsis';
    p.textContent = entry.synopsis;
    dom.append(p);
  }
  return dom;
}

/**
 * A signature cut into pieces, numbering the argument pieces: Strudel's
 * parameters, or the inputs of a Tidal type (`a -> b -> c` has args a, b).
 */
function signatureParts(entry: RefEntry, language: LanguageId): { text: string; arg?: number }[] {
  const sig = entry.signature ?? entry.name;
  if (language === 'strudel') {
    const m = sig.match(/^([\w$]+)\((.*)\)$/);
    if (!m) return [{ text: sig }];
    const args = m[2] ? m[2].split(', ') : [];
    return [{ text: `${m[1]}(` }, ...args.map((text, arg) => ({ text, arg })), { text: ')' }];
  }
  const head = sig.match(/^(.*?::\s*(?:.*?=>\s*)?)/)?.[1] ?? '';
  const pieces = splitArrows(sig.slice(head.length));
  const out: { text: string; arg?: number }[] = [{ text: head }];
  pieces.forEach((text, i) => {
    out.push(i < pieces.length - 1 ? { text, arg: i } : { text });
    if (i < pieces.length - 1) out.push({ text: ' -> ' });
  });
  return out;
}

/** Splits a type at its top-level arrows. */
function splitArrows(type: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < type.length; i++) {
    const c = type[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && type.startsWith('->', i)) {
      out.push(type.slice(start, i).trim());
      start = i + 2;
      i++;
    }
  }
  out.push(type.slice(start).trim());
  return out;
}

function hover(language: LanguageId) {
  return hoverTooltip(async (view, pos): Promise<Tooltip | null> => {
    if (inString(view.state, pos, language)) return null;
    const word = wordAt(view.state, pos);
    if (!word) return null;
    const entry = (await loadReference(language)).get(word.text);
    if (!entry) return null;
    return { pos: word.from, end: word.to, above: true, create: () => ({ dom: tooltipDom(entry, language) }) };
  });
}

// ---- signature help -----------------------------------------------------

interface Call {
  /** Where the function name starts. */
  pos: number;
  entry: RefEntry;
  arg: number;
}

/** Strudel: the innermost unclosed `name(` before the cursor, and which argument it's in. */
function strudelCall(state: EditorState, pos: number, ref: Reference): Call | null {
  const start = Math.max(0, pos - 2000);
  const text = state.sliceDoc(start, pos);
  let depth = 0;
  let arg = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const open = text.lastIndexOf(c, i - 1);
      if (open < 0) return null; // inside a string
      i = open;
    } else if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '[' || c === '{') {
      if (depth === 0) return null;
      depth--;
    } else if (c === '(') {
      if (depth > 0) {
        depth--;
        continue;
      }
      const name = text.slice(0, i).match(/([\w$]+)\s*$/);
      const entry = name && ref.get(name[1]);
      return entry ? { pos: start + i - name[0].length, entry, arg } : null;
    } else if (c === ',' && depth === 0) arg++;
  }
  return null;
}

/**
 * Tidal: in the expression the cursor is in (back to an unclosed `(`, or a
 * `$`, `#` or `.` at that level), the first word if it's a function, and how
 * many arguments come before the cursor.
 */
function tidalCall(state: EditorState, pos: number, ref: Reference): Call | null {
  const line = state.doc.lineAt(pos);
  const text = line.text.slice(0, pos - line.from);
  let depth = 0;
  let begin = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (c === '"') {
      const open = text.lastIndexOf('"', i - 1);
      if (open < 0) return null;
      i = open;
    } else if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') {
      if (depth === 0) {
        begin = i + 1;
        break;
      }
      depth--;
    } else if (depth === 0 && /[$#.,|+*=]/.test(c) && (c !== '.' || /\s/.test(text[i - 1] ?? ' '))) {
      begin = i + 1;
      break;
    }
  }
  const segment = text.slice(begin);
  const tokens = [...segment.matchAll(/"[^"]*"?|\([^()]*\)?|\[[^\]]*\]?|[^\s()[\]"]+/g)];
  if (!tokens.length) return null;
  const entry = ref.get(tokens[0][0]);
  if (!entry || !entry.signature?.includes('->')) return null;
  // Arguments typed so far; a token touching the cursor is still being written.
  const touching = /\S$/.test(segment) && tokens.length > 1;
  const arg = tokens.length - 1 - (touching ? 1 : 0);
  return { pos: line.from + begin + (tokens[0].index ?? 0), entry, arg };
}

/** The call the cursor is in, if the reference has loaded and knows the function. */
export function callAt(state: EditorState, language: LanguageId): Call | null {
  const ref = referenceIfLoaded(language);
  const pos = state.selection.main.head;
  if (!ref || !state.selection.main.empty) return null;
  return language === 'tidal' ? tidalCall(state, pos, ref) : strudelCall(state, pos, ref);
}

const closeSignature = StateEffect.define<null>();

function signatureHelp(language: LanguageId): Extension {
  const find = (state: EditorState) => callAt(state, language);
  const field = StateField.define<Call | null>({
    create: () => null,
    update(call, tr) {
      if (tr.effects.some((e) => e.is(closeSignature))) return null;
      // Appears while typing, then follows the cursor until it leaves the call.
      if (tr.docChanged && tr.isUserEvent('input')) return find(tr.state);
      if (call && (tr.docChanged || tr.selection)) {
        const next = find(tr.state);
        return next && next.entry === call.entry ? next : null;
      }
      return call;
    },
    provide: (f) =>
      showTooltip.compute([f], (state) => {
        const call = state.field(f);
        if (!call) return null;
        return {
          pos: call.pos,
          above: true,
          strictSide: true,
          create: () => ({ dom: tooltipDom(call.entry, language, call.arg) }),
        };
      }),
  });
  // Escape closes it; vim sees Escape first, so listen before any keymap.
  const escape = Prec.highest(
    EditorView.domEventHandlers({
      keydown: (e, view) => {
        if (e.key === 'Escape') closeIfOpen(view, field);
        return false;
      },
    }),
  );
  return [field, escape];
}

function closeIfOpen(view: EditorView, field: StateField<Call | null>) {
  if (view.state.field(field, false)) view.dispatch({ effects: closeSignature.of(null) });
}

// ---- together -----------------------------------------------------------

const theme = EditorView.baseTheme({
  '.cm-ref-tooltip': { padding: '0.3rem 0.5rem', maxWidth: '36rem', fontSize: '0.85em' },
  '.cm-ref-signature': { display: 'block', whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)' },
  '.cm-ref-current': { fontWeight: '700', textDecoration: 'underline', color: 'var(--accent)' },
  '.cm-ref-synopsis': { marginTop: '0.2rem', opacity: '0.8', fontFamily: 'var(--font-ui)' },
});

export function referenceHints(language: LanguageId): Extension {
  void loadReference(language); // ready by the time hints are wanted
  const autocomplete = completionSource(language);
  return [
    EditorState.languageData.of(() => [{ autocomplete }]),
    hover(language),
    signatureHelp(language),
    theme,
  ];
}
