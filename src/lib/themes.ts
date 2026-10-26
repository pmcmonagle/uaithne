// Colour themes. A theme is a palette of CSS variables on :root; the app's
// styles, the editor (editorTheme below) and Strudel's visuals all read those
// variables, so switching theme is just swapping the palette. A `theme.css`
// in the app config dir is loaded after the palette and can override any of
// them.

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

export interface Palette {
  bg: string;
  panel: string;
  fg: string;
  muted: string;
  border: string;
  hover: string;
  selection: string;
  accent: string;
  ok: string;
  error: string;
  strudel: string;
  tidal: string;
  // Syntax
  keyword: string;
  string: string;
  number: string;
  comment: string;
  function: string;
  property: string;
  type: string;
  operator: string;
}

export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  palette: Palette;
}

export const THEMES: Theme[] = [
  {
    id: 'dark',
    name: 'Dark',
    dark: true,
    palette: {
      bg: '#1e2127',
      panel: '#22262d',
      fg: '#d7dae0',
      muted: '#7f8794',
      border: '#2f343d',
      hover: '#2a2f37',
      selection: '#2f3a4a',
      accent: '#f2c14e',
      ok: '#7ec27e',
      error: '#e06c75',
      strudel: '#e5a65b',
      tidal: '#8fb8de',
      keyword: '#c678dd',
      string: '#98c379',
      number: '#d19a66',
      comment: '#7d8799',
      function: '#61afef',
      property: '#e06c75',
      type: '#e5c07b',
      operator: '#56b6c2',
    },
  },
  {
    id: 'light',
    name: 'Light',
    dark: false,
    palette: {
      bg: '#fafaf8',
      panel: '#f0f0ec',
      fg: '#24292f',
      muted: '#6b7280',
      border: '#d9d9d3',
      hover: '#e7e7e2',
      selection: '#cfe0f7',
      accent: '#a86a12',
      ok: '#2f855a',
      error: '#c53030',
      strudel: '#b7651b',
      tidal: '#2b6cb0',
      keyword: '#8250df',
      string: '#0a7f3f',
      number: '#b35900',
      comment: '#8b949e',
      function: '#0550ae',
      property: '#953800',
      type: '#7a5c00',
      operator: '#0e7490',
    },
  },
  {
    // Peat, gorse and heather.
    id: 'bog',
    name: 'Bog',
    dark: true,
    palette: {
      bg: '#1b1f1a',
      panel: '#20251f',
      fg: '#d9d6c7',
      muted: '#8a8a76',
      border: '#2e352c',
      hover: '#283026',
      selection: '#34402f',
      accent: '#c97fae',
      ok: '#8fbf6a',
      error: '#d9725b',
      strudel: '#d99a5b',
      tidal: '#7fb3a8',
      keyword: '#c9a0dc',
      string: '#a3c47a',
      number: '#e0a96d',
      comment: '#7d806c',
      function: '#8cc0c9',
      property: '#d98b6f',
      type: '#e2c275',
      operator: '#9fc5b0',
    },
  },
  {
    // Manuscript: parchment, iron-gall ink and red initials.
    id: 'vellum',
    name: 'Vellum',
    dark: false,
    palette: {
      bg: '#f6f0e1',
      panel: '#efe6d2',
      fg: '#2e2618',
      muted: '#7a6d55',
      border: '#dccfb3',
      hover: '#e8dcc2',
      selection: '#e6d3a8',
      accent: '#9b2c2c',
      ok: '#4a7a2c',
      error: '#b02a2a',
      strudel: '#a0521d',
      tidal: '#2c5a8a',
      keyword: '#7b2d8b',
      string: '#3f6f1f',
      number: '#a0521d',
      comment: '#9a8b6d',
      function: '#1f4f8a',
      property: '#8b3a1e',
      type: '#806000',
      operator: '#2d6a6a',
    },
  },
];

const byId = (id: string) => THEMES.find((theme) => theme.id === id);

/** The theme a setting means now ("auto" follows the system's light or dark). */
export function resolveTheme(setting: string): Theme {
  const systemDark = typeof matchMedia === 'undefined' || matchMedia('(prefers-color-scheme: dark)').matches;
  return byId(setting) ?? byId(systemDark ? 'dark' : 'light')!;
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

function paletteCss(theme: Theme) {
  const vars = Object.entries(theme.palette).map(([name, value]) => `  --${kebab(name)}: ${value};`);
  return `:root {\n${vars.join('\n')}\n  color-scheme: ${theme.dark ? 'dark' : 'light'};\n}`;
}

function styleElement(id: string) {
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.append(el);
  }
  return el;
}

let systemListener: (() => void) | null = null;

/**
 * Puts a theme's palette on the page, then the user's CSS after it so it
 * wins. With "auto", follows the system as it changes. `onChange` runs after
 * each change, for things that copy colours (Strudel's visuals).
 */
export function applyTheme(setting: string, userCss: string | null, onChange: () => void) {
  const apply = () => {
    const theme = resolveTheme(setting);
    styleElement('uaithne-theme').textContent = paletteCss(theme);
    const user = styleElement('uaithne-user-theme');
    user.textContent = userCss ?? '';
    // Keep the user's sheet last, after any style a library added since.
    document.head.append(user);
    document.documentElement.dataset.theme = theme.id;
    onChange();
  };
  const media = typeof matchMedia === 'undefined' ? null : matchMedia('(prefers-color-scheme: dark)');
  if (systemListener) media?.removeEventListener('change', systemListener);
  systemListener = setting === 'auto' ? apply : null;
  if (systemListener) media?.addEventListener('change', systemListener);
  apply();
}

const v = (name: string) => `var(--${name})`;

/** The editor's look, from the palette's variables (so it follows theme changes). */
export const editorTheme = [
  EditorView.theme({
    '&': { color: v('fg'), backgroundColor: v('bg') },
    '&.cm-focused': { outline: 'none' },
    // Vim's block cursor (.cm-editor outranks the vim extension's own colour).
    '&.cm-editor .cm-fat-cursor': { background: `color-mix(in srgb, ${v('accent')} 70%, transparent)`, color: v('bg') },
    '&.cm-editor:not(.cm-focused) .cm-fat-cursor': { background: 'none', outline: `1px solid ${v('accent')}` },
    '.cm-content': { caretColor: v('accent') },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: v('accent') },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      { backgroundColor: v('selection') },
    '.cm-activeLine': { backgroundColor: `color-mix(in srgb, ${v('hover')} 55%, transparent)` },
    '.cm-activeLineGutter': { backgroundColor: v('hover'), color: v('fg') },
    '.cm-gutters': { backgroundColor: v('bg'), color: v('muted'), border: 'none' },
    '.cm-foldPlaceholder': { backgroundColor: 'transparent', border: 'none', color: v('muted') },
    '.cm-selectionMatch': { backgroundColor: `color-mix(in srgb, ${v('accent')} 18%, transparent)` },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: `color-mix(in srgb, ${v('accent')} 25%, transparent)`, outline: 'none' },
    '&.cm-focused .cm-nonmatchingBracket': { color: v('error') },
    '.cm-searchMatch': { backgroundColor: `color-mix(in srgb, ${v('accent')} 25%, transparent)`, outline: `1px solid ${v('accent')}` },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: `color-mix(in srgb, ${v('accent')} 45%, transparent)` },
    '.cm-panels': { backgroundColor: v('panel'), color: v('fg') },
    '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${v('border')}` },
    '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${v('border')}` },
    '.cm-tooltip': { backgroundColor: v('panel'), color: v('fg'), border: `1px solid ${v('border')}` },
    '.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: v('border'), borderBottomColor: v('border') },
    '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: v('panel'), borderBottomColor: v('panel') },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: v('selection'), color: v('fg') },
    '.cm-completionDetail': { color: v('muted') },
    '.cm-completionMatchedText': { textDecoration: 'none', color: v('accent') },
    '.cm-diagnostic-error': { borderLeftColor: v('error') },
    '.cm-lintRange-error': {
      backgroundImage: 'none',
      textDecoration: `underline wavy ${v('error')}`,
      textUnderlineOffset: '3px',
    },
  }),
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword], color: v('keyword') },
      { tag: [t.string, t.special(t.string), t.regexp, t.character], color: v('string') },
      { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.name)], color: v('number') },
      { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: v('comment'), fontStyle: 'italic' },
      { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: v('function') },
      { tag: [t.propertyName, t.attributeName], color: v('property') },
      { tag: [t.typeName, t.className, t.namespace, t.self], color: v('type') },
      { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.compareOperator], color: v('operator') },
      { tag: [t.punctuation, t.bracket, t.separator], color: v('muted') },
      { tag: [t.variableName, t.definition(t.variableName)], color: v('fg') },
      { tag: t.invalid, color: v('error') },
    ]),
  ),
];
