# Changelog

## 0.2.1 — 2026-10-12

- Window commands no longer depend on the host process's JS event loop. On Windows, webviewjs's pump is tao's blocking `run_return()`, which can freeze a host's whole Bun loop (timers, sockets, stdin). Commands now ride the page: `window.ipc.postMessage(...)` via CDP, delivered natively by wry, acked on stdout — immune to the wedge. (stdin and TCP control channels both proved unreliable and were removed.)
- Hosts exit when their window closes (user close or `close` command) instead of lingering.
- Window events verified to flow across CDP-driven navigations in both wedged and healthy hosts (an earlier "events stop after navigation" claim was a test artifact — the probe resized to an already-current size, so no event could fire).

## 0.2.0 — 2026-10-12

- Native window events on `win.on(...)`, typed and forwarded from the host process: `move`, `resize`, `focus`, `blur`, `key-down`, `key-up`, `mouse-enter/leave/down/up`, `scroll`, `file-drop` (drag & drop), `file-hover`, `file-hover-cancel`, `theme-changed`.
- `win.cdp` — direct access to the live CDP connection (Network, DOM, Input, Emulation, …).
- `serveApp(handler)` — serve app content from Bun on a free loopback port (fetch-style `Request → Response`); the answer to custom protocols.

## 0.1.0 — 2026-10-12

Initial release.

- `Webview2Window` / `createWindow`: native WebView2 windows on Windows, created and controlled from Bun.
- One host process per window (`src/host.ts` via `@webviewjs/webview`): wry/tao only supports window creation before its event loop is ever pumped, so each window gets a fresh, proven creation context — plus per-window crash isolation.
- Page control over CDP loopback: `navigate`, `setHTML`, `evaluate`, `screenshot`.
- Page → Bun IPC via `win.expose()` / `window.bwv2.call()`, JSON round-tripped, error propagation included.
- Default hardening: Chromium context menu and DevTools/browser accelerators blocked (opt out with `contextMenu` / `devToolsKeys`).
- Native window controls proxied: title, size, position, decorations, always-on-top, focus, minimize, maximize.
- Content deliberately never flows through wry's `loadUrl`/`loadHtml` (first-navigation stall); everything is delivered via CDP.
- Targets are "primed" with one throwaway `about:blank` navigation before CDP setup: on a never-navigated webview, `Runtime.enable` and even `Page.navigate` can wedge forever.
- Per-app WebView2 data folder (`dataDir` option; default keyed to the project directory) so different Bun webview apps don't share one browser process; same-app second processes are treated as single-instance conflicts.
- `BWV2_HOST_EXE` lets compiled executables ship a pre-compiled host binary.
- Every CDP call rejects after a timeout (default 30s) instead of hanging forever on a wedged target; the target-wait failure names its likely causes (second app instance, hard-killed previous run) and remedies.
