import { createWindow } from "../src/index.ts";

// A complete little app: a window, an exposed Bun function the page calls,
// a remote navigation, and a screenshot — all in one file.

const win = await createWindow({
  title: "Quickstart",
  width: 720,
  height: 480,
  html: `
    <body style="font-family: system-ui; margin: 2rem; color: #222">
      <h1>Hello from Bun ${Bun.version}</h1>
      <p>Right-click is blocked, F12 does nothing, and the button below calls a Bun function over IPC.</p>
      <button onclick="go()">Call Bun: window.bwv2.call('add', 40, 2)</button>
      <p id="out"></p>
    </body>`,
});

win.setTitle("Quickstart — bun-webview2");

await win.expose("add", (a: unknown, b: unknown) => {
  const x = typeof a === "number" ? a : 0;
  const y = typeof b === "number" ? b : 0;
  return x + y;
});

// the page calls out to Bun via the injected bridge
await win.evaluate(`
  window.go = async () => {
    document.getElementById('out').textContent = 'Result from Bun: ' + await window.bwv2.call('add', 40, 2);
  };
`);

// drive a real remote page through CDP
await win.navigate("https://example.com");
const title = await win.evaluate<string>("document.title");
console.log("Loaded:", title, "at", win.url);

await Bun.write("quickstart.png", await win.screenshot());
console.log("Screenshot saved to quickstart.png");

win.onClosed(() => {
  console.log("Window closed — exiting.");
});

setTimeout(() => win.close(), 5000);
