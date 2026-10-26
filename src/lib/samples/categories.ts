// Browsing categories for sounds. Packs carry no category data, so these come
// from, in order: the folder a local sound sits in (samples/local/<category>/…),
// hand-made tags for the catalogue packs (tags.json), drum-machine naming
// (<Machine>_<part>), and finally guesses from the sound's name.
// Categories only affect the browser; they never change a sound's name.

import type { Sound } from '$lib/ipc';
import tags from './tags.json';

export const CATEGORIES = [
  'Drums',
  'Percussion',
  'Bass',
  'Synth',
  'Keys',
  'Mallets',
  'Strings',
  'Winds',
  'Vocal',
  'FX',
  'Breaks & Loops',
] as const;
export const OTHER = 'Other';

export interface Placement {
  category: string;
  /** Optional sub-group, e.g. the drum machine. */
  group?: string;
  /** Shorter label for use inside the group (`bd` for `RolandTR909_bd`). */
  label?: string;
}

const soundTags = new Map<string, string>();
for (const [pack, categories] of Object.entries(tags.sounds)) {
  for (const [category, names] of Object.entries(categories)) {
    for (const name of names) soundTags.set(`${pack}/${name}`, category);
  }
}
const packTags: Record<string, string> = tags.packs;
const machinePacks = new Set(tags.machinePacks);

/** Folder names people are likely to use, mapped to the built-in categories. */
const FOLDER_ALIASES: Record<string, string> = {
  drum: 'Drums',
  kit: 'Drums',
  kits: 'Drums',
  perc: 'Percussion',
  basses: 'Bass',
  synths: 'Synth',
  key: 'Keys',
  piano: 'Keys',
  mallet: 'Mallets',
  string: 'Strings',
  guitar: 'Strings',
  wind: 'Winds',
  brass: 'Winds',
  vox: 'Vocal',
  vocals: 'Vocal',
  voice: 'Vocal',
  sfx: 'FX',
  breaks: 'Breaks & Loops',
  loops: 'Breaks & Loops',
  break: 'Breaks & Loops',
  loop: 'Breaks & Loops',
};

const GUESSES: [RegExp, string][] = [
  [/break|loop|amen/, 'Breaks & Loops'],
  [/^(bd|sd|sn|hh|oh|ch|cp|rim|rs|lt|mt|ht|cr|rd|cy|cb)(\d|_|$)|kick|snare|hat|clap|tom|cymbal|crash|ride|drum/, 'Drums'],
  [/bass|sub/, 'Bass'],
  [/perc|conga|bongo|shak|tamb|cowbell|clave|tabla|wood/, 'Percussion'],
  [/piano|organ|rhodes|keys|clav/, 'Keys'],
  [/marimba|xylo|vibra|glock|kalimba|bell/, 'Mallets'],
  [/gtr|guitar|string|violin|cello|harp|sitar/, 'Strings'],
  [/sax|trump|flute|horn|brass|reed/, 'Winds'],
  [/pad|synth|lead|stab|arp|saw|square|sine|juno|moog/, 'Synth'],
  [/vox|vocal|voice|speech|choir|word/, 'Vocal'],
  [/fx|noise|riser|sweep|impact|hit/, 'FX'],
];

export function categoryFromFolder(folder: string): string {
  const lower = folder.toLowerCase();
  const builtin = CATEGORIES.find((c) => c.toLowerCase() === lower || `${c.toLowerCase()}s` === lower);
  if (builtin) return builtin;
  if (FOLDER_ALIASES[lower]) return FOLDER_ALIASES[lower];
  return folder.charAt(0).toUpperCase() + folder.slice(1);
}

export function guessCategory(name: string): string {
  const lower = name.toLowerCase();
  return GUESSES.find(([re]) => re.test(lower))?.[1] ?? OTHER;
}

export function place(sound: Sound): Placement {
  if (sound.origin === 'local') {
    // samples/local/[category/[group/…]]<sound>/<file>
    const folders = sound.files[0].split('/').slice(2, -2);
    if (folders.length) {
      return { category: categoryFromFolder(folders[0]), group: folders.slice(1).join('/') || undefined };
    }
    return { category: guessCategory(sound.name) };
  }
  const tagged = soundTags.get(`${sound.origin}/${sound.name}`);
  if (tagged) return { category: tagged };
  if (machinePacks.has(sound.origin)) {
    const split = sound.name.indexOf('_');
    if (split > 0) {
      return { category: 'Drums', group: sound.name.slice(0, split), label: sound.name.slice(split + 1) };
    }
  }
  if (packTags[sound.origin]) return { category: packTags[sound.origin] };
  return { category: guessCategory(sound.name) };
}

/** Built-in categories in their fixed order, then custom ones A–Z, then Other. */
export function compareCategories(a: string, b: string): number {
  const rank = (c: string) => {
    const i = (CATEGORIES as readonly string[]).indexOf(c);
    return i >= 0 ? i : c === OTHER ? 1000 : 500;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}
