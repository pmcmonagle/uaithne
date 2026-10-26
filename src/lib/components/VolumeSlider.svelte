<script lang="ts">
  import { app } from '$lib/app.svelte';
  import { keymap } from '$lib/keys.svelte';

  const pct = $derived(Math.round(app.volume * 100));
  const icon = $derived(app.muted || app.volume === 0 ? '🔇' : app.volume < 0.4 ? '🔈' : app.volume < 0.75 ? '🔉' : '🔊');
</script>

<div class="volume" title="Global volume ({keymap.hint('volumeUp')} / {keymap.hint('volumeDown')}, {keymap.hint('mute')} mutes)">
  <button class="icon" onclick={() => app.setVolume(app.volume, !app.muted)} aria-label={app.muted ? 'Unmute' : 'Mute'}>
    {icon}
  </button>
  <input
    type="range"
    min="0"
    max="1"
    step="0.01"
    value={app.volume}
    class:muted={app.muted}
    oninput={(e) => app.setVolume(+e.currentTarget.value)}
    aria-label="Global volume"
  />
  <span class="pct">{app.muted ? 'muted' : `${pct}%`}</span>
</div>

<style>
  .volume {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  input {
    width: 140px;
    accent-color: var(--accent);
  }
  input.muted {
    opacity: 0.4;
  }
  .pct {
    width: 3.2rem;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    font-size: 0.85rem;
  }
</style>
