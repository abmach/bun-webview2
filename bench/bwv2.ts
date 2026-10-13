/**
 * Throwaway benchmark: one iteration through bun-webview2's API.
 * Prints one JSON line. NOT part of the library.
 */
import { createWindow } from "../src/index.ts";

const t0 = performance.now();
const win = await createWindow({ title: "bench-bwv2", width: 500, height: 400, html: "<h1>bench</h1>" });
const coldMs = performance.now() - t0;

await win.evaluate("1"); // warmup
let evalTotal = 0;
for (let i = 0; i < 20; i++) {
  const s = performance.now();
  await win.evaluate("1+1");
  evalTotal += performance.now() - s;
}
const evalAvg = evalTotal / 20;

await win.expose("echo", (v: unknown) => v);
const ipcAvg = (await win.evaluate<number>(`
  (async () => {
    await window.bwv2.call('echo', 0);
    const t = performance.now();
    for (let i = 0; i < 20; i++) await window.bwv2.call('echo', i);
    return (performance.now() - t) / 20;
  })()`)) ?? -1;

const navStart = performance.now();
await win.navigate("data:text/html,<title>nav2</title><h1>navigated</h1>");
const navMs = performance.now() - navStart;

await win.closeGracefully();
console.log(
  JSON.stringify({
    lib: "bun-webview2",
    cold_ms: Math.round(coldMs),
    eval_avg_ms: +evalAvg.toFixed(2),
    ipc_avg_ms: +ipcAvg.toFixed(2),
    nav_ms: Math.round(navMs),
  }),
);
process.exit(0);
