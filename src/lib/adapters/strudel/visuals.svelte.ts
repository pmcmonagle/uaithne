// Strudel's visuals, each on a canvas of its own. Strudel draws every visual
// on one shared canvas unless it's given a `ctx`, so:
//   - `.pianoroll()`, `.scope()`, … get a lane in the visuals panel each, in
//     the order the code calls them;
//   - `._pianoroll()`, `._scope()`, … (strudel.cc's inline form) get a canvas
//     shown under their line in the editor (./widgets.ts). The transpiler
//     passes these a widget id, once their names are registered with it.

import { Pattern } from '@strudel/core';
import { registerWidgetType } from '@strudel/transpiler';

/** Visual methods that accept `{ ctx, id }`. */
export const VISUALS = ['pianoroll', 'punchcard', 'wordfall', 'spiral', 'pitchwheel', 'scope', 'tscope', 'fscope', 'spectrum'];
/** Inline ones that look best square. */
const SQUARE = new Set(['spiral', 'pitchwheel']);
/** Inline height, in CSS pixels, unless the code gives one. */
const INLINE_HEIGHT = 80;
const SQUARE_SIZE = 200;

export interface Lane {
  /** Animation id for Strudel (unique per lane). */
  id: string;
  kind: string;
  canvas: HTMLCanvasElement;
}

/** Matches a canvas's pixel size to its size on screen (no-op while hidden). */
export function fitCanvas(canvas: HTMLCanvasElement) {
  const ratio = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * ratio);
  const h = Math.round(canvas.clientHeight * ratio);
  if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w;
    canvas.height = h;
  }
}

/** Keeps a canvas's pixel size matched to its size on screen. */
const fitter =
  typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver((entries) =>
        // A frame later, so the resize can't feed back into this layout pass.
        requestAnimationFrame(() => {
          for (const entry of entries) {
            const canvas = entry.target as HTMLCanvasElement;
            const ratio = window.devicePixelRatio || 1;
            const w = Math.max(1, Math.round(entry.contentRect.width * ratio));
            const h = Math.max(1, Math.round(entry.contentRect.height * ratio));
            if (canvas.width !== w || canvas.height !== h) {
              canvas.width = w;
              canvas.height = h;
            }
          }
        }),
      );

function makeCanvas(className: string) {
  const canvas = document.createElement('canvas');
  canvas.className = className;
  fitter?.observe(canvas);
  return canvas;
}

class Visuals {
  /** The panel's lanes for the playing code. */
  lanes = $state<Lane[]>([]);
  /** Lanes made by the evaluation in progress, swapped in if it succeeds. */
  private next: Lane[] | null = null;
  /** Canvases kept across evaluations, so the panel doesn't rebuild them. */
  private pool = new Map<string, HTMLCanvasElement>();
  private inline = new Map<string, HTMLCanvasElement>();

  beginEvaluation() {
    this.next = [];
  }

  endEvaluation(ok: boolean) {
    if (ok && this.next) this.lanes = this.next;
    this.next = null;
  }

  /** A lane for the next `kind` visual the code calls. */
  lane(kind: string): Lane {
    const list = this.next ?? [...this.lanes];
    const key = `${kind}-${list.filter((l) => l.kind === kind).length}`;
    let canvas = this.pool.get(key);
    if (!canvas) {
      canvas = makeCanvas('visual-lane');
      this.pool.set(key, canvas);
    }
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    const lane = { id: `uaithne-lane-${key}`, kind, canvas };
    list.push(lane);
    if (!this.next) this.lanes = list;
    return lane;
  }

  /** The canvas for an inline visual, by the transpiler's widget id. */
  inlineCanvas(id: string, kind: string, options: { width?: number; height?: number }): HTMLCanvasElement {
    let canvas = this.inline.get(id);
    if (!canvas) {
      canvas = makeCanvas('visual-inline');
      this.inline.set(id, canvas);
    }
    const square = SQUARE.has(kind);
    const height = options.height ?? (square ? SQUARE_SIZE : INLINE_HEIGHT);
    canvas.style.height = `${height}px`;
    canvas.style.width = options.width ? `${options.width}px` : square ? `${height}px` : '100%';
    return canvas;
  }

  getInline(id: string) {
    return this.inline.get(id);
  }
}

export const visuals = new Visuals();

let installed = false;

/** Gives each visual call a canvas of its own (once, after Strudel's modules load). */
export function installVisuals() {
  if (installed) return;
  installed = true;
  const proto = Pattern.prototype as any;
  for (const kind of VISUALS) {
    const original = proto[kind];
    if (typeof original !== 'function') continue;
    // In the panel: a lane each. A call that brings its own ctx (an inline
    // one, or wordfall calling punchcard) keeps it. Given an id, Strudel's
    // drawing shows only events tagged with it, so tag them.
    proto[kind] = function (options: Record<string, unknown> = {}) {
      if (options.ctx) return original.call(this, options);
      const lane = visuals.lane(kind);
      return original.call(this.tag(lane.id), { ...options, ctx: lane.canvas.getContext('2d'), id: lane.id });
    };
    // Inline: the transpiler calls these with the widget id first.
    registerWidgetType(`_${kind}`);
    proto[`_${kind}`] = function (id: string, options: Record<string, any> = {}) {
      const ctx = visuals.inlineCanvas(id, kind, options).getContext('2d');
      const fold = kind === 'pianoroll' || kind === 'punchcard' ? { fold: 1 } : {};
      return original.call(this.tag(id), { ...fold, ...options, ctx, id });
    };
  }
}
