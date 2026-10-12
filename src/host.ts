/**
 * Child host process: owns exactly one native window + webview, then serves
 * window-control commands on stdin and emits events on stdout.
 *
 * This runs in its own Bun process (spawned per window by bun-webview2).
 * wry/tao only reliably supports window creation before the native event
 * loop has ever been pumped, so one fresh process per window is the only
 * proven creation context. All page content is driven by the parent over
 * CDP — this process never navigates anything.
 */

import { Application } from "@webviewjs/webview";

interface HostConfig {
  readonly title: string;
  readonly width: number;
  readonly height: number;
}

interface HostCommand {
  readonly op: string;
  readonly args?: unknown[];
}

// Config is always the last argv element: [bun, host.ts, config] when run by
// the library, [host.exe, config] when run as a compiled host binary.
const config = JSON.parse(process.argv[process.argv.length - 1] ?? "{}") as Partial<HostConfig>;
const app = new Application();
const win = app.createBrowserWindow({
  title: config.title ?? "bun-webview2",
  width: config.width ?? 800,
  height: config.height ?? 600,
});
win.createWebview({});
app.run();

const emit = (payload: Record<string, unknown>): void => {
  console.log(JSON.stringify(payload));
};

win.on("close", () => emit({ event: "closed" }));

// Forward tao window events to the parent (one JSON line per event).
// Payloads come from the typed wrapper; the parent trusts its own child.
const forwardedEvents = [
  "move",
  "resize",
  "focus",
  "blur",
  "key-down",
  "key-up",
  "mouse-enter",
  "mouse-leave",
  "mouse-down",
  "mouse-up",
  "scroll",
  "file-drop",
  "file-hover",
  "file-hover-cancel",
  "theme-changed",
] as const;
for (const eventName of forwardedEvents) {
  // payload shape varies per event; the child emits, the parent types
  win.on(eventName, (payload: unknown) => emit(payload as Record<string, unknown>));
}

// stdin: one JSON command per line
const decoder = new TextDecoder();
let buffer = "";
await Bun.stdin.stream().pipeTo(
  new WritableStream<Uint8Array>({
    write(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          const command = JSON.parse(line) as HostCommand;
          applyCommand(command);
        }
        newline = buffer.indexOf("\n");
      }
    },
  }),
);

function applyCommand(command: HostCommand): void {
  const args = command.args ?? [];
  switch (command.op) {
    case "setTitle":
      win.setTitle(String(args[0]));
      break;
    case "setSize":
      win.setSize(Number(args[0]), Number(args[1]));
      break;
    case "setPosition":
      win.setPosition(Number(args[0]), Number(args[1]));
      break;
    case "setDecorations":
      win.setDecorations(Boolean(args[0]));
      break;
    case "setAlwaysOnTop":
      win.setAlwaysOnTop(Boolean(args[0]));
      break;
    case "focus":
      win.focus();
      break;
    case "minimize":
      win.setMinimized(true);
      break;
    case "maximize":
      win.setMaximized(true);
      break;
    case "close":
      win.close();
      break;
  }
}
