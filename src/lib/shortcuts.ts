// The fixed shortcuts and the ex commands, for the help window (Ctrl+H).
// The rebindable app shortcuts are in keys.svelte.ts. These keys are handled
// in editor/editor.ts, editor/vim.ts and the panels; keep this list in step.

export interface Shortcut {
  keys: string[];
  does: string;
}

export interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

export const shortcutGroups: ShortcutGroup[] = [
  {
    title: 'Editor',
    items: [
      { keys: ['K'], does: 'Look up the word under the cursor (vim normal mode)' },
      { keys: ['Ctrl+Space'], does: 'Show completions' },
      { keys: ['Esc'], does: 'Hide the signature hint (and leave insert mode)' },
      { keys: ['Ctrl+/'], does: 'Comment or uncomment the line' },
    ],
  },
  {
    title: 'Lists (switcher, reference, samples)',
    items: [
      { keys: ['↑', '↓'], does: 'Move' },
      { keys: ['Enter'], does: 'Open, or insert the sound' },
      { keys: ['Esc'], does: 'Back, or close' },
    ],
  },
];

export const exCommands: Shortcut[] = [
  { keys: [':w'], does: 'Save and evaluate (like the Evaluate shortcut)' },
  { keys: [':wa'], does: 'Save all tracks' },
  { keys: [':e name', ':ls'], does: 'Open or create a track; with no name, the switcher' },
  { keys: [':new name.tidal'], does: 'Create a track' },
  { keys: [':bn', ':bp'], does: 'Next / previous open track' },
  { keys: [':bd'], does: 'Close the track' },
  { keys: [':q'], does: "Stop the track if it's playing, otherwise close it" },
  { keys: [':ren'], does: 'Rename the track' },
  { keys: [':hush'], does: 'Hush both engines' },
  { keys: [':h name', ':h'], does: 'Look up a function; with no name, open the reference' },
  { keys: [':keys'], does: 'This help' },
  { keys: [':viz'], does: 'Show or hide the visuals' },
  { keys: [':rec'], does: 'Start or stop recording' },
  { keys: [':settings'], does: 'Settings (theme, MIDI and OSC out)' },
  { keys: [':packs'], does: 'Download sample packs' },
  { keys: [':tidal'], does: 'Tidal status and setup' },
];
