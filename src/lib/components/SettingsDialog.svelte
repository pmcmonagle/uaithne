<script lang="ts">
  import { onMount } from 'svelte';
  import { appConfigDir, join } from '@tauri-apps/api/path';
  import { open } from '@tauri-apps/plugin-dialog';
  import { app } from '$lib/app.svelte';
  import * as ipc from '$lib/ipc';
  import { addLog } from '$lib/log.svelte';
  import { THEMES } from '$lib/themes';

  let ports = $state<string[] | null>(null);
  let portError = $state<string | null>(null);
  let midiOutput = $state(app.settings?.midiOutput ?? '');
  let tidalMidiOutput = $state(app.settings?.tidalMidiOutput ?? '');
  let oscTarget = $state(app.settings?.oscTarget ?? '127.0.0.1:57120');
  let saving = $state(false);
  let theme = $state(app.settings?.theme ?? 'auto');
  let themeCss = $state('theme.css');
  onMount(() => void appConfigDir().then((dir) => join(dir, 'theme.css')).then((p) => (themeCss = p)));

  /** Themes apply (and save) at once, without waiting for Save. */
  function pickTheme() {
    app.setTheme(theme).catch((err) => addLog('uaithne', `Couldn't save the theme: ${err}`, 'error'));
  }

  async function changeWorkspace() {
    const dir = await open({ directory: true, title: 'Choose an Uaithne workspace folder', defaultPath: app.workspace?.root });
    if (typeof dir === 'string') await app.switchWorkspace(dir);
  }

  const validTarget = $derived(/^[\w.-]+:\d{1,5}$/.test(oscTarget.trim()));
  const changed = $derived(
    midiOutput !== (app.settings?.midiOutput ?? '') ||
      tidalMidiOutput !== (app.settings?.tidalMidiOutput ?? '') ||
      oscTarget.trim() !== (app.settings?.oscTarget ?? ''),
  );

  async function refresh() {
    portError = null;
    try {
      ports = await ipc.midiOutputs();
    } catch (err) {
      ports = [];
      portError = String(err);
    }
  }
  onMount(refresh);

  /** Keep a saved choice in the list even when its device is unplugged. */
  const options = (saved: string) => (saved && ports && !ports.includes(saved) ? [...ports, saved] : (ports ?? []));

  const close = () => {
    app.settingsOpen = false;
    app.editor?.focus();
  };

  async function save() {
    saving = true;
    try {
      app.settings = await ipc.setIoSettings(midiOutput, tidalMidiOutput, oscTarget.trim());
      close();
    } catch (err) {
      addLog('uaithne', `Couldn't save settings: ${err}`, 'error');
    } finally {
      saving = false;
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
<div class="dialog" role="dialog" aria-label="Settings">
  <header>
    <h2>Settings</h2>
    <button class="icon" title="Close (Esc)" onclick={close}>✕</button>
  </header>

  <h3>Workspace</h3>
  <div class="row">
    <code class="path grow">{app.workspace?.root}</code>
    <button onclick={changeWorkspace}>Change…</button>
  </div>
  <p class="hint">
    Tracks are stored in its <code>tracks/</code> folder, next to <code>samples/</code> and <code>recordings/</code>. A folder
    that isn't a workspace yet gets these made. Unsaved edits are saved before switching.
  </p>

  <h3>Appearance</h3>
  <label>
    <span>Theme</span>
    <select bind:value={theme} onchange={pickTheme}>
      <option value="auto">Auto (follow the system)</option>
      {#each THEMES as t (t.id)}
        <option value={t.id}>{t.name}</option>
      {/each}
    </select>
  </label>
  <p class="hint">
    Any colour can be overridden in <code class="path">{themeCss}</code>, e.g. <code>:root {'{'} --accent: #e06c75; {'}'}</code>.
    <button class="link" onclick={() => app.reloadTheme()}>Reload it</button>
  </p>

  <h3>MIDI out</h3>
  {#if portError}<p class="error">{portError}</p>{/if}
  <label>
    <span>Strudel <code>.midi()</code></span>
    <select bind:value={midiOutput} disabled={!ports}>
      <option value="">First available output</option>
      {#each options(midiOutput) as port (port)}
        <option value={port}>{port}{ports?.includes(port) ? '' : ' (not connected)'}</option>
      {/each}
    </select>
  </label>
  <p class="hint">Used when the code doesn't name a port; <code>.midi("name")</code> or <code>.midiport("name")</code> picks one by (part of) its name.</p>
  <label>
    <span>Tidal <code>s "midi"</code></span>
    <select bind:value={tidalMidiOutput} disabled={!ports}>
      <option value="">Off</option>
      {#each options(tidalMidiOutput) as port (port)}
        <option value={port}>{port}{ports?.includes(port) ? '' : ' (not connected)'}</option>
      {/each}
    </select>
  </label>
  <p class="hint">
    SuperDirt plays <code>d1 $ n "0 4 7" # s "midi"</code> on this output (<code>n "0"</code> is middle C; <code>midichan</code>
    picks the channel).
  </p>
  <div class="row">
    <button onclick={refresh}>Refresh outputs</button>
    <span class="hint">{ports === null ? 'Looking for outputs…' : `${ports.length} output${ports.length === 1 ? '' : 's'} found`}</span>
  </div>

  <h3>OSC out</h3>
  <label>
    <span>Strudel <code>.osc()</code> target</span>
    <input type="text" bind:value={oscTarget} spellcheck="false" placeholder="127.0.0.1:57120" class:invalid={!validTarget} />
  </label>
  <p class="hint">
    host:port. The default is SuperDirt (57120), so <code>s("bd*4").osc()</code> plays through SuperCollider; events go as
    <code>/dirt/play</code> bundles timestamped for when they should sound.
  </p>

  <div class="buttons">
    <button onclick={close}>Cancel</button>
    <button class="primary" disabled={saving || !changed || !validTarget} onclick={save}>Save</button>
  </div>
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
    gap: 0.45rem;
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
    margin: 0.6rem 0 0;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }
  label {
    display: grid;
    grid-template-columns: 11rem 1fr;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.88rem;
  }
  select,
  input {
    min-width: 0;
  }
  .invalid {
    border-color: var(--error);
  }
  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .error {
    margin: 0;
    color: var(--error);
    font-size: 0.82rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .path {
    word-break: break-all;
  }
  .grow {
    flex: 1;
    font-size: 0.85rem;
  }
  button.link {
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    text-decoration: underline;
    font-size: inherit;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  @media (max-width: 520px) {
    label {
      grid-template-columns: 1fr;
      gap: 0.25rem;
    }
  }
</style>
