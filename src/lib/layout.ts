// The window's layout (panel sizes and which panels are open), kept per
// machine in the webview's storage. The window's own size and position are
// kept by Tauri's window-state plugin.

export const LAYOUT_DEFAULTS = {
  sidebarWidth: 220,
  referenceWidth: 360,
  consoleHeight: 180,
  visualsHeight: 220,
  consoleOpen: false,
  consoleTab: 'All',
  visualsOpen: false,
  referenceOpen: false,
};

export type Layout = typeof LAYOUT_DEFAULTS;

const KEY = 'uaithne.layout';

/** The saved layout, with defaults for anything missing or malformed. */
export function loadLayout(): Layout {
  const layout = { ...LAYOUT_DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    for (const key of Object.keys(layout) as (keyof Layout)[]) {
      if (typeof saved?.[key] === typeof layout[key]) (layout as Record<string, unknown>)[key] = saved[key];
    }
  } catch {}
  return layout;
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Saves shortly after the last change, so dragging a splitter doesn't write on every move. */
export function saveLayout(layout: Layout) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(layout));
    } catch {}
  }, 300);
}
