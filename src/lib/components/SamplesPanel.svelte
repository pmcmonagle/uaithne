<script lang="ts">
  import { app } from '$lib/app.svelte';
  import type { Sound } from '$lib/ipc';
  import { compareCategories, place } from '$lib/samples/categories';

  interface Entry {
    sound: Sound;
    label: string;
  }
  interface Group {
    name: string | null;
    entries: Entry[];
  }
  interface Category {
    name: string;
    count: number;
    groups: Group[];
  }

  const lib = app.samples;
  const EXPANDED_KEY = 'uaithne.samples.expanded';
  // Rendering thousands of rows makes typing in the search box lag.
  const LIMIT = 300;

  let query = $state('');
  /** Expanded sound (origin/name) and the index last previewed in it. */
  let open = $state<{ key: string; n: number } | null>(null);
  /** Expanded category and group keys ("Drums", "Drums/RolandTR909"). */
  let expanded = $state(loadExpanded());

  const key = (s: Sound) => `${s.origin}/${s.name}`;

  function loadExpanded(): string[] {
    try {
      return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]');
    } catch {
      return [];
    }
  }

  function toggle(k: string) {
    expanded = expanded.includes(k) ? expanded.filter((e) => e !== k) : [...expanded, k];
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded));
    } catch {}
  }

  const placed = $derived(lib.sounds.map((sound) => ({ sound, ...place(sound) })));

  /** "drums: 909" filters to a category; anything else matches name, origin, category or group. */
  const filter = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const m = q.match(/^([^:]+):\s*(.*)$/);
    if (m) {
      const prefix = m[1].trim();
      const category = [...new Set(placed.map((p) => p.category))].find((c) => c.toLowerCase().startsWith(prefix));
      if (category) return { category, text: m[2] };
    }
    return { category: null as string | null, text: q };
  });
  const searching = $derived(query.trim() !== '');

  const tree = $derived.by(() => {
    const { category: only, text } = filter;
    const categories = new Map<string, Map<string | null, Entry[]>>();
    for (const p of placed) {
      if (only && p.category !== only) continue;
      const haystack = [p.sound.name, p.sound.origin, p.category, p.group ?? ''].join(' ').toLowerCase();
      if (text && !haystack.includes(text)) continue;
      if (!categories.has(p.category)) categories.set(p.category, new Map());
      const groups = categories.get(p.category)!;
      const g = p.group ?? null;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push({ sound: p.sound, label: p.label ?? p.sound.name });
    }
    const byName = (a: Entry, b: Entry) =>
      a.label.localeCompare(b.label) || Number(a.sound.shadowed) - Number(b.sound.shadowed);
    // While searching everything is expanded, so cap the rows rendered.
    let budget = text || only ? LIMIT : Infinity;
    return [...categories]
      .sort(([a], [b]) => compareCategories(a, b))
      .map(([name, groups]) => {
        const sorted = [...groups]
          .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)))
          .map(([g, entries]) => ({ name: g, entries: entries.sort(byName) }));
        const count = sorted.reduce((n, g) => n + g.entries.length, 0);
        const shown = sorted.map((g): Group => {
          const entries = g.entries.slice(0, Math.max(0, budget));
          budget -= entries.length;
          return { name: g.name, entries };
        });
        return { name, count, groups: shown } satisfies Category;
      });
  });

  const matches = $derived(tree.reduce((n, c) => n + c.count, 0));
  // Searching opens everything that matches; so does a library with one category.
  const isOpen = (k: string) => searching || tree.length === 1 || expanded.includes(k);

  function select(sound: Sound, n: number) {
    open = { key: key(sound), n };
    if (!sound.shadowed) void lib.preview(sound.name, n);
  }

  function title(sound: Sound) {
    const where = sound.origin === 'local' ? 'samples/local' : `pack ${sound.origin}`;
    if (!sound.shadowed) return `${sound.name} · ${sound.files.length} from ${where}`;
    const winner = lib.sounds.find((s) => s.name === sound.name && !s.shadowed);
    return `${sound.name} from ${where} is hidden: ${winner?.origin ?? 'another'} has the same name and takes precedence`;
  }

  function onSearchKey(e: KeyboardEvent) {
    const first = tree[0]?.groups[0]?.entries[0];
    if (e.key === 'Enter' && first) select(first.sound, 0);
    else if (e.key === 'Escape') {
      query = '';
      app.editor?.focus();
    }
  }
</script>

{#snippet soundRow(entry: Entry, nested: boolean)}
  {@const sound = entry.sound}
  {@const isExpanded = open?.key === key(sound)}
  <li class="sound" class:shadowed={sound.shadowed} class:expanded={isExpanded} class:nested title={title(sound)}>
    <button class="row" onclick={() => (isExpanded ? (open = null) : select(sound, 0))}>
      <span class="name">{entry.label}</span>
      <span class="count">{sound.notes ? '♪' : ''}{sound.files.length}</span>
    </button>
    {#if !sound.shadowed}
      <button class="icon insert" title="Insert {sound.name} at cursor" onclick={() => app.insertSound(sound.name, isExpanded ? open!.n : 0)}>↵</button>
    {/if}
  </li>
  {#if isExpanded}
    <li class="indices" class:nested>
      {#each sound.files as file, n (file)}
        <button class:current={open?.n === n} title={file.slice(file.lastIndexOf('/') + 1)} onclick={() => select(sound, n)}>{n}</button>
      {/each}
    </li>
  {/if}
{/snippet}

<section class="samples">
  <header>
    <span>Samples</span>
    <button class="icon" title="Sample packs (:packs)" onclick={() => (lib.managerOpen = true)}>⇩</button>
  </header>
  <input
    class="search"
    placeholder="Search, or drums: 909"
    spellcheck="false"
    bind:value={query}
    onkeydown={onSearchKey}
  />
  <ul>
    {#each tree as category (category.name)}
      {@const catOpen = isOpen(category.name)}
      <li class="heading">
        <button class="toggle" onclick={() => toggle(category.name)} disabled={searching}>
          <span class="caret">{catOpen ? '▾' : '▸'}</span>
          <span class="label">{category.name}</span>
          <span class="count">{category.count}</span>
        </button>
      </li>
      {#if catOpen}
        {#each category.groups as group (group.name)}
          {#if group.name === null}
            {#each group.entries as entry (key(entry.sound))}
              {@render soundRow(entry, false)}
            {/each}
          {:else}
            {@const groupKey = `${category.name}/${group.name}`}
            {@const groupOpen = isOpen(groupKey)}
            <li class="subheading">
              <button class="toggle" onclick={() => toggle(groupKey)} disabled={searching}>
                <span class="caret">{groupOpen ? '▾' : '▸'}</span>
                <span class="label">{group.name}</span>
                <span class="count">{group.entries.length}</span>
              </button>
            </li>
            {#if groupOpen}
              {#each group.entries as entry (key(entry.sound))}
                {@render soundRow(entry, true)}
              {/each}
            {/if}
          {/if}
        {/each}
      {/if}
    {:else}
      <li class="empty">
        {#if lib.sounds.length}
          No sounds match.
        {:else}
          <p>No samples yet.</p>
          <p>Drop folders of audio files into <code>samples/local/</code>, or</p>
          <button class="primary" onclick={() => (lib.managerOpen = true)}>Get sample packs…</button>
        {/if}
      </li>
    {/each}
    {#if searching && matches > LIMIT}
      <li class="more">Showing {LIMIT} of {matches}; refine the search.</li>
    {/if}
  </ul>
</section>

<style>
  .samples {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1.3 1 0;
    border-top: 1px solid var(--border);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.4rem 0.6rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }
  .search {
    margin: 0 0.6rem 0.4rem;
    padding: 0.25rem 0.45rem;
    min-width: 0;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0 0 0.5rem;
    overflow-y: auto;
  }
  .toggle {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.6rem;
    background: none;
    border: none;
    border-radius: 0;
    text-align: left;
  }
  .toggle:disabled {
    cursor: default;
    filter: none;
  }
  .heading .toggle {
    font-weight: 600;
    font-size: 0.85rem;
  }
  .subheading .toggle {
    padding-left: 1.3rem;
    font-size: 0.82rem;
    color: var(--muted);
  }
  .heading:hover,
  .subheading:hover {
    background: var(--hover);
  }
  .caret {
    width: 0.7rem;
    color: var(--muted);
    font-size: 0.7rem;
  }
  .toggle .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  li.sound {
    display: flex;
    align-items: center;
  }
  li.sound:hover,
  li.sound.expanded {
    background: var(--hover);
  }
  .row {
    flex: 1;
    min-width: 0;
    display: flex;
    justify-content: space-between;
    gap: 0.4rem;
    padding: 0.2rem 0.6rem 0.2rem 1.6rem;
    background: none;
    border: none;
    border-radius: 0;
    text-align: left;
    font-family: var(--font-mono);
    font-size: 0.85rem;
  }
  .nested .row {
    padding-left: 2.3rem;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: normal;
  }
  .shadowed .row {
    color: var(--muted);
    text-decoration: line-through;
  }
  .insert {
    display: none;
    padding-right: 0.4rem;
  }
  li.sound:hover .insert,
  li.sound.expanded .insert {
    display: block;
  }
  li.indices {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    padding: 0.2rem 0.6rem 0.4rem 1.6rem;
    background: var(--hover);
  }
  li.indices.nested {
    padding-left: 2.3rem;
  }
  .indices button {
    min-width: 1.8rem;
    padding: 0.05rem 0.3rem;
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }
  .indices button.current {
    border-color: var(--accent);
    color: var(--accent);
  }
  li.empty,
  li.more {
    padding: 0.5rem 0.6rem;
    color: var(--muted);
    font-size: 0.85rem;
  }
  li.empty p {
    margin: 0 0 0.5rem;
  }
</style>
