<script lang="ts">
  import { untrack } from 'svelte';
  import { app } from '$lib/app.svelte';
  import Welcome from '$lib/components/Welcome.svelte';
  import Workbench from '$lib/components/Workbench.svelte';
  import { addLog } from '$lib/log.svelte';

  let ready = $state(false);

  $effect(() => {
    untrack(() =>
      app
        .init()
        .catch((err) => addLog('uaithne', `Startup failed: ${err}`, 'error'))
        .finally(() => (ready = true)),
    );
  });
</script>

{#if ready}
  {#if app.switching}
    <!-- the workbench remounts on the new workspace -->
  {:else if app.workspace}
    <Workbench />
  {:else}
    <Welcome />
  {/if}
{/if}

<style>
  /* Colours come from the theme (src/lib/themes.ts). */
  :global(:root) {
    /* Strudel's pattern highlighter outlines active tokens in this colour. */
    --foreground: var(--accent);
    --font-ui: system-ui, -apple-system, 'Segoe UI', sans-serif;
    --font-mono: 'JetBrains Mono', 'Fira Code', ui-monospace, 'DejaVu Sans Mono', monospace;
  }
  :global(body) {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--font-ui);
    font-size: 14px;
    overflow: hidden;
  }
  :global(button) {
    font: inherit;
    color: inherit;
    background: var(--hover);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.35rem 0.75rem;
    cursor: pointer;
  }
  :global(button:hover) {
    filter: brightness(1.15);
  }
  :global(button.primary) {
    background: var(--accent);
    color: var(--bg);
    border-color: var(--accent);
  }
  :global(button.danger) {
    background: var(--error);
    color: var(--bg);
    border-color: var(--error);
  }
  :global(button.icon) {
    background: none;
    border: none;
    padding: 0.1rem 0.35rem;
    color: var(--muted);
  }
  :global(button.icon:hover) {
    color: var(--fg);
  }
  :global(input) {
    font: inherit;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  :global(code),
  :global(kbd) {
    font-family: var(--font-mono);
    font-size: 0.9em;
  }
</style>
