/**
 * Throwaway benchmark: one iteration through raw @webviewjs/webview,
 * mirroring its documented usage (quickstart + IPC guide). Prints one JSON
 * line. NOT part of the library. Their loadHtml/loadUrl path is known to
 * stall on this machine; every wait is bounded and reported as -1 on timeout.
 */
import { Application } from "@webviewjs/webview";

const TIMEOUT_MS = 120_000;
const t0 = performance.now();

const app = new Application();
const win = app.createBrowserWindow({ title: "bench-wvjs", width: 500, height: 400 });
const webview = win.createWebview({});
const loaded = Promise.withResolvers<void>();
webview.on("page-load-finished", () => loaded.resolve());
webview.loadHtml("<h1>bench</h1>");
app.run();

const coldMs = await Promise.race([
  loaded.promise.then(() => performance.now() - t0),
  Bun.sleep(TIMEOUT_MS).then(() => -1),
]);

const evalOnce = (js: string) =>
  new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("eval-timeout")), 10_000);
    webview.evaluateScriptWithCallback(js, (result: unknown) => {
      clearTimeout(timer);
      resolve(result);
    });
  });

let evalAvg = -1;
let ipcAvg = -1;
let navMs = -1;

if (coldMs >= 0) {
  try {
    await evalOnce("1"); // warmup
    let evalTotal = 0;
    for (let i = 0; i < 20; i++) {
      const s = performance.now();
      await evalOnce("1+1");
      evalTotal += performance.now() - s;
    }
    evalAvg = evalTotal / 20;
  } catch {
    evalAvg = -1;
  }

  try {
    webview.expose("native", { echo: async (v: unknown) => v });
    ipcAvg = Number(
      (await evalOnce(`
        (async () => {
          await window.native.echo(0);
          const t = performance.now();
          for (let i = 0; i < 20; i++) await window.native.echo(i);
          return (performance.now() - t) / 20;
        })()`)) ?? -1,
    );
  } catch {
    ipcAvg = -1;
  }

  try {
    const navLoaded = Promise.withResolvers<void>();
    const unsub = webview.on("page-load-finished", () => navLoaded.resolve());
    const navStart = performance.now();
    webview.loadUrl("data:text/html,<title>nav2</title><h1>navigated</h1>");
    const nav = await Promise.race([navLoaded.promise, Bun.sleep(30_000).then(() => "timeout" as const)]);
    unsub();
    if (nav !== "timeout") navMs = performance.now() - navStart;
  } catch {
    navMs = -1;
  }
}

console.log(
  JSON.stringify({
    lib: "webviewjs",
    cold_ms: coldMs < 0 ? -1 : Math.round(coldMs),
    eval_avg_ms: +evalAvg.toFixed(2),
    ipc_avg_ms: +ipcAvg.toFixed(2),
    nav_ms: navMs < 0 ? -1 : Math.round(navMs),
  }),
);
process.exit(0);
