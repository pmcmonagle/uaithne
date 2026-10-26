#!/usr/bin/env node
// Generates reference/tidal.json for the Tidal installed here, in three layers:
//   1. GHCi's `:browse Sound.Tidal.Context`: every name in scope, with its
//      exact type in this version (plus the names Uaithne's BootTidal.hs defines);
//   2. the Haddock comments in that version's source;
//   3. the tidalcycles.org reference pages (github.com/tidalcycles/tidal-doc),
//      whose prose, examples and page titles (as tags) win where they exist.
// Curated entries and fixes come from reference/tidal.overrides.json.
//
//   node tools/gen-tidal-ref.mjs [--ghci ghci] [--doc path/to/tidal-doc] [--src path/to/tidal-x.y.z]
//
// Without --doc or --src, both are fetched into tools/.cache.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, 'tools', '.cache');
const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const ghci = arg('--ghci') ?? 'ghci';

function run(cmd, args, input) {
  return execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
}

// ---- 1. names and types from GHCi -----------------------------------------

const version = run(ghci, ['-ignore-dot-ghci', '-v0'], 'import Sound.Tidal.Context\nputStrLn Sound.Tidal.Version.tidal_version\n').trim();
const browse = run(ghci, ['-ignore-dot-ghci', '-v0'], ':set -XOverloadedStrings\nimport Sound.Tidal.Context\n:browse Sound.Tidal.Context\n');

/** One line, without package and module qualifiers (`Sound.Tidal.ID.ID` → `ID`). */
function tidyType(type) {
  return type
    .replace(/\s+/g, ' ')
    .replace(/\b[\w-]+-[\d.]+:/g, '')
    .replace(/\b(?:[A-Z]\w*\.)+(?=[A-Z])/g, '')
    .trim();
}

/** name → type, for values (not types, classes or their fields). */
const types = new Map();
{
  const decls = [];
  for (const line of browse.split('\n')) {
    if (/^\s/.test(line) && decls.length) decls[decls.length - 1] += ' ' + line.trim();
    else if (line.trim()) decls.push(line);
  }
  for (const decl of decls) {
    if (/^(type|data|newtype|class|instance|pattern)\b/.test(decl)) continue;
    const m = decl.match(/^\(?([^\s()]+?)\)?\s+::\s+([\s\S]+)$/);
    if (!m) continue;
    const name = m[1].replace(/^Sound\.Tidal\.Context\./, '');
    types.set(name, tidyType(m[2]));
  }
}

// Names Uaithne's BootTidal.hs defines (d1, hush, xfade, …), typed by GHCi too.
const bootFile = readFileSync(join(root, 'src-tauri', 'resources', 'tidal', 'BootTidal.hs'), 'utf8');
const bootNames = [...bootFile.matchAll(/^(?:let |    )([a-z]\w*'?) [^=]*=/gm)].map((m) => m[1]);
{
  const script = bootFile
    .replace(/\{\{port\}\}/g, '57120')
    .replace(/\{\{highlight_port\}\}/g, '0')
    .replace(/^tidal <- .*$/m, 'tidal <- startStream (defaultConfig {cCtrlListen = False}) []');
  const typed = run(ghci, ['-ignore-dot-ghci', '-v0'], script + '\n' + bootNames.map((n) => `:t ${n}`).join('\n') + '\n');
  const lines = [];
  for (const line of typed.split('\n')) {
    if (/^\s/.test(line) && lines.length) lines[lines.length - 1] += ' ' + line.trim();
    else if (line.trim()) lines.push(line);
  }
  for (const line of lines) {
    const m = line.match(/^([a-z]\w*'?) :: (.+)$/);
    if (m && bootNames.includes(m[1])) types.set(m[1], tidyType(m[2]));
  }
}

// ---- 2. Haddock comments from the source ----------------------------------

function tidalSource() {
  const given = arg('--src');
  if (given) return given;
  const dir = join(cache, `tidal-${version}`);
  if (existsSync(dir)) return dir;
  mkdirSync(cache, { recursive: true });
  const local = join(homedir(), '.cabal', 'packages', 'hackage.haskell.org', 'tidal', version, `tidal-${version}.tar.gz`);
  const tarball = existsSync(local) ? local : join(cache, `tidal-${version}.tar.gz`);
  if (!existsSync(tarball)) {
    run('curl', ['-sSfL', '-o', tarball, `https://hackage.haskell.org/package/tidal-${version}/tidal-${version}.tar.gz`]);
  }
  run('tar', ['xzf', tarball, '-C', cache]);
  return dir;
}

/** Haddock markup → markdown. Bird-track code (`> d1 $ …`) becomes fenced blocks. */
function haddockToMarkdown(text) {
  const out = [];
  let code = null;
  for (const line of text.split('\n')) {
    const bird = line.match(/^\s*>\s?(.*)$/);
    if (bird) {
      (code ??= []).push(bird[1]);
      continue;
    }
    if (code) {
      out.push('```haskell', ...code, '```');
      code = null;
    }
    out.push(
      line
        .replace(/@([^@\n]+)@/g, '`$1`')
        .replace(/'([a-z][\w']*)'/g, '`$1`')
        .replace(/"([A-Z][\w.]*)"/g, '$1')
        .replace(/(^|\s)\/([^/\n]+)\/(?=[\s.,;:]|$)/g, '$1*$2*'),
    );
  }
  if (code) out.push('```haskell', ...code, '```');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** name → markdown, from `-- |` and `{- | -}` comments before a signature. */
const haddock = new Map();
{
  const dir = join(tidalSource(), 'src', 'Sound', 'Tidal');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.hs'))) {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      let doc = null;
      let j = i;
      if (/^-- \|/.test(lines[i])) {
        doc = [lines[i].replace(/^-- \|\s?/, '')];
        for (j = i + 1; j < lines.length && /^--/.test(lines[j]); j++) doc.push(lines[j].replace(/^--\s?/, ''));
      } else if (/^\{- \|/.test(lines[i])) {
        doc = [lines[i].replace(/^\{- \|\s?/, '')];
        for (j = i + 1; j < lines.length && !/-\}\s*$/.test(lines[j - 1] ?? ''); j++) doc.push(lines[j]);
        if (doc.length && /-\}\s*$/.test(doc[doc.length - 1])) doc[doc.length - 1] = doc[doc.length - 1].replace(/\s*-\}\s*$/, '');
      }
      if (!doc) continue;
      // The signature that follows names the entry: `a, b :: …`.
      while (j < lines.length && (!lines[j].trim() || /^\{-#/.test(lines[j]))) j++;
      const sig = lines[j]?.match(/^\(?([a-z_][\w']*|[^\s\w(),]+)\)?((?:\s*,\s*\(?[\w']+\)?)*)\s*::/);
      if (!sig) continue;
      const names = [sig[1], ...sig[2].split(',').map((s) => s.replace(/[()\s]/g, '')).filter(Boolean)];
      const markdown = haddockToMarkdown(doc.join('\n'));
      for (const name of names) if (markdown && !haddock.has(name)) haddock.set(name, markdown);
      i = j;
    }
  }
}

// ---- 3. tidalcycles.org reference pages -----------------------------------

function tidalDoc() {
  const given = arg('--doc');
  if (given) return given;
  const dir = join(cache, 'tidal-doc');
  if (!existsSync(dir)) {
    mkdirSync(cache, { recursive: true });
    run('git', ['clone', '-q', '--depth', '1', 'https://github.com/tidalcycles/tidal-doc.git', dir]);
  }
  return dir;
}

/** name → { tag, signature, markdown } */
const pages = new Map();
{
  const dir = join(tidalDoc(), 'docs', 'reference');
  // Optional synths (MI UGens) and a workshop aren't the library itself.
  const skip = /^(mi-ugens|workshop|online_course|hackage|undefined)/;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md') && !skip.test(f))) {
    const text = readFileSync(join(dir, file), 'utf8');
    const title = text.match(/^title:\s*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, '') ?? file;
    const tag = title.toLowerCase();
    const body = text.replace(/^---[\s\S]*?---\n/, '');
    for (const section of body.split(/^### /m).slice(1)) {
      const [heading, ...rest] = section.split('\n');
      let markdown = rest.join('\n').split(/^##? /m)[0];
      // Headings can list several names: "### fix, unfix".
      const names = heading
        .split(/,|\s+and\s+|\//)
        .map((n) => n.replace(/[`*]/g, '').trim())
        .filter((n) => /^[a-z][\w']*$/.test(n));
      if (!names.length) continue;
      const typeLine = markdown.match(/```\w*\s*\n\s*Type:\s*([\s\S]*?)\n?```/);
      let signature;
      if (typeLine) {
        signature = typeLine[1].replace(/\s+/g, ' ').trim();
        markdown = markdown.replace(typeLine[0], '');
      }
      // Some pages open with a bare signature block instead.
      const sigBlock = markdown.match(/^\s*```\w*\s*\n\s*[\w']+ :: [^\n]*\n```/);
      if (sigBlock) markdown = markdown.slice(sigBlock[0].length);
      markdown = markdown
        .replace(/^:::\w*.*$/gm, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      for (const name of names) if (!pages.has(name)) pages.set(name, { tag, signature, markdown });
    }
  }
}

// ---- merge ----------------------------------------------------------------

/** Generated plumbing that only clutters completion. */
const noisy = (name) => /(bus|recv|Take|Count|CountTo)$/.test(name) || /^_|'$/.test(name) || /^[A-Z]/.test(name);

function synopsisOf(markdown) {
  const prose = markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentence = (prose.match(/^(.+?[.!?:])(\s|$)/)?.[1] ?? prose).replace(/:$/, '.');
  return sentence.length > 160 ? sentence.slice(0, 157) + '…' : sentence;
}

const PARAMS_TAG = 'controls';
/** Controls (`speed`, `room`, …) take one pattern and make a ControlPattern. */
const isParam = (name) => /^Pattern [\w ()]+ -> ControlPattern$/.test(types.get(name) ?? '');

// Curated: { "name": { ...fields } } adds or patches, null drops.
const overrides = JSON.parse(readFileSync(join(root, 'reference', 'tidal.overrides.json'), 'utf8'));
const missing = [];

const entries = new Map();
const names = new Set([...types.keys(), ...pages.keys()]);
for (const name of names) {
  const page = pages.get(name);
  const doc = haddock.get(name);
  const type = types.get(name);
  if (!page && !doc && noisy(name)) continue;
  // Documented, but not in this Tidal (newer, removed, or a synth name).
  if (!type && !(name in overrides)) {
    missing.push(name);
    continue;
  }
  if (!/^[a-z]/.test(name) && !page && !doc) continue; // undocumented operators
  const description = page?.markdown || doc || '';
  const tags = [page?.tag ?? (isParam(name) ? PARAMS_TAG : bootNames.includes(name) ? 'performance' : 'pattern')];
  entries.set(name, {
    name,
    signature: type ? `${name} :: ${type}` : page?.signature,
    synopsis: synopsisOf(description) || (type ? `${name} :: ${type}` : ''),
    description,
    examples: [],
    tags,
  });
}

for (const [name, patch] of Object.entries(overrides)) {
  if (name.startsWith('$')) continue;
  if (patch === null) {
    entries.delete(name);
    continue;
  }
  const base = entries.get(name) ?? { name, synopsis: '', description: '', examples: [], tags: [] };
  const merged = { ...base, ...patch };
  if (!merged.synopsis) merged.synopsis = synopsisOf(merged.description);
  entries.set(name, merged);
}
// Aliases point at entries; drop alias entries that only repeat their target.
for (const entry of entries.values()) for (const alias of entry.aliases ?? []) entries.delete(alias);

const sorted = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
const out = { language: 'tidal', version: `Tidal ${version}`, entries: sorted };
writeFileSync(join(root, 'reference', 'tidal.json'), JSON.stringify(out, null, 1) + '\n');
const documented = sorted.filter((e) => e.description).length;
console.log(`reference/tidal.json: ${sorted.length} entries (${documented} documented)`);
if (missing.length) console.log(`left out, documented but not in Tidal ${version}: ${missing.sort().join(' ')}`);
