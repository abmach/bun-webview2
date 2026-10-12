# Changelog

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
