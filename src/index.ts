/**
 * bun-webview2 — desktop apps with Bun on Windows.
 *
 * Native WebView2 windows you fully control from Bun: navigation,
 * evaluation, typed IPC, screenshots, and window chrome, driven over the
 * Chrome DevTools Protocol. No browser UI, no tab strip, no first-run
 * nags — and no DevTools escape hatch unless you allow one.
 */

export { Webview2Window, createWindow } from "./window.ts";
export type { Webview2WindowOptions, ExposedFunction, ScreenshotFormat } from "./window.ts";
export type { HardeningOptions } from "./inject.ts";
export { CdpConnection, pickFreePort, waitForPageTarget } from "./cdp.ts";
export type { CdpTargetInfo } from "./cdp.ts";
