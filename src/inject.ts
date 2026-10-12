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
