<script lang="ts">
  import { app } from '$lib/app.svelte';
  import LangIcon from './LangIcon.svelte';
  import SamplesPanel from './SamplesPanel.svelte';
  import Splitter from './Splitter.svelte';
  import { LAYOUT_DEFAULTS } from '$lib/layout';

  const tracks = app.tracks;

  // Group by folder; the root folder sorts first.
  const groups = $derived.by(() => {
    const map = new Map<string, string[]>();
    for (const path of tracks.tracks) {
      const slash = path.lastIndexOf('/');
      const dir = slash < 0 ? '' : path.slice(0, slash);
      if (!map.has(dir)) map.set(dir, []);
      map.get(dir)!.push(path);
    }
    return [...map].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  });

  const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
</script>

<aside class="sidebar">
  <section class="tracks">
    <header>
      <span>Tracks</span>
      <button class="icon" title="New track (:new)" onclick={() => app.newTrackPrompt()}>+</button>
    </header>
    <ul>
      {#each groups as [dir, paths] (dir)}
        {#if dir}<li class="folder">{dir}/</li>{/if}
        {#each paths as path (path)}
          <li class:active={path === tracks.active} class:nested={!!dir}>
            <button class="track" onclick={() => tracks.switchTo(path)} title={path}>
              <LangIcon {path} />
              <span class="name">{baseName(path)}</span>
              {#if tracks.dirty[path]}<span class="dirty" title="Unsaved">●</span>{/if}
            </button>
            <span class="actions">
              <button class="icon" title="Rename" onclick={() => app.renamePrompt(path)}>✎</button>
              <button class="icon" title="Duplicate" onclick={() => app.duplicatePrompt(path)}>⧉</button>
              <button class="icon" title="Delete" onclick={() => app.deletePrompt(path)}>✕</button>
            </span>
          </li>
        {/each}
      {:else}
        <li class="empty">No tracks yet.</li>
      {/each}
    </ul>
  </section>
  <SamplesPanel />
  <Splitter
    edge="right"
    value={app.sidebarWidth}
    min={160}
    max={() => window.innerWidth * 0.45}
    initial={LAYOUT_DEFAULTS.sidebarWidth}
    onchange={(w) => (app.sidebarWidth = w)}
  />
</aside>

<style>
  .sidebar {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--panel);
    border-right: 1px solid var(--border);
  }
  .tracks {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 0 1 auto;
    max-height: 45%;
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
  ul {
    list-style: none;
    margin: 0;
    padding: 0 0 0.5rem;
    overflow-y: auto;
  }
  li {
    display: flex;
    align-items: center;
  }
  li.folder {
    padding: 0.3rem 0.6rem 0.1rem;
    font-size: 0.8rem;
    color: var(--muted);
  }
  li.empty {
    padding: 0.5rem 0.6rem;
    color: var(--muted);
  }
  .track {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.6rem;
    background: none;
    border: none;
    border-radius: 0;
    text-align: left;
  }
  li.nested .track {
    padding-left: 1.4rem;
  }
  li.active {
    background: var(--selection);
  }
  li:hover:not(.folder):not(.empty) {
    background: var(--hover);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dirty {
    color: var(--accent);
    font-size: 0.6rem;
  }
  .actions {
    display: none;
    padding-right: 0.3rem;
  }
  li:hover .actions {
    display: flex;
  }
</style>
