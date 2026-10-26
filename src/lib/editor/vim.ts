// Uaithne's vim ex commands, and the user's mappings from uaithne.toml.
// Vim.defineEx and Vim.map are global, not per editor.

import type { EditorView } from '@codemirror/view';
import { Vim } from '@replit/codemirror-vim';

import type { App } from '$lib/app.svelte';

let defined = false;

export function defineExCommands(app: App) {
  if (defined) return;
  defined = true;
  const tracks = app.tracks;
  const active = (fn: (path: string) => unknown) => () => {
    if (tracks.active) void fn(tracks.active);
  };
  const ex = (name: string, prefix: string, fn: (arg: string) => unknown) =>
    Vim.defineEx(name, prefix, (_cm, params) => void fn(params.argString?.trim() ?? ''));

  // :w saves and runs, like Ctrl+Enter (evaluating always saves first).
  ex('write', 'w', () => app.evaluate('main'));
  ex('wall', 'wa', () => tracks.saveAll());
  ex('edit', 'e', (arg) => (arg ? app.openOrCreate(arg) : (app.quickSwitcherOpen = true)));
  ex('new', 'new', (arg) => (arg ? app.openOrCreate(arg) : app.newTrackPrompt()));
  ex('ls', 'ls', () => (app.quickSwitcherOpen = true));
  ex('bnext', 'bn', () => tracks.cycle(1));
  ex('bprevious', 'bp', () => tracks.cycle(-1));
  ex('bdelete', 'bd', active((p) => tracks.close(p)));
  ex('quit', 'q', active((p) => app.quit(p)));
  ex('rename', 'ren', active((p) => app.renamePrompt(p)));
  ex('hush', 'hush', () => app.hush(true));
  ex('packs', 'packs', () => (app.samples.managerOpen = true));
  ex('tidal', 'tidal', () => (app.tidalOpen = true));
  // :h jux looks it up; :h alone opens the reference on its search box.
  ex('help', 'h', (arg) => (arg ? app.reference.show(arg) : app.reference.toggle()));
  ex('keys', 'keys', () => (app.helpOpen = true));
  ex('viz', 'viz', () => app.toggleVisuals());
  ex('rec', 'rec', () => app.toggleRecording());
  ex('settings', 'settings', () => (app.settingsOpen = true));

  // K: look up the word under the cursor, as vim's keywordprg would.
  Vim.defineAction('uaithneLookup', (cm: { cm6: EditorView }) => {
    const state = cm.cm6.state;
    const word = state.wordAt(state.selection.main.head);
    if (word) app.reference.show(state.sliceDoc(word.from, word.to));
  });
  Vim.mapCommand('K', 'action', 'uaithneLookup', {}, { context: 'normal' });
}

const MAP_COMMANDS: Record<string, { noremap: boolean; context?: string }> = {
  map: { noremap: false },
  nmap: { noremap: false, context: 'normal' },
  vmap: { noremap: false, context: 'visual' },
  xmap: { noremap: false, context: 'visual' },
  imap: { noremap: false, context: 'insert' },
  noremap: { noremap: true },
  nnoremap: { noremap: true, context: 'normal' },
  vnoremap: { noremap: true, context: 'visual' },
  xnoremap: { noremap: true, context: 'visual' },
  inoremap: { noremap: true, context: 'insert' },
};

/** The mappings applied last, so a new set replaces them. */
let applied: { lhs: string; context?: string }[] = [];

/**
 * Applies vimrc-style mappings ("inoremap jk <Esc>", "nnoremap <leader>w :w<CR>"),
 * replacing the ones applied before. Returns a message per line it couldn't use.
 */
export function applyVimMappings(lines: string[], leader: string): string[] {
  for (const { lhs, context } of applied) {
    try {
      Vim.unmap(lhs, context as string);
    } catch {}
  }
  applied = [];
  const leaderKey = leader === ' ' ? '<Space>' : leader || '\\';
  const problems: string[] = [];
  // CodeMirror's vim acts on a complete command at once rather than waiting
  // to see if a longer mapping follows, so a leader that's already a command
  // (Space moves right, "," repeats a search) would hide the mappings. Drop
  // its own meaning, as `nnoremap <Space> <Nop>` would in vim.
  if (lines.some((line) => /<leader>/i.test(line))) Vim.unmap(leaderKey, undefined as unknown as string);
  for (const line of lines) {
    const match = line.trim().match(/^(\w+)\s+(\S+)\s+(.+)$/);
    const kind = match && MAP_COMMANDS[match[1]];
    if (!match || !kind) {
      problems.push(`"${line}": expected e.g. "nnoremap <leader>w :w<CR>" (map, nmap, vmap, imap or a noremap form)`);
      continue;
    }
    const lhs = match[2].replace(/<leader>/gi, leaderKey);
    const rhs = match[3].trim().replace(/<leader>/gi, leaderKey);
    try {
      if (kind.noremap) Vim.noremap(lhs, rhs, kind.context as string);
      else Vim.map(lhs, rhs, kind.context as string);
      applied.push({ lhs, context: kind.context });
    } catch (err) {
      problems.push(`"${line}": ${err}`);
    }
  }
  return problems;
}
