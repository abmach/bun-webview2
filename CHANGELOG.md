# Changelog

## 0.3.1 — 2026-10-13

- `minWidth`/`minHeight` window options: minimum window size in client
  coordinates, enforced on user drags and programmatic `setSize` alike
  (via the C library's sizing hints + `WM_GETMINMAXINFO`, with the window
  frame delta compensated). One-sided limits are rejected at creation.

## 0.3.0 — 2026-10-13

- Window layer replaced: hosts now drive the [C `webview` library](https://github.com/webview/webview) through `bun:ffi` — zero npm runtime dependencies. The DLL (~540 KB) is built once with `zig c++` (no MSVC, no cmake); sources and pinned WebView2 SDK headers live in the build workspace.
- Command channel: `bwv2_host_cmd` bound via `webview_bind`; the host replies through `webview_return`, so the page-side promise the parent awaits resolves exactly when the host applies the command — no separate ack protocol. All host JS runs re-entrantly inside `webview_run`'s native Win32 loop; there is no JS event loop to wedge.
- Window controls (decorations, always-on-top, position, min/max, focus) via FFI'd user32 on the webview's HWND.
- Parents kill their host children on exit (no orphaned hosts wedging the shared browser for the data folder).
- Why the switch: the wry/tao host's Windows "non-blocking" pump (`run_return`) could freeze a host's entire JS event loop (verified upstream, root cause in webviewjs's `app.rs`), requiring three workarounds (page-relay commands, stdout acks, resend-until-ack). The C library has no JS loop at all, eliminating the failure class.
- Window events, split by layer: window-level events (`move`, `resize`, `focus`/`blur` via `WM_ACTIVATE`, `theme-changed`) are forwarded from a subclassed window procedure (`SetWindowLongPtrW` via FFI, chained with `CallWindowProcW`); page-surface events (`key-down`/`key-up`, `mouse-*`, `scroll`, `file-drop`) are DOM events captured by an injected bridge and forwarded through the existing CDP binding. The split exists because input over the page never reaches the top-level window procedure (the WebView2 child HWND consumes it) — verified by live interaction testing.
- `file-drop` delivers `File` descriptors (name/size/type) from the DOM drop event — not filesystem paths.
- Benchmarks unchanged by the event architecture (cold ~0.8 s, evaluate/IP C sub-millisecond).

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
