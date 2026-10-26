<script lang="ts">
  import { app } from '$lib/app.svelte';
  import { keymap } from '$lib/keys.svelte';
  import VolumeSlider from './VolumeSlider.svelte';
</script>

<header class="titlebar">
  <span class="brand">Uaithne</span>
  <span class="path">{app.tracks.active ? `tracks/${app.tracks.active}` : app.workspace?.root}</span>
  <VolumeSlider />
  <button class="icon" title="Settings ({keymap.hint('settings')})" onclick={() => (app.settingsOpen = true)}>⚙</button>
</header>

<style>
  .titlebar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.35rem 0.75rem;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .brand {
    font-weight: 700;
  }
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.85rem;
  }
</style>
