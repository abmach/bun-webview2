/**
 * Scripts injected into every new document via Page.addScriptToEvaluateOnNewDocument.
 *
 * Two concerns live here:
 *
 * 1. Hardening — bun-webview2 windows are app windows, not browser windows.
 *    By default the Chromium right-click menu and the browser accelerators
 *    that leak app-ness (F12, Ctrl+Shift+I/J/C, Ctrl+U/S/P) are disabled.
 *    Both are gateable per-window via the constructor options.
 *
 * 2. IPC bridge — exposes `window.bwv2.call(name, ...args)` returning a
 *    Promise. Calls travel to Bun through a Runtime binding; results travel
 *    back through a resolve callback the host evaluates.
 */

export interface HardeningOptions {
  /** Allow the native Chromium right-click context menu. Default: false (blocked). */
  readonly contextMenu?: boolean;
  /** Allow DevTools/browser accelerators (F12, Ctrl+Shift+I/J/C, Ctrl+U/S/P). Default: false (blocked). */
  readonly devToolsKeys?: boolean;
}

export function buildHardeningScript(opts: HardeningOptions): string {
  const blocks: string[] = ["Object.defineProperty(window, '__bwv2Hardened', { value: true });"];

  if (!opts.contextMenu) {
    blocks.push(
      "document.addEventListener('contextmenu', (e) => e.preventDefault(), true);",
    );
  }

  if (!opts.devToolsKeys) {
    blocks.push(`
window.addEventListener('keydown', (e) => {
  const reservedCombo =
    e.key === 'F12' ||
    (e.ctrlKey && e.shiftKey && ['KeyI', 'KeyJ', 'KeyC'].includes(e.code)) ||
    (e.ctrlKey && !e.shiftKey && ['KeyU', 'KeyS', 'KeyP'].includes(e.code));
  if (reservedCombo) e.preventDefault();
}, true);`,
    );
  }

  return `(() => { ${blocks.join("\n")} })();`;
}

/**
 * IPC bridge. Always injected; inert until the app calls `window.expose()`.
 * Payloads are single JSON strings because CDP bindings take one string arg.
 */
export function buildIpcBridgeScript(): string {
  return `(() => {
  if (window.bwv2) return;
  const pending = new Map();
  let nextId = 1;
  window.bwv2 = {
    call(name, ...args) {
      const id = nextId++;
      const settled = Promise.withResolvers();
      pending.set(id, settled);
      window.__bwv2Ipc(JSON.stringify({ id, name, args }));
      return settled.promise;
    },
  };
  window.__bwv2Resolve = (id, ok, value) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok) entry.resolve(value);
    else entry.reject(new Error(typeof value === 'string' ? value : value?.message ?? String(value)));
  };
})();`;
}

/**
 * Page-surface events: input over the page never reaches the host's window
 * procedure (the WebView2 child HWND consumes it), so keys, mouse, wheel,
 * and drag-and-drop are captured as DOM events and forwarded through the
 * existing __bwv2Ipc binding. DOM events are also richer than the Win32
 * equivalents: KeyboardEvent carries layout/IME-aware key and code, and
 * the drop event exposes File objects (readable content) rather than paths.
 */
export function buildPageEventsScript(): string {
  return `(() => {
  if (window.__bwv2PageEvents) return;
  Object.defineProperty(window, '__bwv2PageEvents', { value: true });
  const send = (name, payload) =>
    window.__bwv2Ipc(JSON.stringify({ id: -1, name: '__event', args: [name, payload] }));
  const mods = (e) =>
    (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
  document.addEventListener('keydown', (e) =>
    send('key-down', { key: e.key, code: e.code, modifiers: mods(e), isRepeat: e.repeat }), true);
  document.addEventListener('keyup', (e) =>
    send('key-up', { key: e.key, code: e.code, modifiers: mods(e) }), true);
  document.addEventListener('mousedown', (e) =>
    send('mouse-down', { x: e.clientX, y: e.clientY, button: e.button, modifiers: mods(e) }), true);
  document.addEventListener('mouseup', (e) =>
    send('mouse-up', { x: e.clientX, y: e.clientY, button: e.button, modifiers: mods(e) }), true);
  document.addEventListener('mouseenter', () => send('mouse-enter', {}), true);
  document.addEventListener('mouseleave', () => send('mouse-leave', {}), true);
  document.addEventListener('wheel', (e) =>
    send('scroll', { deltaX: e.deltaX, deltaY: e.deltaY }), { capture: true, passive: true });
  // drag-and-drop: prevent the browser default and forward the files
  document.addEventListener('dragover', (e) => { e.preventDefault(); send('file-drop', { hover: true }); }, true);
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])].map((f) => ({ name: f.name, size: f.size, type: f.type }));
    send('file-drop', { files });
  }, true);
})();`;
}
