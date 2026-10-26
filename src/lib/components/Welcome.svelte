<script lang="ts">
  import { homeDir, join } from '@tauri-apps/api/path';
  import { open } from '@tauri-apps/plugin-dialog';

  import { app } from '$lib/app.svelte';

  let error = $state('');
  let defaultDir = $state('~/uaithne');

  $effect(() => {
    homeDir()
      .then((home) => join(home, 'uaithne'))
      .then((dir) => (defaultDir = dir));
  });

  async function use(dir: string | null) {
    if (!dir) return;
    error = '';
    try {
      await app.openWorkspace(dir);
    } catch (err) {
      error = String(err);
    }
  }

  async function choose() {
    const dir = await open({ directory: true, title: 'Choose an Uaithne workspace folder' });
    await use(typeof dir === 'string' ? dir : null);
  }
</script>

<div class="welcome">
  <h1>Uaithne</h1>
  <p>Pick a workspace folder. Uaithne creates <code>tracks/</code>, <code>samples/</code> and <code>recordings/</code> inside it.</p>
  <div class="actions">
    <button class="primary" onclick={() => use(defaultDir)}>Use {defaultDir}</button>
    <button onclick={choose}>Choose folder…</button>
  </div>
  {#if error}<p class="error">{error}</p>{/if}
</div>

<style>
  .welcome {
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    text-align: center;
    padding: 1rem;
  }
  h1 {
    font-size: 2.5rem;
    margin: 0;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
  }
  .error {
    color: var(--error);
  }
</style>
