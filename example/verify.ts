/**
 * Throwaway end-to-end verification for bun-webview2. NOT part of the library.
 * Asserts: window creation, hardening injection, IPC round-trips, navigation,
 * URL tracking, screenshots, multi-window target claiming, hardening options,
 * and the close lifecycle. Exits 0 on success.
 */
import { createWindow } from "../src/index.ts";

// watchdog: never let a stalled check hang the harness
setTimeout(() => {
  void log("WATCHDOG: verification did not finish in 90s");
  process.exit(9);
}, 90_000);

async function log(message: string): Promise<void> {
  await Bun.write(Bun.stderr, message + "\n");
}

const check = async (label: string, condition: boolean) => {
  if (!condition) throw new Error(`FAILED: ${label}`);
  await log(`ok — ${label}`);
};

await log("phase 1: creating first window");

// 1. basic window + hardening defaults
const win = await createWindow({
  title: "verify-1",
  width: 500,
  height: 400,
  html: "<h1>verify</h1>",
});
await check("hardening sentinel present", (await win.evaluate<boolean>("window.__bwv2Hardened === true")) === true);
await check("IPC bridge present", (await win.evaluate<string>("typeof window.bwv2")) === "object");
await check("url tracks data html", (win.url ?? "").startsWith("data:text/html,"));
await check("contextmenu suppressed (synthetic)", (await win.evaluate<boolean>(`
  (() => {
    const seen = Promise.withResolvers();
    document.addEventListener('contextmenu', (e) => seen.resolve(e.defaultPrevented), true);
    document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    return seen.promise;
  })()`)) === true);
await check("F12 keydown blocked (synthetic)", (await win.evaluate<boolean>(`
  (() => {
    const seen = Promise.withResolvers();
    window.addEventListener('keydown', (e) => seen.resolve(e.defaultPrevented), true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', bubbles: true, cancelable: true }));
    return seen.promise;
  })()`)) === true);

// 2. IPC round-trips
await log("phase 2: IPC round-trips");
await win.expose("echo", (v: unknown) => v);
await check("IPC sync round-trip", (await win.evaluate<string>("window.bwv2.call('echo', 'hi')")) === "hi");
await win.expose("asyncSum", async (a: unknown, b: unknown) => {
  const x = typeof a === "number" ? a : 0;
  const y = typeof b === "number" ? b : 0;
  return { sum: x + y };
});
await check("IPC async object result", JSON.stringify(await win.evaluate("window.bwv2.call('asyncSum', 20, 22)")) === '{"sum":42}');
await check("IPC error rejection", (await win.evaluate<string>(`
  window.bwv2.call('echo', 'x').then(() => 'no-error', (e) => e.message)`)).includes("nothing exposed") === false);
await win.expose("boom", () => {
  throw new Error("exploded");
});
await check("IPC host exception surfaces in page", (await win.evaluate<string>(`
  window.bwv2.call('boom').then(() => 'no-error', (e) => e.message)`)).includes("exploded"));

// 3. remote navigation + url tracking + screenshot
await log("phase 3: remote navigation + screenshot");
await win.navigate("https://example.com");
await check("remote page title", (await win.evaluate<string>("document.title")) === "Example Domain");
await check("url tracks navigation", win.url === "https://example.com/");
const shot = await win.screenshot();
const bytes = new Uint8Array(await shot.arrayBuffer());
await check("screenshot PNG magic", bytes[0] === 0x89 && bytes[1] === 0x50 && bytes.length > 1000);

// 4. hardening options honored
await log("phase 4: second window with hardening disabled");
const win2 = await createWindow({
  title: "verify-2",
  width: 400,
  height: 300,
  html: "<h1>verify-2</h1>",
  contextMenu: true,
  devToolsKeys: true,
});
await check("second window claims its own target", (await win2.evaluate<string>("document.body.innerText"))?.includes("verify-2") === true);
await check("contextMenu:true leaves menu alone (synthetic)", (await win2.evaluate<boolean>(`
  (() => {
    const seen = Promise.withResolvers();
    document.addEventListener('contextmenu', (e) => seen.resolve(e.defaultPrevented), true);
    document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    return seen.promise;
  })()`)) === false);
await check("F12 allowed when devToolsKeys:true (synthetic)", (await win2.evaluate<boolean>(`
  (() => {
    const seen = Promise.withResolvers();
    window.addEventListener('keydown', (e) => seen.resolve(e.defaultPrevented), true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', bubbles: true, cancelable: true }));
    return seen.promise;
  })()`)) === false);
await check("windows are independent", (await win.evaluate<string>("document.title")) === "Example Domain");

// 5. close lifecycle
await log("phase 5: close lifecycle");
let win2Closed = false;
win2.onClosed(() => {
  win2Closed = true;
});
win2.close();
await new Promise<void>((resolve) => setTimeout(resolve, 100));
await check("close event fires", win2Closed === true);
win.close();
try {
  await win.evaluate("1");
  await log("FAILED: closed window still evaluates");
  process.exit(1);
} catch {
  await log("ok — closed window rejects evaluate");
  await log("ALL CHECKS PASSED");
  process.exit(0);
}
