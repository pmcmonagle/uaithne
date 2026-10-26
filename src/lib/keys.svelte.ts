// The app's rebindable shortcuts. Each command has default keys; the user's
// changes (made in the help window) are saved per machine in the settings as
// { commandId: ["Ctrl+K", …] }. Keys are written "Ctrl+Alt+Shift+Key", with
// punctuation and letters named by their place on the keyboard (e.code), so
// Ctrl+Shift+. is the same keys whatever Shift turns "." into.

export type CommandId =
  | 'evaluate'
  | 'evaluateLine'
  | 'hush'
  | 'hushAll'
  | 'record'
  | 'switcher'
  | 'reference'
  | 'log'
  | 'visuals'
  | 'settings'
  | 'help'
  | 'volumeUp'
  | 'volumeDown'
  | 'mute';

export interface Command {
  id: CommandId;
  group: 'Playing' | 'Tracks and panels' | 'Volume';
  does: string;
  defaults: string[];
}

export const COMMANDS: Command[] = [
  { id: 'evaluate', group: 'Playing', does: 'Evaluate: the whole track in Strudel, the block under the cursor in Tidal', defaults: ['Ctrl+Enter'] },
  { id: 'evaluateLine', group: 'Playing', does: 'Evaluate the current line, or the selection', defaults: ['Shift+Enter'] },
  { id: 'hush', group: 'Playing', does: "Hush the current track's engine", defaults: ['Ctrl+.'] },
  { id: 'hushAll', group: 'Playing', does: 'Hush both engines', defaults: ['Ctrl+Shift+.'] },
  { id: 'record', group: 'Playing', does: 'Start or stop recording to recordings/ (one file per engine)', defaults: ['Ctrl+Shift+R'] },
  { id: 'switcher', group: 'Tracks and panels', does: 'Switch tracks (type a new name to create one)', defaults: ['Ctrl+P'] },
  { id: 'reference', group: 'Tracks and panels', does: 'Show or hide the reference', defaults: ['Ctrl+K'] },
  { id: 'log', group: 'Tracks and panels', does: 'Show or hide the log', defaults: ['Ctrl+`'] },
  { id: 'visuals', group: 'Tracks and panels', does: 'Show or hide the visuals (Strudel punchcard, pianoroll, scope…)', defaults: ['Ctrl+J'] },
  { id: 'settings', group: 'Tracks and panels', does: 'Settings (theme, MIDI and OSC out)', defaults: ['Ctrl+,'] },
  { id: 'help', group: 'Tracks and panels', does: 'Keyboard shortcuts and commands (this window)', defaults: ['Ctrl+H', 'F1'] },
  { id: 'volumeUp', group: 'Volume', does: 'Volume up', defaults: ['Ctrl+Alt+Up'] },
  { id: 'volumeDown', group: 'Volume', does: 'Volume down', defaults: ['Ctrl+Alt+Down'] },
  { id: 'mute', group: 'Volume', does: 'Mute or unmute', defaults: ['Ctrl+Alt+M'] },
];

const PUNCTUATION: Record<string, string> = {
  Period: '.',
  Comma: ',',
  Backquote: '`',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
};

const NAMES: Record<string, string> = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Esc: 'Escape' };

/** The key itself, without modifiers, or null for a lone modifier. */
function keyName(e: KeyboardEvent): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return null;
  const letter = e.code.match(/^Key([A-Z])$/)?.[1] ?? e.code.match(/^Digit(\d)$/)?.[1];
  if (letter) return letter;
  if (PUNCTUATION[e.code]) return PUNCTUATION[e.code];
  return NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
}

/** A key press as a binding, e.g. "Ctrl+Shift+R"; null for a lone modifier. */
export function eventKeys(e: KeyboardEvent): string | null {
  const key = keyName(e);
  if (!key) return null;
  const mods = [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  return [...mods, key].join('+');
}

/** Tidies a binding as typed in settings ("ctrl+shift+r" → "Ctrl+Shift+R"). */
export function normalise(keys: string): string {
  const parts = keys.split(/\+(?!$)/).map((p) => p.trim());
  const key = parts.pop() ?? '';
  const has = (m: string) => parts.some((p) => p.toLowerCase() === m.toLowerCase() || (m === 'Ctrl' && /^(control|cmd|meta)$/i.test(p)));
  const named = Object.values(NAMES).find((n) => n.toLowerCase() === key.toLowerCase());
  const name = named ?? (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));
  return [has('Ctrl') && 'Ctrl', has('Alt') && 'Alt', has('Shift') && 'Shift', name].filter(Boolean).join('+');
}

/**
 * Whether keys can be a shortcut: plain typing keys can't, so it needs Ctrl
 * or Alt, or to be a function key (or Shift+Enter, which is free in code).
 */
export function bindable(keys: string): boolean {
  return /^(Ctrl|Alt)\+/.test(keys) || /(^|\+)F\d{1,2}$/.test(keys) || keys === 'Shift+Enter';
}

/** For showing: arrows as arrows. */
export const showKeys = (keys: string) => keys.replace(/\bUp$/, '↑').replace(/\bDown$/, '↓').replace(/\bLeft$/, '←').replace(/\bRight$/, '→');

class Keymap {
  /** The user's changes: commands not listed keep their defaults. */
  overrides = $state<Record<string, string[]>>({});

  keysFor(id: CommandId): string[] {
    const command = COMMANDS.find((c) => c.id === id)!;
    return this.overrides[id] ?? command.defaults;
  }

  /** The first key for a command, for hints ("Ctrl+K"), or '' if it has none. */
  hint(id: CommandId): string {
    return showKeys(this.keysFor(id)[0] ?? '');
  }

  /** The command bound to a key press, if any. */
  commandFor(e: KeyboardEvent): CommandId | null {
    const keys = eventKeys(e);
    if (!keys) return null;
    return COMMANDS.find((c) => this.keysFor(c.id).includes(keys))?.id ?? null;
  }

  isChanged(id: CommandId): boolean {
    return id in this.overrides;
  }

  /** Overrides with keys tidied and unknown commands dropped (from settings). */
  load(saved: Record<string, string[]> | undefined) {
    const clean: Record<string, string[]> = {};
    for (const [id, keys] of Object.entries(saved ?? {})) {
      if (COMMANDS.some((c) => c.id === id) && Array.isArray(keys)) clean[id] = keys.map(normalise).filter(bindable);
    }
    this.overrides = clean;
  }

  /**
   * Binds `keys` to a command, replacing its keys, and takes them from any
   * command that had them. Returns the commands that lost them.
   */
  bind(id: CommandId, keys: string): CommandId[] {
    const next = { ...this.overrides };
    const lost: CommandId[] = [];
    for (const c of COMMANDS) {
      if (c.id === id || !this.keysFor(c.id).includes(keys)) continue;
      next[c.id] = this.keysFor(c.id).filter((k) => k !== keys);
      lost.push(c.id);
    }
    next[id] = [keys];
    this.overrides = next;
    this.tidy();
    return lost;
  }

  /** Back to the default keys, taking them from any command that has them now. */
  reset(id: CommandId) {
    const defaults = COMMANDS.find((c) => c.id === id)!.defaults;
    const next = { ...this.overrides };
    delete next[id];
    for (const c of COMMANDS) {
      const keys = this.keysFor(c.id);
      if (c.id !== id && keys.some((k) => defaults.includes(k))) next[c.id] = keys.filter((k) => !defaults.includes(k));
    }
    this.overrides = next;
    this.tidy();
  }

  /** Drops overrides that match the defaults again. */
  private tidy() {
    const next = { ...this.overrides };
    for (const c of COMMANDS) {
      if (next[c.id] && next[c.id].join() === c.defaults.join()) delete next[c.id];
    }
    this.overrides = next;
  }
}

export const keymap = new Keymap();
