<script lang="ts">
  import { adapterFor } from '$lib/adapters';

  let { path }: { path: string } = $props();
  const id = $derived(adapterFor(path)?.id);
</script>

<span class="lang {id}" title={adapterFor(path)?.name}>{id === 'tidal' ? 'λ' : id === 'strudel' ? 'S' : '?'}</span>

<style>
  .lang {
    display: inline-grid;
    place-items: center;
    width: 1.1rem;
    height: 1.1rem;
    flex: none;
    border-radius: 3px;
    font-size: 0.7rem;
    font-weight: 700;
    color: var(--bg);
  }
  .strudel {
    background: var(--strudel);
  }
  .tidal {
    background: var(--tidal);
  }
</style>
