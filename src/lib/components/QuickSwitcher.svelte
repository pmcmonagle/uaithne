<script lang="ts">
  import { app } from '$lib/app.svelte';
  import LangIcon from './LangIcon.svelte';

  let query = $state('');
  let selected = $state(0);
  let input: HTMLInputElement;

  /** Subsequence match; lower scores are better (tighter, earlier matches). */
  function score(text: string, q: string): number | null {
    if (!q) return 0;
    const t = text.toLowerCase();
    let pos = -1;
    let first = -1;
    for (const ch of q.toLowerCase()) {
      pos = t.indexOf(ch, pos + 1);
      if (pos < 0) return null;
      if (first < 0) first = pos;
    }
    return pos - first + first * 0.1;
  }

  // Recently opened tabs first, then everything else.
  const results = $derived.by(() => {
    const order = [...app.tracks.open.toReversed(), ...app.tracks.tracks.filter((t) => !app.tracks.open.includes(t))];
    return order
      .map((path, i) => ({ path, s: score(path, query) }))
      .filter((r) => r.s !== null)
      .sort((a, b) => (query ? a.s! - b.s! : 0))
      .map((r) => r.path);
  });

  const createName = $derived(query.trim() && !results.length ? app.trackPath(query) : null);

  $effect(() => {
    input.focus();
  });

  $effect(() => {
    query;
    selected = 0;
  });

  function close() {
    app.quickSwitcherOpen = false;
    app.editor?.focus();
  }

  function choose(path: string | undefined) {
    close();
    if (path) void app.tracks.switchTo(path);
    else if (createName) void app.openOrCreate(createName);
  }

  function onkeydown(e: KeyboardEvent) {
    const move = (d: number) => (selected = (selected + d + results.length) % Math.max(1, results.length));
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter') choose(results[selected]);
    else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) move(1);
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'k')) move(-1);
    else return;
    e.preventDefault();
  }
</script>

<div class="backdrop" onclick={close} role="presentation"></div>
<div class="switcher" role="dialog" aria-label="Switch track">
  <input bind:this={input} bind:value={query} {onkeydown} placeholder="Switch to track…" spellcheck="false" />
  <ul>
    {#each results as path, i (path)}
      <li>
        <button class:selected={i === selected} onclick={() => choose(path)}>
          <LangIcon {path} />
          {path}
          {#if path === app.tracks.active}<span class="hint">current</span>{/if}
        </button>
      </li>
    {/each}
    {#if createName}
      <li><button class="selected" onclick={() => choose(undefined)}>+ Create <b>{createName}</b></button></li>
    {/if}
  </ul>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 10;
  }
  .switcher {
    position: fixed;
    top: 12vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(560px, calc(100vw - 32px));
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    z-index: 11;
    overflow: hidden;
  }
  input {
    width: 100%;
    box-sizing: border-box;
    border: none;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    padding: 0.7rem 0.9rem;
    font-size: 1rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0.3rem 0;
    max-height: 50vh;
    overflow-y: auto;
  }
  li button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: none;
    border: none;
    border-radius: 0;
    padding: 0.35rem 0.9rem;
    text-align: left;
  }
  li button.selected {
    background: var(--selection);
  }
  .hint {
    margin-left: auto;
    color: var(--muted);
    font-size: 0.8rem;
  }
</style>
