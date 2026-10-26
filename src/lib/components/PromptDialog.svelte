<script lang="ts">
  import { untrack } from 'svelte';
  import type { PromptRequest } from '$lib/app.svelte';

  let { request }: { request: PromptRequest } = $props();
  let value = $state(untrack(() => request.initial ?? ''));
  let input = $state<HTMLInputElement>();
  let ok = $state<HTMLButtonElement>();

  $effect(() => {
    if (input) {
      input.focus();
      // Select the name, not the folder or extension, like most file renames.
      const initial = untrack(() => value);
      const start = initial.lastIndexOf('/') + 1;
      const dot = initial.lastIndexOf('.');
      input.setSelectionRange(start, dot > start ? dot : initial.length);
    } else {
      ok?.focus();
    }
  });

  const isConfirm = $derived(request.initial === undefined);
  const submit = () => request.resolve(isConfirm ? 'yes' : value.trim() || null);

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') request.resolve(null);
    else if (e.key === 'Enter') submit();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
</script>

<div class="backdrop" role="presentation" onclick={() => request.resolve(null)}></div>
<div class="dialog" role="dialog" aria-label={request.title} tabindex="-1" {onkeydown}>
  <p>{request.title}</p>
  {#if !isConfirm}
    <input bind:this={input} bind:value spellcheck="false" />
  {/if}
  <div class="buttons">
    <button onclick={() => request.resolve(null)}>Cancel</button>
    <button bind:this={ok} class={isConfirm ? 'danger' : 'primary'} onclick={submit}>{isConfirm ? 'Delete' : 'OK'}</button>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 20;
  }
  .dialog {
    position: fixed;
    top: 20vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(460px, calc(100vw - 32px));
    padding: 1rem;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    z-index: 21;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  p {
    margin: 0;
  }
  input {
    padding: 0.45rem 0.6rem;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
