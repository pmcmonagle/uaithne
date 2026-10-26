<script lang="ts">
  import { app } from '$lib/app.svelte';
  import { LAYOUT_DEFAULTS } from '$lib/layout';
  import { clearLog, log } from '$lib/log.svelte';
  import Splitter from './Splitter.svelte';

  let list = $state<HTMLElement>();

  /** Tabs group log sources by engine. */
  const TABS = ['All', 'Strudel', 'Tidal', 'SuperCollider', 'Uaithne'] as const;
  type Tab = (typeof TABS)[number];
  const tabOf = (source: string): Tab =>
    source === 'strudel' ? 'Strudel' : source === 'ghci' || source === 'tidal' ? 'Tidal' : source === 'sclang' ? 'SuperCollider' : 'Uaithne';
  const tab = $derived<Tab>(TABS.includes(app.consoleTab as Tab) ? (app.consoleTab as Tab) : 'All');
  const lines = $derived(tab === 'All' ? log.lines : log.lines.filter((l) => tabOf(l.source) === tab));

  $effect(() => {
    log.unseenErrors = 0;
  });

  // Stick to the bottom as lines arrive.
  $effect(() => {
    lines.length;
    list?.scrollTo({ top: list.scrollHeight });
  });

  const time = (d: Date) => d.toTimeString().slice(0, 8);
</script>

<section class="console" style:height="{app.consoleHeight}px">
  <Splitter
    edge="top"
    value={app.consoleHeight}
    min={80}
    max={() => window.innerHeight * 0.7}
    initial={LAYOUT_DEFAULTS.consoleHeight}
    onchange={(h) => (app.consoleHeight = h)}
  />
  <header>
    <span class="tabs">
      {#each TABS as t (t)}
        <button class:current={tab === t} onclick={() => (app.consoleTab = t)}>{t}</button>
      {/each}
    </span>
    <button class="icon" title="Clear" onclick={clearLog}>⌫</button>
  </header>
  <ol bind:this={list}>
    {#each lines as line (line.id)}
      <li class={line.level}><span class="meta">{time(line.time)} {line.source}</span> {line.message}</li>
    {:else}
      <li class="meta">Nothing logged yet.</li>
    {/each}
  </ol>
</section>

<style>
  .console {
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border-top: 1px solid var(--border);
  }
  header {
    display: flex;
    justify-content: space-between;
    padding: 0.2rem 0.6rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0 0.6rem 0.4rem;
    overflow-y: auto;
    font-family: var(--font-mono);
    font-size: 0.8rem;
  }
  li {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .tabs {
    display: flex;
    gap: 0.2rem;
  }
  .tabs button {
    border: none;
    background: none;
    padding: 0.1rem 0.4rem;
    font-size: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    color: inherit;
  }
  .tabs button.current {
    color: var(--fg);
    background: var(--hover);
  }
  .meta {
    color: var(--muted);
  }
  .warning {
    color: var(--accent);
  }
  .error {
    color: var(--error);
  }
</style>
