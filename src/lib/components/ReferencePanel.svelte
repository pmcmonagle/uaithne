<script lang="ts">
  import { app } from '$lib/app.svelte';
  import { keymap } from '$lib/keys.svelte';
  import { LAYOUT_DEFAULTS } from '$lib/layout';
  import { loadReference, type RefEntry, type Reference } from '$lib/reference/index.svelte';
  import { entryHtml } from '$lib/reference/markdown';
  import Splitter from './Splitter.svelte';

  const panel = app.reference;
  const language = $derived(app.referenceLanguage);
  let reference = $state<Reference | null>(null);
  let searchEl: HTMLInputElement | undefined = $state();
  let listEl: HTMLElement | undefined = $state();
  let cursor = $state(0);
  /** Error from the last Try, by block index. */
  let tryError = $state<{ index: number; message: string } | null>(null);

  $effect(() => {
    const lang = language;
    reference = null;
    void loadReference(lang).then((r) => {
      if (lang === language) reference = r;
    });
  });

  $effect(() => {
    if (panel.focusRequest && searchEl) {
      searchEl.focus();
      searchEl.select();
    }
  });

  const results = $derived(reference ? reference.search(panel.query, panel.tag).slice(0, 200) : []);
  const entry = $derived<RefEntry | undefined>(panel.selected ? reference?.get(panel.selected) : undefined);
  /** The block of this entry whose example is playing, if any. */
  const playing = $derived.by(() => {
    const key = app.tryPlaying;
    const at = key?.lastIndexOf('#') ?? -1; // names can contain '#' (Tidal's # operator)
    return key && entry && key.slice(0, at) === `${language}:${entry.name}` ? Number(key.slice(at + 1)) : null;
  });
  const rendered = $derived(entry ? entryHtml(entry, playing) : null);

  $effect(() => {
    void results;
    cursor = 0;
  });

  $effect(() => {
    void entry;
    tryError = null;
  });

  function open(e: RefEntry) {
    panel.selected = e.name;
  }

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = Math.max(0, Math.min(results.length - 1, cursor + (e.key === 'ArrowDown' ? 1 : -1)));
      listEl?.querySelector(`[data-i="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && results[cursor]) {
      e.preventDefault();
      open(results[cursor]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (panel.selected) panel.selected = null;
      else app.editor?.focus();
    }
  }

  function onSearchInput() {
    panel.selected = null;
  }

  async function onBodyClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const tryAt = target.closest<HTMLElement>('[data-try]')?.dataset.try;
    const insertAt = target.closest<HTMLElement>('[data-insert]')?.dataset.insert;
    const stop = target.closest<HTMLElement>('[data-stop]');
    const link = target.closest<HTMLElement>('[data-entry]')?.dataset.entry;
    if (tryAt !== undefined && rendered) {
      const index = Number(tryAt);
      tryError = null;
      const message = await app.tryCode(rendered.code[index], language, `${language}:${entry!.name}#${index}`);
      if (message) tryError = { index, message };
    } else if (stop) {
      await app.stopTry();
    } else if (insertAt !== undefined && rendered) {
      app.insertCode(rendered.code[Number(insertAt)]);
    } else if (link) {
      panel.selected = link;
    }
  }

  /** Inline `names` that have entries of their own become links. */
  function linkNames(html: string) {
    if (!reference) return html;
    return html.replace(/<code>([\w']+)<\/code>/g, (whole, name) =>
      name !== entry?.name && reference!.get(name) ? `<code class="ref-link" data-entry="${name}">${name}</code>` : whole,
    );
  }
</script>

<aside class="reference" aria-label="Reference" style:width="{app.referenceWidth}px">
  <Splitter
    edge="left"
    value={app.referenceWidth}
    min={260}
    max={() => window.innerWidth * 0.6}
    initial={LAYOUT_DEFAULTS.referenceWidth}
    onchange={(w) => (app.referenceWidth = w)}
  />
  <header>
    <h2>Reference</h2>
    <span class="lang {language}">{reference?.version ?? language}</span>
    <button class="icon" title="Close ({keymap.hint('reference')})" onclick={() => (panel.open = false)}>✕</button>
  </header>
  <input
    class="search"
    type="search"
    placeholder="Search functions…"
    spellcheck="false"
    bind:this={searchEl}
    bind:value={panel.query}
    oninput={onSearchInput}
    onkeydown={onSearchKey}
  />
  {#if reference}
    <div class="tags">
      <button class:on={!panel.tag} onclick={() => (panel.tag = null)}>all</button>
      {#each reference.tags as tag (tag)}
        <button class:on={panel.tag === tag} onclick={() => (panel.tag = panel.tag === tag ? null : tag)}>{tag}</button>
      {/each}
    </div>
  {/if}

  {#if entry && rendered}
    <!-- Clicks on Try/Insert and name links, delegated (they are buttons in the rendered HTML). -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <article class="entry" onclick={onBodyClick}>
      <button class="back" onclick={() => (panel.selected = null)}>← results</button>
      <h3>{entry.name}{#if entry.deprecated}<span class="deprecated">deprecated</span>{/if}</h3>
      {#if entry.aliases?.length}<div class="aliases">also {entry.aliases.join(', ')}</div>{/if}
      {#if entry.signature}<pre class="signature">{entry.signature}</pre>{/if}
      {#if entry.params?.length}
        <dl class="params">
          {#each entry.params as p (p.name)}
            <dt>{p.name}{#if p.type}<span class="type">{p.type}</span>{/if}</dt>
            {#if p.doc}<dd>{p.doc}</dd>{/if}
          {/each}
        </dl>
      {/if}
      <div class="body">
        <!-- Escaped markdown from the bundled reference (see markdown.ts). -->
        {@html linkNames(rendered.html)}
      </div>
      {#if !entry.description && !rendered.code.length}<p class="muted">No description yet.</p>{/if}
      {#if tryError}<p class="error">Example {tryError.index + 1}: {tryError.message}</p>{/if}
      <div class="tags-line">{#each entry.tags as tag (tag)}<span>{tag}</span>{/each}</div>
    </article>
  {:else if panel.selected && reference && !entry}
    <p class="muted pad">Nothing called <code>{panel.selected}</code> in the {reference.version} reference.</p>
  {:else}
    <ul class="results" bind:this={listEl}>
      {#each results as r, i (r.name)}
        <li>
          <button class:cursor={i === cursor} data-i={i} onclick={() => open(r)}>
            <span class="name">{r.name}</span>
            <span class="synopsis">{r.synopsis}</span>
          </button>
        </li>
      {:else}
        <li class="muted pad">{reference ? 'No matches.' : 'Loading…'}</li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
  .reference {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--border);
    background: var(--panel);
    font-size: 0.88rem;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem 0.25rem;
  }
  h2 {
    margin: 0;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }
  .lang {
    flex: 1;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .lang.strudel {
    color: var(--strudel);
  }
  .lang.tidal {
    color: var(--tidal);
  }
  .search {
    margin: 0.25rem 0.75rem;
  }
  .tags {
    display: flex;
    gap: 0.3rem;
    padding: 0.25rem 0.75rem 0.5rem;
    overflow-x: auto;
    flex-shrink: 0;
    scrollbar-width: thin;
  }
  .tags button {
    flex-shrink: 0;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    white-space: nowrap;
  }
  .tags button.on {
    background: var(--accent);
    color: var(--bg);
    border-color: var(--accent);
  }
  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  .results button {
    display: block;
    width: 100%;
    text-align: left;
    border: 0;
    border-radius: 0;
    background: none;
    padding: 0.35rem 0.75rem;
  }
  .results button:hover,
  .results button.cursor {
    background: var(--hover);
  }
  .results .name {
    font-family: var(--font-mono);
    font-weight: 600;
  }
  .results .synopsis {
    display: block;
    color: var(--muted);
    font-size: 0.8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .entry {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    padding: 0 0.75rem 1rem;
  }
  .back {
    border: 0;
    background: none;
    padding: 0.25rem 0;
    color: var(--muted);
  }
  h3 {
    margin: 0.25rem 0;
    font-family: var(--font-mono);
    font-size: 1.05rem;
  }
  .deprecated {
    margin-left: 0.5rem;
    font-size: 0.7rem;
    color: var(--error);
    font-family: var(--font-ui);
  }
  .aliases {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .signature {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--bg);
    padding: 0.4rem 0.5rem;
    border-radius: 4px;
    font-size: 0.8rem;
  }
  .params {
    margin: 0.5rem 0;
  }
  .params dt {
    font-family: var(--font-mono);
  }
  .params .type {
    margin-left: 0.5rem;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .params dd {
    margin: 0 0 0.3rem 1rem;
    color: var(--muted);
  }
  .body :global(p) {
    margin: 0.5rem 0;
    line-height: 1.45;
  }
  .body :global(code) {
    font-family: var(--font-mono);
    font-size: 0.85em;
  }
  .body :global(.ref-link) {
    color: var(--accent);
    cursor: pointer;
  }
  .body :global(.example) {
    margin: 0.5rem 0;
    background: var(--bg);
    border-radius: 4px;
    overflow: hidden;
  }
  .body :global(.example pre) {
    margin: 0;
    padding: 0.5rem;
    overflow-x: auto;
    font-size: 0.8rem;
  }
  .body :global(.example-actions) {
    display: flex;
    gap: 0.3rem;
    justify-content: flex-end;
    padding: 0 0.4rem 0.4rem;
  }
  .body :global(.example-actions button) {
    font-size: 0.75rem;
    padding: 0.1rem 0.5rem;
  }
  .body :global(.example.playing) {
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .body :global(.example-actions .stop) {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg);
  }
  .body :global(table) {
    border-collapse: collapse;
    font-size: 0.8rem;
  }
  .body :global(td),
  .body :global(th) {
    border: 1px solid var(--border);
    padding: 0.2rem 0.4rem;
  }
  .tags-line {
    display: flex;
    gap: 0.3rem;
    margin-top: 0.75rem;
  }
  .tags-line span {
    font-size: 0.72rem;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0 0.45rem;
  }
  .muted {
    color: var(--muted);
  }
  .pad {
    padding: 0.5rem 0.75rem;
  }
  .error {
    color: var(--error);
    font-size: 0.8rem;
    overflow-wrap: anywhere;
  }
</style>
