<script lang="ts">
  import { adapters } from '$lib/adapters';
  import type { TidalAdapter } from '$lib/adapters/tidal/index.svelte';
  import { app } from '$lib/app.svelte';
  import { keymap } from '$lib/keys.svelte';
  import * as ipc from '$lib/ipc';
  import { addLog } from '$lib/log.svelte';

  const tidal = adapters.find((a) => a.id === 'tidal') as TidalAdapter;
  let busy = $state(false);

  /** How to install each prerequisite. */
  const HELP: Record<string, string> = {
    ghci: 'Install GHC with GHCup (haskell.org/ghcup) or your distribution’s ghc package.',
    tidal: 'In a terminal: cabal update && cabal install --lib tidal',
    sclang: 'Install SuperCollider from your distribution (supercollider) or supercollider.github.io.',
    superdirt: 'In the SuperCollider IDE, run Quarks.install("SuperDirt"), then recompile the class library.',
    pipewire: 'Install pipewire-jack (it provides pw-jack and pw-link).',
  };

  const procs = $derived([
    { name: 'GHCi (Tidal)', state: tidal.procs.ghci },
    { name: 'SuperCollider (SuperDirt)', state: tidal.procs.sclang },
  ]);
  const running = $derived(procs.some((p) => p.state.status !== 'stopped'));

  const close = () => {
    app.tidalOpen = false;
    app.editor?.focus();
  };

  async function act(action: () => Promise<unknown>) {
    busy = true;
    try {
      await action();
    } catch (err) {
      addLog('tidal', String(err), 'error');
    } finally {
      busy = false;
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
</script>

<svelte:window {onkeydown} />

<div class="backdrop" role="presentation" onclick={close}></div>
<div class="dialog" role="dialog" aria-label="Tidal">
  <header>
    <h2>Tidal</h2>
    <button class="icon" title="Close (Esc)" onclick={close}>✕</button>
  </header>

  <ul class="procs">
    {#each procs as proc (proc.name)}
      <li>
        <span class="dot {proc.state.status}"></span>
        <span class="name">{proc.name}</span>
        <span class="status">{proc.state.status}</span>
        {#if proc.state.message}<div class="message">{proc.state.message}</div>{/if}
      </li>
    {/each}
    <li>
      <span class="dot {tidal.procs.output ? 'ready' : 'stopped'}"></span>
      <span class="name">Audio output</span>
      <span class="status">{tidal.procs.output ?? (tidal.procs.sclang.status === 'ready' ? 'not linked by Uaithne' : '—')}</span>
    </li>
  </ul>

  <div class="buttons">
    {#if running}
      <button class="primary" disabled={busy} onclick={() => act(() => tidal.restart())}>Restart</button>
      <button disabled={busy} onclick={() => act(() => tidal.stop())}>Stop</button>
    {:else}
      <button class="primary" disabled={busy || tidal.missing.length > 0} onclick={() => act(() => tidal.start())}>Start</button>
    {/if}
    <button
      disabled={busy || tidal.procs.sclang.status !== 'ready'}
      title="Connect SuperCollider to the current audio output again, e.g. after changing devices"
      onclick={() => act(() => ipc.tidalRelink())}>Re-link audio</button
    >
  </div>

  <h3>Setup</h3>
  {#if tidal.prereqs === null}
    <p class="hint">Checking…</p>
  {:else}
    <ul class="prereqs">
      {#each tidal.prereqs as p (p.id)}
        <li class:missing={!p.ok}>
          <span class="mark">{p.ok ? '✓' : p.required ? '✗' : '!'}</span>
          <div>
            <div class="name">{p.name}</div>
            <div class="detail">{p.detail}</div>
            {#if !p.ok && HELP[p.id]}<div class="help">{HELP[p.id]}</div>{/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
  <div class="buttons">
    <button disabled={tidal.checking} onclick={() => act(() => tidal.check())}>{tidal.checking ? 'Checking…' : 'Check again'}</button>
  </div>
  <p class="hint">
    Commands, the boot file, SuperDirt's port and the audio output are set in the <code>[tidal]</code> section of
    <code>uaithne.toml</code>. Process output is in the log ({keymap.hint('log')}).
  </p>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 15;
  }
  .dialog {
    position: fixed;
    top: 8vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(560px, calc(100vw - 32px));
    max-height: 84vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 1rem;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    z-index: 16;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  h3 {
    margin: 0.4rem 0 0;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .procs li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--border);
  }
  .procs .name {
    flex: 1;
  }
  .status {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .message {
    flex-basis: 100%;
    padding-left: 1rem;
    color: var(--error);
    font-size: 0.8rem;
    overflow-wrap: anywhere;
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
  .dot.starting {
    background: var(--accent);
  }
  .dot.error {
    background: var(--error);
  }
  .buttons {
    display: flex;
    gap: 0.5rem;
  }
  .prereqs li {
    display: flex;
    gap: 0.6rem;
    padding: 0.35rem 0;
  }
  .mark {
    width: 1rem;
    color: var(--ok);
  }
  .missing .mark {
    color: var(--error);
  }
  .detail,
  .hint {
    color: var(--muted);
    font-size: 0.82rem;
    overflow-wrap: anywhere;
  }
  .help {
    font-size: 0.82rem;
    margin-top: 0.15rem;
  }
  .hint {
    margin: 0;
  }
</style>
