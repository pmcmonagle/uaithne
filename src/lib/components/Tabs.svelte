<script lang="ts">
  import { app } from '$lib/app.svelte';
  import LangIcon from './LangIcon.svelte';

  const tracks = app.tracks;
  const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.\w+$/, '');
</script>

<nav class="tabs">
  {#each tracks.open as path (path)}
    <div class="tab" class:active={path === tracks.active} title={path}>
      <button class="label" onclick={() => tracks.switchTo(path)}>
        <LangIcon {path} />
        {baseName(path)}
        {#if tracks.dirty[path]}<span class="dirty">●</span>{/if}
      </button>
      <button class="icon close" title="Close (:bd)" onclick={() => tracks.close(path)}>✕</button>
    </div>
  {/each}
</nav>

<style>
  .tabs {
    display: flex;
    overflow-x: auto;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    min-height: 2rem;
  }
  .tab {
    display: flex;
    align-items: center;
    border-right: 1px solid var(--border);
    color: var(--muted);
  }
  .tab.active {
    background: var(--bg);
    color: var(--fg);
    box-shadow: inset 0 2px 0 var(--accent);
  }
  .label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: none;
    border: none;
    border-radius: 0;
    padding: 0.3rem 0.2rem 0.3rem 0.6rem;
    color: inherit;
    white-space: nowrap;
  }
  .close {
    visibility: hidden;
  }
  .tab:hover .close,
  .tab.active .close {
    visibility: visible;
  }
  .dirty {
    color: var(--accent);
    font-size: 0.6rem;
  }
</style>
