#!/usr/bin/env node
// Generates reference/strudel.json from the JSDoc in the installed @strudel
// packages and superdough, the same comments strudel.cc's reference is built
// from. Curated tags and fixes come from reference/strudel.overrides.json.
//
//   node tools/gen-strudel-ref.mjs

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modules = join(root, 'node_modules');
const packages = ['@strudel/core', '@strudel/mini', '@strudel/tonal', '@strudel/webaudio', '@strudel/draw', '@strudel/soundfonts', 'superdough'];

/** Default tag per source file. */
const FILE_TAGS = {
  controls: 'controls',
  signal: 'signals',
  euclid: 'rhythm',
  pick: 'pick',
  tonal: 'harmony',
  voicings: 'harmony',
  pianoroll: 'visuals',
  spiral: 'visuals',
  pitchwheel: 'visuals',
  scope: 'visuals',
  spectrum: 'visuals',
  drawLine: 'visuals',
  superdough: 'sound',
  sampler: 'samples',
  repl: 'setup',
  impure: 'setup',
};

/** Tags by name, roughly following strudel.cc's "learn" pages. */
const NAME_TAGS = {
  time: 'fast slow early late hurry ply segment compress zoom linger fastGap inside outside cpm swing swingBy rev palindrome iter iterBack ribbon off chunk chunkBack fastChunk brak press pressBy rotate',
  random: 'rand rand2 irand perlin choose chooseCycles chooseInWith randcat wchoose wchooseCycles wrandcat degrade degradeBy undegradeBy sometimes sometimesBy often rarely almostNever almostAlways always never someCycles someCyclesBy shuffle scramble brand brandBy',
  conditional: 'firstOf lastOf when every chunk struct mask euclid euclidRot euclidLegato while arp arpWith inhabit pick squeeze reset restart',
  accumulation: 'superimpose layer off echo echoWith stut stutWith jux juxBy',
  structure: 'stack cat seq fastcat slowcat timeCat arrange polymeter polymeterSteps sequence run binary binaryN silence pure',
  effects: 'room size delay delaytime delayfeedback crush coarse shape distort vowel phaser tremolo leslie orbit pan gain velocity postgain compressor',
  filters: 'lpf hpf bpf lpq hpq bpq djf ftype lpenv hpenv bpenv lpattack lpdecay lpsustain lprelease',
  envelope: 'attack decay sustain release adsr legato clip',
  samples: 's sound n bank begin end loop loopBegin loopEnd cut speed unit striate chop slice splice fit loopAt samples',
  tonal: 'note freq scale scaleTranspose transpose voicing chord rootNotes mode anchor dict octave',
};

/** Wording that's true of strudel.cc but not Uaithne. */
const TEXT_FIXES = [['displayed in the background of the editor', 'displayed in the visuals panel (Ctrl+J)']];
const fixText = (text) => TEXT_FIXES.reduce((t, [from, to]) => t.replaceAll(from, to), text);

function tagsFor(name, file) {
  const tags = new Set();
  const fromFile = FILE_TAGS[file];
  if (fromFile) tags.add(fromFile);
  for (const [tag, names] of Object.entries(NAME_TAGS)) {
    if (names.split(' ').includes(name)) tags.add(tag);
  }
  if (!tags.size) tags.add('pattern');
  return [...tags];
}

/** All JSDoc blocks in a source file, with the line of code that follows each. */
function blocks(source) {
  const out = [];
  const re = /\/\*\*([\s\S]*?)\*\/\s*\n?([^\n]*)/g;
  for (const m of source.matchAll(re)) {
    const body = m[1]
      .split('\n')
      .map((l) => l.replace(/^\s*\* ?/, ''))
      .join('\n')
      .trim();
    out.push({ body, next: m[2] });
  }
  return out;
}

/** Splits a JSDoc body into its description and `@tag value` pairs. */
function parse(body) {
  const parts = body.split(/^(?=@\w)/m);
  const description = parts[0].startsWith('@') ? '' : parts.shift().trim();
  const tags = parts.map((p) => {
    const m = p.match(/^@(\w+)\s?([\s\S]*)$/);
    return { tag: m[1], value: m[2].replace(/\s+$/, '') };
  });
  return { description, tags };
}

/** `{number | Pattern} factor speed up factor` → param. */
function param(value) {
  const m = value.match(/^(?:\{([^}]*)\}\s*)?(\[?[\w.$]+(?:=[^\]]*)?\]?)?\s*-?\s*([\s\S]*)$/);
  if (!m) return { name: value };
  const name = (m[2] ?? '').replace(/^\[|\]$/g, '').replace(/=.*$/, '');
  return { name, type: m[1]?.trim() || undefined, doc: m[3]?.trim() || undefined };
}

function nameFromCode(line) {
  const m =
    line.match(/export\s+(?:const|let|function\*?|async function)\s+(\w+)/) ??
    line.match(/export\s+const\s+\{\s*(\w+)/) ??
    line.match(/^\s*(\w+)\s*\(/);
  return m?.[1];
}

function synopsisOf(description) {
  const text = description.replace(/\s+/g, ' ').trim();
  const sentence = text.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? text;
  return sentence.length > 160 ? sentence.slice(0, 157) + '…' : sentence;
}

function signatureOf(name, params, memberof) {
  const args = params.map((p) => p.name).filter(Boolean);
  // Most functions also work as methods on a pattern; show the method form.
  return memberof === 'Pattern' || args.length ? `${name}(${args.join(', ')})` : name;
}

const entries = new Map();
for (const pkg of packages) {
  const dir = join(modules, pkg);
  if (!existsSync(dir)) continue;
  for (const fileName of readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
    const file = basename(fileName, '.mjs');
    for (const { body, next } of blocks(readFileSync(join(dir, fileName), 'utf8'))) {
      const parsed = parse(body);
      const tags = parsed.tags;
      const description = fixText(parsed.description);
      const get = (t) => tags.filter((x) => x.tag === t).map((x) => x.value);
      if (get('noAutocomplete').length || get('private').length) continue;
      const name = get('name')[0]?.trim() ?? nameFromCode(next);
      if (!name || !/^[\w$]+$/.test(name) || name.startsWith('_')) continue;
      const examples = get('example').map((e) => e.trim()).filter(Boolean);
      if (!description && !examples.length) continue;
      const params = get('param').map(param);
      const memberof = get('memberof')[0]?.trim();
      const aliases = get('synonyms')
        .flatMap((s) => s.split(','))
        .map((s) => s.trim())
        .filter((s) => s && s !== name);
      const entry = {
        name,
        aliases: aliases.length ? aliases : undefined,
        signature: signatureOf(name, params, memberof),
        params: params.length ? params : undefined,
        synopsis: synopsisOf(description),
        description,
        examples,
        tags: tagsFor(name, file),
        deprecated: get('deprecated').length ? true : undefined,
        source: `${pkg}/${fileName}`,
      };
      // Keep the better documented of duplicate names.
      const old = entries.get(name);
      if (!old || old.description.length + old.examples.length * 80 < description.length + examples.length * 80) {
        entries.set(name, entry);
      }
    }
  }
}

// Curated fixes: { "name": { ...fields to replace } }, or null to drop one.
const overridesPath = join(root, 'reference', 'strudel.overrides.json');
if (existsSync(overridesPath)) {
  const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
  for (const [name, patch] of Object.entries(overrides)) {
    if (name.startsWith('$')) continue;
    if (patch === null) entries.delete(name);
    else entries.set(name, { name, synopsis: '', description: '', examples: [], tags: [], ...entries.get(name), ...patch });
  }
}

const sorted = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
const version = JSON.parse(readFileSync(join(modules, '@strudel/core/package.json'), 'utf8')).version;
const out = { language: 'strudel', version: `@strudel/core ${version}`, entries: sorted };
writeFileSync(join(root, 'reference', 'strudel.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`reference/strudel.json: ${sorted.length} entries, ${sorted.reduce((n, e) => n + e.examples.length, 0)} examples`);
