/**
 * Child host process: owns exactly one native window + webview, then serves
 * window-control commands arriving over wry's page→host IPC and emits events
 * on stdout.
 *
 * This runs in its own Bun process (spawned per window by bun-webview2).
 * wry/tao only supports window creation before the native event loop has ever
 * been pumped, so one fresh process per window is the only proven creation
 * context. All page content is driven by the parent over CDP — this process
 * never navigates anything itself.
 *
 * IMPORTANT (from the webviewjs repo, packages/webview/src/app.rs): on
 * Windows their "non-blocking" pump is tao's blocking run_return(), which
 * sometimes never returns control to JS. In that state this process's own
 * Bun event loop (timers, sockets, stdin) is dead — so this file must NEVER
 * depend on it. Everything below rides the two channels that keep working
 * inside that wedge:
 *   - commands: wry IPC — the parent CDP-evaluates window.ipc.postMessage(...)
 *     in the page, wry delivers it natively to our handler below;
 *   - events: console.log lines on stdout, which the parent watches.
 */

import { Application } from "@webviewjs/webview";

interface HostConfig {
  readonly title: string;
  readonly width: number;
  readonly height: number;
}

interface HostCommand {
  readonly id?: number;
  readonly op: string;
  readonly args?: unknown[];
}

// Config is always the last argv element: [bun, host.ts, config] when run by
// the library, [host.exe, config] when run as a compiled host binary.
const config = JSON.parse(process.argv[process.argv.length - 1] ?? "{}") as Partial<HostConfig>;
if (Bun.env.BWV2_DEBUG === "1") console.error("[host] started");
const app = new Application();
const win = app.createBrowserWindow({
  title: config.title ?? "bun-webview2",
  width: config.width ?? 800,
  height: config.height ?? 600,
});
const webview = win.createWebview({});
app.run();

const emit = (payload: Record<string, unknown>): void => {
  console.log(JSON.stringify(payload));
};

// Window closed (user close button or the "close" command): emit, then exit.
// The pump may be wedged, so natural process exit can never be relied on.
win.on("close", () => {
  emit({ event: "closed" });
  process.exit(0);
});

// Command channel: parent -> page (window.ipc via CDP) -> wry IPC -> here.
// wry calls this handler natively (re-entrant into JS), even when this
// process's own event loop is wedged inside the tao pump.
webview.onIpcMessage((msg) => {
  const line = msg.body.toString();
  if (line.trim().length === 0) return;
  if (Bun.env.BWV2_DEBUG === "1") console.error(`[host] op: ${line.slice(0, 80)}`);
  const command = JSON.parse(line) as HostCommand;
  if (command.op !== "hello") applyCommand(command);
  // ack after applying — the parent resends until this arrives
  if (typeof command.id === "number") emit({ event: "ack", id: command.id });
});

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
  "file-hover-cancelled",
  "theme-changed",
] as const;
for (const eventName of forwardedEvents) {
  // payload shape varies per event; the child emits, the parent types
  win.on(eventName, (payload: unknown) => emit(payload as Record<string, unknown>));
}

function applyCommand(command: HostCommand): void {
  const args = command.args ?? [];
  switch (command.op) {
    case "hello":
      break;
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
      // emit before teardown: the window's destruction races stdout flushing
      win.close();
      break;
  }
}
