<script lang="ts">
  import { app } from '$lib/app.svelte';

  const lib = app.samples;
  let custom = $state('');

  const known = $derived(new Set(lib.catalogue.map((c) => c.id)));
  const others = $derived(lib.packs.filter((p) => !known.has(p.id)));

  const close = () => {
    lib.managerOpen = false;
    app.editor?.focus();
  };

  function size(bytes: number) {
    if (bytes < 1e6) return `${Math.round(bytes / 1e3)} kB`;
    if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
    return `${(bytes / 1e9).toFixed(2)} GB`;
  }

  async function remove(id: string, name: string) {
    const ok = await app.ask(`Delete the ${name} pack? Its files are removed from samples/packs.`);
    if (ok !== null) await lib.remove(id);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !app.prompt) {
      e.preventDefault();
      close();
    }
  }
</script>

<svelte:window {onkeydown} />

<div class="backdrop" role="presentation" onclick={close}></div>
<div class="dialog" role="dialog" aria-label="Sample packs">
  <header>
    <h2>Sample packs</h2>
    <button class="icon" title="Close (Esc)" onclick={close}>✕</button>
  </header>
  <p class="hint">
    Packs download to <code>samples/packs/</code> and work offline. For your own sounds, drop folders of audio files into
    <code>samples/local/</code>: each folder is a sound, named after the folder. Local sounds win over packs with the same name.
  </p>

  <ul>
    {#snippet status(id: string, name: string, source: string)}
      {@const progress = lib.progress[id]}
      {@const installed = lib.installed(id)}
      {#if progress}
        <div class="progress">
          <progress max={progress.total || 1} value={progress.done}></progress>
          <span>{progress.total ? `${progress.done}/${progress.total}` : 'Fetching manifest…'}</span>
          <button onclick={() => lib.cancel(id)}>Cancel</button>
        </div>
      {:else if installed}
        <div class="buttons">
          <span class="size">{installed.sounds} sounds · {size(installed.bytes)}</span>
          <button title="Download again and replace" onclick={() => lib.install(id, name, source)}>Update</button>
          <button onclick={() => remove(id, name)}>Delete</button>
        </div>
      {:else}
        <button class="primary" onclick={() => lib.install(id, name, source)}>Download</button>
      {/if}
    {/snippet}

    {#each lib.catalogue as entry (entry.id)}
      <li>
        <div class="info">
          <div class="name">{entry.name} <span class="meta">{entry.sounds} sounds · {entry.files} files</span></div>
          <div class="desc">{entry.description}</div>
          {#if lib.errors[entry.id]}<div class="error">{lib.errors[entry.id]}</div>{/if}
        </div>
        {@render status(entry.id, entry.name, entry.source)}
      </li>
    {/each}
    {#each others as pack (pack.id)}
      <li>
        <div class="info">
          <div class="name">{pack.name}</div>
          <div class="desc">{pack.source ?? 'Added by hand'}</div>
          {#if lib.errors[pack.id]}<div class="error">{lib.errors[pack.id]}</div>{/if}
        </div>
        {#if pack.source}
          {@render status(pack.id, pack.name, pack.source)}
        {:else}
          <div class="buttons"><span class="size">{pack.sounds} sounds · {size(pack.bytes)}</span></div>
        {/if}
      </li>
    {/each}
    {#each Object.values(lib.progress).filter((p) => !known.has(p.id) && !lib.installed(p.id)) as p (p.id)}
      <li>
        <div class="info"><div class="name">{p.id}</div></div>
        <div class="progress">
          <progress max={p.total || 1} value={p.done}></progress>
          <span>{p.total ? `${p.done}/${p.total}` : 'Fetching manifest…'}</span>
          <button onclick={() => lib.cancel(p.id)}>Cancel</button>
        </div>
      </li>
    {/each}
  </ul>

  <form
    class="custom"
    onsubmit={(e) => {
      e.preventDefault();
      void lib.installCustom(custom);
      custom = '';
    }}
  >
    <input bind:value={custom} placeholder="github:user/repo or https://…/strudel.json" spellcheck="false" />
    <button type="submit" disabled={!custom.trim()}>Download</button>
  </form>
  {#each Object.entries(lib.errors).filter(([id]) => !known.has(id) && !lib.installed(id)) as [id, message] (id)}
    <div class="error">{id}: {message}</div>
  {/each}
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
    width: min(720px, calc(100vw - 32px));
    max-height: 84vh;
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
  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.85rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    border-top: 1px solid var(--border);
  }
  li {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.6rem 0.2rem;
    border-bottom: 1px solid var(--border);
  }
  .info {
    flex: 1;
    min-width: 0;
  }
  .name {
    font-weight: 600;
  }
  .meta,
  .size {
    font-weight: normal;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .desc {
    color: var(--muted);
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }
  .error {
    color: var(--error);
    font-size: 0.8rem;
    overflow-wrap: anywhere;
  }
  .buttons,
  .progress {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .progress span {
    font-size: 0.8rem;
    color: var(--muted);
    min-width: 5.5rem;
    text-align: right;
  }
  progress {
    width: 120px;
    accent-color: var(--accent);
  }
  .custom {
    display: flex;
    gap: 0.5rem;
  }
  .custom input {
    flex: 1;
    min-width: 0;
    padding: 0.4rem 0.6rem;
  }
  @media (max-width: 560px) {
    li {
      flex-direction: column;
      align-items: stretch;
      gap: 0.4rem;
    }
  }
</style>
