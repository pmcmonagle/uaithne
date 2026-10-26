<script lang="ts">
  // The canvas Strudel's visuals draw on: its id is the one @strudel/draw
  // looks for (getDrawContext), so pianoroll(), scope() and friends land here.
  // It stays in the page while hidden, or Strudel would make a full-window one.
  import { onMount } from 'svelte';
  import { visuals } from '$lib/adapters/strudel/visuals.svelte';
  import { app } from '$lib/app.svelte';
  import { keymap } from '$lib/keys.svelte';
  import { LAYOUT_DEFAULTS } from '$lib/layout';
  import Splitter from './Splitter.svelte';

  /** Puts a lane's canvas (made by the visual itself) into the page. */
  function mount(node: HTMLElement, canvas: HTMLCanvasElement) {
    node.append(canvas);
    return {
      update(next: HTMLCanvasElement) {
        if (next !== node.firstChild) node.replaceChildren(next);
      },
    };
  }

  let canvas: HTMLCanvasElement;

  onMount(() => {
    // A canvas Strudel made before this panel existed would win the id lookup.
    for (const stray of document.querySelectorAll('canvas#test-canvas')) if (stray !== canvas) stray.remove();
    const fit = () => {
      const ratio = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(width * ratio));
      const h = Math.max(1, Math.round(height * ratio));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };
    // Resized a frame later: changing a canvas's size inside the callback can
    // feed back into layout, which WebKit reports as a "ResizeObserver loop".
    const observer = new ResizeObserver(() => requestAnimationFrame(fit));
    observer.observe(canvas);
    fit();
    return () => observer.disconnect();
  });

  /** Leaves the editor some room. */
  const maxHeight = () => (canvas.closest('.editor-col')?.getBoundingClientRect().height ?? 400) - 120;
</script>

<section class="visuals" class:open={app.visualsOpen} style:height="{app.visualsHeight}px" aria-label="Visuals">
  <Splitter
    edge="top"
    value={app.visualsHeight}
    min={80}
    max={maxHeight}
    initial={LAYOUT_DEFAULTS.visualsHeight}
    onchange={(h) => (app.visualsHeight = h)}
  />
  <header>
    <span class="title">Visuals</span>
    <span class="hint">
      {#if app.activeAdapter?.id === 'tidal'}
        Strudel only for now: Tidal's events aren't visualised yet.
      {:else}
        {#if visuals.lanes.length}
          {visuals.lanes.length} visual{visuals.lanes.length === 1 ? '' : 's'} from your code. Use <code>._pianoroll()</code> etc.
          to show one under its line instead.
        {:else}
          A punchcard of what's playing. <code>.pianoroll()</code>, <code>.scope()</code>… in your code show here, each
          side by side.
        {/if}
      {/if}
    </span>
    <button class="icon" title="Close ({keymap.hint('visuals')})" onclick={() => app.toggleVisuals(false)}>✕</button>
  </header>
  <div class="lanes" class:hidden={!visuals.lanes.length}>
    {#each visuals.lanes as lane (lane.id)}
      <figure class="lane">
        <figcaption>{lane.kind}</figcaption>
        <div class="canvas" use:mount={lane.canvas}></div>
      </figure>
    {/each}
  </div>
  <!-- The fallback punchcard draws here, and stays in the page for Strudel's lookups. -->
  <canvas id="test-canvas" class:hidden={visuals.lanes.length > 0} bind:this={canvas}></canvas>
</section>

<style>
  .visuals {
    display: none;
    flex-direction: column;
    position: relative;
    border-top: 1px solid var(--border);
    background: var(--bg);
    flex-shrink: 0;
  }
  .visuals.open {
    display: flex;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.2rem 0.5rem 0.2rem 0.75rem;
    font-size: 0.78rem;
    color: var(--muted);
  }
  .title {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.72rem;
  }
  .hint {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  canvas {
    flex: 1;
    min-height: 0;
    width: 100%;
    display: block;
  }
  .hidden {
    display: none !important;
  }
  .lanes {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    grid-auto-rows: 1fr;
    gap: 1px;
    background: var(--border);
  }
  .lane {
    position: relative;
    margin: 0;
    min-height: 0;
    min-width: 0;
    background: var(--bg);
    display: flex;
  }
  .lane figcaption {
    position: absolute;
    top: 0.2rem;
    left: 0.4rem;
    font-size: 0.7rem;
    color: var(--muted);
    pointer-events: none;
    z-index: 1;
  }
  .lane .canvas {
    flex: 1;
    min-width: 0;
    position: relative;
  }
  /* Out of the flow, so resizing its pixels can't change the grid's layout. */
  .lane :global(canvas) {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
</style>
