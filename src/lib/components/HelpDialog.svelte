<script lang="ts">
  import { app } from '$lib/app.svelte';
  import { bindable, COMMANDS, eventKeys, keymap, showKeys, type CommandId } from '$lib/keys.svelte';
  import { exCommands, shortcutGroups, type Shortcut } from '$lib/shortcuts';

  const GROUPS = ['Playing', 'Tracks and panels', 'Volume'] as const;

  /** The command waiting for new keys, and what happened last. */
  let capturing = $state<CommandId | null>(null);
  let note = $state<{ id: CommandId; text: string; error?: boolean } | null>(null);

  const close = () => {
    stopCapture();
    app.helpOpen = false;
    app.editor?.focus();
  };

  function startCapture(id: CommandId) {
    capturing = id;
    note = null;
    app.capturingKeys = true;
  }

  function stopCapture() {
    capturing = null;
    app.capturingKeys = false;
  }

  const does = (id: CommandId) => COMMANDS.find((c) => c.id === id)!.does;

  // Capture phase, so the new keys don't also run whatever they're bound to.
  function onkeydowncapture(e: KeyboardEvent) {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return stopCapture();
    const keys = eventKeys(e);
    if (!keys) return; // a modifier on its own: wait for the rest
    const id = capturing;
    if (!bindable(keys)) {
      note = { id, text: `${showKeys(keys)} would get in the way of typing: use Ctrl or Alt with it, or a function key.`, error: true };
      return;
    }
    const lost = keymap.bind(id, keys);
    stopCapture();
    note = lost.length ? { id, text: `${showKeys(keys)} was taken from: ${lost.map(does).join('; ')}` } : null;
    void app.saveKeybindings();
  }

  function reset(id: CommandId) {
    keymap.reset(id);
    note = null;
    void app.saveKeybindings();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
</script>

<svelte:window {onkeydowncapture} {onkeydown} />

{#snippet rows(items: Shortcut[])}
  {#each items as item (item.does)}
    <tr>
      <td class="keys">
        {#each item.keys as key, i (key)}{#if i}<span class="or"> / </span>{/if}<kbd>{key}</kbd>{/each}
      </td>
      <td>{item.does}</td>
    </tr>
  {/each}
{/snippet}

<div class="backdrop" role="presentation" onclick={close}></div>
<div class="dialog" role="dialog" aria-label="Keyboard shortcuts">
  <header>
    <h2>Keyboard shortcuts</h2>
    <button class="icon" title="Close (Esc)" onclick={close}>✕</button>
  </header>
  <div class="columns">
    <div>
      {#each GROUPS as group (group)}
        <h3>{group}</h3>
        <table>
          <tbody>
            {#each COMMANDS.filter((c) => c.group === group) as command (command.id)}
              {@const keys = keymap.keysFor(command.id)}
              <tr class="command" class:changed={keymap.isChanged(command.id)}>
                <td class="keys">
                  <button class="rebind" title="Click, then press the new keys" onclick={() => startCapture(command.id)}>
                    {#if capturing === command.id}
                      <span class="press">Press keys… (Esc cancels)</span>
                    {:else if keys.length}
                      {#each keys as key, i (key)}{#if i}<span class="or"> / </span>{/if}<kbd>{showKeys(key)}</kbd>{/each}
                    {:else}
                      <span class="none">none</span>
                    {/if}
                  </button>
                </td>
                <td>
                  {command.does}
                  {#if keymap.isChanged(command.id)}
                    <button class="icon reset" title="Back to {command.defaults.map(showKeys).join(' / ')}" onclick={() => reset(command.id)}>↺</button>
                  {/if}
                  {#if note?.id === command.id}<div class="note" class:error={note.error}>{note.text}</div>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/each}
      <p class="hint">Click a shortcut to change it. Changes are saved for this computer.</p>
      {#each shortcutGroups as group (group.title)}
        <h3>{group.title}</h3>
        <table><tbody>{@render rows(group.items)}</tbody></table>
      {/each}
    </div>
    <div>
      <h3>Vim commands</h3>
      <table><tbody>{@render rows(exCommands)}</tbody></table>
      <p class="hint">On macOS, Cmd works wherever Ctrl is shown.</p>
    </div>
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
    top: 6vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(860px, calc(100vw - 32px));
    max-height: 88vh;
    overflow-y: auto;
    padding: 1rem 1.25rem;
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
    margin: 0.9rem 0 0.3rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }
  .columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0 2rem;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.85rem;
  }
  td {
    padding: 0.2rem 0;
    vertical-align: top;
  }
  td.keys {
    white-space: nowrap;
    padding-right: 1rem;
    width: 1%;
  }
  kbd {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    padding: 0.05rem 0.35rem;
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: 4px;
    background: var(--bg);
  }
  .or {
    color: var(--muted);
  }
  button.rebind {
    padding: 0.05rem 0.2rem;
    margin-left: -0.2rem;
    background: none;
    border: 1px solid transparent;
    text-align: left;
  }
  button.rebind:hover {
    border-color: var(--border);
    filter: none;
  }
  .press {
    color: var(--accent);
    font-size: 0.8rem;
  }
  .none {
    color: var(--muted);
    font-style: italic;
  }
  tr.changed kbd {
    border-color: var(--accent);
  }
  button.reset {
    font-size: 0.85rem;
  }
  .note {
    font-size: 0.78rem;
    color: var(--muted);
  }
  .note.error {
    color: var(--error);
  }
  .hint {
    color: var(--muted);
    font-size: 0.8rem;
  }
  @media (max-width: 640px) {
    .columns {
      grid-template-columns: 1fr;
    }
  }
</style>
