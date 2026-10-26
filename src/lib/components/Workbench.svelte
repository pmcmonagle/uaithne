<script lang="ts">
  import { untrack } from 'svelte';
  import { app } from '$lib/app.svelte';
  import { keymap } from '$lib/keys.svelte';
  import ConsoleDrawer from './ConsoleDrawer.svelte';
  import HelpDialog from './HelpDialog.svelte';
  import PackManager from './PackManager.svelte';
  import TidalPanel from './TidalPanel.svelte';
  import SettingsDialog from './SettingsDialog.svelte';
  import VisualsPanel from './VisualsPanel.svelte';
  import PromptDialog from './PromptDialog.svelte';
  import QuickSwitcher from './QuickSwitcher.svelte';
  import ReferencePanel from './ReferencePanel.svelte';
  import Sidebar from './Sidebar.svelte';
  import StatusBar from './StatusBar.svelte';
  import Tabs from './Tabs.svelte';
  import TitleBar from './TitleBar.svelte';

  let editorEl: HTMLElement;

  $effect(() => {
    // untrack: mounting reads app state that must not trigger a remount.
    untrack(() => void app.mountEditor(editorEl));
    return () => app.unmountEditor();
  });

  // Remember open tabs per workspace.
  $effect(() => {
    app.tracks.open.length;
    app.tracks.active;
    app.saveSession();
  });
</script>

<svelte:window onkeydowncapture={(e) => app.onKeydown(e)} onbeforeunload={() => app.tracks.saveAll()} />

<div class="workbench">
  <TitleBar />
  <div class="main" style:--sidebar-width="{app.sidebarWidth}px">
    <Sidebar />
    <div class="editor-col">
      <Tabs />
      {#each app.tracks.conflicts as path (path)}
        <div class="banner">
          <span><b>{path}</b> changed on disk while you had unsaved edits.</span>
          <button onclick={() => app.tracks.reloadFromDisk(path)}>Load disk version</button>
          <button onclick={() => app.tracks.keepMine(path)}>Keep mine</button>
        </div>
      {/each}
      <div class="editor" bind:this={editorEl}>
        {#if !app.tracks.active}
          <div class="placeholder">
            <p>No track open.</p>
            <p><kbd>{keymap.hint('switcher')}</kbd> to switch, <code>:new name.strudel</code> or the <b>+</b> in the sidebar to create one.</p>
          </div>
        {/if}
      </div>
      <VisualsPanel />
    </div>
    {#if app.reference.open}<ReferencePanel />{/if}
  </div>
  {#if app.consoleOpen}<ConsoleDrawer />{/if}
  <StatusBar />
</div>

{#if app.quickSwitcherOpen}<QuickSwitcher />{/if}
{#if app.samples.managerOpen}<PackManager />{/if}
{#if app.tidalOpen}<TidalPanel />{/if}
{#if app.helpOpen}<HelpDialog />{/if}
{#if app.settingsOpen}<SettingsDialog />{/if}
{#if app.prompt}{#key app.prompt}<PromptDialog request={app.prompt} />{/key}{/if}

<style>
  .workbench {
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .main {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: var(--sidebar-width) 1fr auto;
  }
  .editor-col {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .editor {
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .editor :global(.cm-editor) {
    height: 100%;
  }
  .placeholder {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: var(--bg);
    color: var(--muted);
    text-align: center;
    padding: 1rem;
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.35rem 0.75rem;
    background: color-mix(in srgb, var(--accent) 18%, var(--panel));
    font-size: 0.85rem;
  }
  .banner span {
    flex: 1;
  }
  @media (max-width: 700px) {
    .main {
      grid-template-columns: 1fr;
    }
    .main > :global(.sidebar),
    .main > :global(.reference) {
      display: none;
    }
  }
</style>
