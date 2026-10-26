<script lang="ts">
  // A drag handle on one edge of a panel (whose position must not be static).
  // `edge` is the side the handle sits on; dragging it away from the panel
  // makes the panel bigger. Double-click restores the default size.

  let {
    edge,
    value,
    min,
    max,
    initial,
    onchange,
  }: {
    edge: 'left' | 'right' | 'top';
    value: number;
    min: number;
    /** A function, since the room available changes with the window. */
    max: () => number;
    initial: number;
    onchange: (value: number) => void;
  } = $props();

  let start: { at: number; value: number } | null = null;
  const at = (e: PointerEvent) => (edge === 'top' ? e.clientY : e.clientX);
  const clamp = (v: number) => Math.round(Math.max(min, Math.min(Math.max(min, max()), v)));

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    start = { at: at(e), value };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function move(e: PointerEvent) {
    if (!start) return;
    const moved = at(e) - start.at;
    onchange(clamp(start.value + (edge === 'right' ? moved : -moved)));
  }
</script>

<div
  class="splitter {edge}"
  role="separator"
  aria-orientation={edge === 'top' ? 'horizontal' : 'vertical'}
  title="Drag to resize, double-click to reset"
  onpointerdown={down}
  onpointermove={move}
  onpointerup={() => (start = null)}
  onpointercancel={() => (start = null)}
  ondblclick={() => onchange(clamp(initial))}
></div>

<style>
  .splitter {
    position: absolute;
    z-index: 3;
  }
  .splitter:hover {
    background: color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .top {
    top: -3px;
    left: 0;
    right: 0;
    height: 6px;
    cursor: ns-resize;
  }
  .left,
  .right {
    top: 0;
    bottom: 0;
    width: 6px;
    cursor: ew-resize;
  }
  .left {
    left: -3px;
  }
  .right {
    right: -3px;
  }
</style>
