<script lang="ts">
  import { adapters } from '$lib/adapters';
  import { app } from '$lib/app.svelte';
  import { keymap } from '$lib/keys.svelte';
  import { log } from '$lib/log.svelte';

  const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.\w+$/, '');

  // Recording time, ticking while a recording runs.
  let now = $state(Date.now());
  $effect(() => {
    if (!app.recording) return;
    const timer = setInterval(() => (now = Date.now()), 500);
    return () => clearInterval(timer);
  });
  const elapsed = $derived.by(() => {
    if (!app.recording) return '';
    const s = Math.max(0, Math.floor((now - app.recording.since) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });
</script>

<footer class="statusbar">
  {#if app.workspace?.config.editor.vim}
    <span class="mode {app.vimMode.split(' ')[0]}">{app.vimMode.toUpperCase()}</span>
  {/if}
  {#each adapters as adapter (adapter.id)}
    {#snippet label()}
      <span class="dot {adapter.state.status}"></span>
      {adapter.name}{#if adapter.state.nowPlaying}: <b>{baseName(adapter.state.nowPlaying)}</b>{/if}
    {/snippet}
    {#if adapter.id === 'tidal'}
      <button class="engine" title="Tidal: {adapter.state.status} (click for status and setup)" onclick={() => (app.tidalOpen = true)}>
        {@render label()}
      </button>
    {:else}
      <span class="engine" title="{adapter.name}: {adapter.state.status}">{@render label()}</span>
    {/if}
  {/each}
  <span class="spacer"></span>
  <button
    class="rec"
    class:on={app.recording}
    title={app.recording
      ? `Recording to ${app.recording.files.join(', ')} (${keymap.hint('record')} to stop)`
      : `Record to recordings/ (${keymap.hint('record')})`}
    onclick={() => app.toggleRecording()}
  >
    <span class="rec-dot"></span>{app.recording ? `REC ${elapsed}` : 'rec'}
  </button>
  <span class="keys">
    {[
      [keymap.hint('evaluate'), 'eval'],
      [keymap.hint('hush'), 'hush'],
      [keymap.hint('switcher'), 'tracks'],
    ]
      .filter(([keys]) => keys)
      .map(([keys, what]) => `${keys} ${what}`)
      .join(' · ')}
  </span>
  <button class="help" title="All keyboard shortcuts" onclick={() => (app.helpOpen = true)}>
    {keymap.hint('help') ? `${keymap.hint('help')} help` : 'help'}
  </button>
  <button class="console-toggle" class:has-errors={log.unseenErrors > 0} onclick={() => (app.consoleOpen = !app.consoleOpen)}>
    {app.consoleOpen ? '⌄' : '⌃'} log{#if log.unseenErrors} ({log.unseenErrors}){/if}
  </button>
</footer>

<style>
  .statusbar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0 0 0 0.5rem;
    min-height: 1.6rem;
    background: var(--panel);
    border-top: 1px solid var(--border);
    font-size: 0.8rem;
    color: var(--muted);
  }
  .mode {
    font-weight: 700;
    padding: 0 0.4rem;
    border-radius: 3px;
    background: var(--hover);
    color: var(--fg);
  }
  .mode.insert {
    background: var(--strudel);
    color: var(--bg);
  }
  .mode.visual {
    background: var(--tidal);
    color: var(--bg);
  }
  .engine {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  button.engine {
    border: none;
    background: none;
    padding: 0;
    color: inherit;
    font-size: inherit;
  }
  button.engine:hover {
    color: var(--fg);
  }
  .engine b {
    color: var(--fg);
    font-weight: 500;
  }
  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--muted);
  }
  .dot.ready {
    background: var(--ok);
  }
  .dot.playing {
    background: var(--ok);
    box-shadow: 0 0 6px var(--ok);
  }
  .dot.booting {
    background: var(--accent);
  }
  .dot.error {
    background: var(--error);
  }
  .dot.unavailable {
    background: transparent;
    border: 1px solid var(--muted);
  }
  .spacer {
    flex: 1;
  }
  .rec {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    border: none;
    background: none;
    color: inherit;
    font-size: inherit;
    padding: 0;
  }
  .rec-dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    border: 1.5px solid currentColor;
  }
  .rec.on {
    color: var(--error);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .rec.on .rec-dot {
    background: var(--error);
    border-color: var(--error);
    animation: blink 1s steps(2, start) infinite;
  }
  @keyframes blink {
    to {
      visibility: hidden;
    }
  }
  .help {
    border: none;
    background: none;
    color: inherit;
    font-size: inherit;
    padding: 0;
  }
  .help:hover {
    color: var(--fg);
    text-decoration: underline;
  }
  .console-toggle {
    border: none;
    border-left: 1px solid var(--border);
    border-radius: 0;
    background: none;
    color: inherit;
    font-size: inherit;
    padding: 0.2rem 0.7rem;
  }
  .console-toggle.has-errors {
    color: var(--error);
  }
  @media (max-width: 900px) {
    .keys {
      display: none;
    }
  }
</style>
