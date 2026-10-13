/**
 * Child host process (FFI flavor): owns exactly one native window + webview
 * driven directly through the C webview library via bun:ffi — no wry, no
 * tao, no napi addons.
 *
 * Command channel: the parent CDP-evaluates bwv2_host_cmd("<json>") in the
 * page; the C library delivers it to the bind callback re-entrantly on the
 * GUI thread (the only JS that runs here — webview_run blocks the JS loop by
 * design, and this host deliberately has no other JS machinery to lose to a
 * wedged loop). Replies flow back synchronously: webview_return resolves the
 * page-side promise the parent awaits, so a resolved call IS the ack.
 *
 * Lifecycle: user close button or the "close" command ends webview_run; we
 * emit "closed" on stdout and exit. Stdout JSON lines are the only
 * host→parent channel needed.
 */

import { dlopen, FFIType, JSCallback, ptr } from "bun:ffi";

interface HostConfig {
  readonly title: string;
  readonly width: number;
  readonly height: number;
}

interface HostCommand {
  readonly op: string;
  readonly args?: unknown[];
}

// Config is always the last argv element: [bun, host-ffi.ts, config].
const config = JSON.parse(process.argv[process.argv.length - 1] ?? "{}") as Partial<HostConfig>;

const dllPath = Bun.env.BWV2_NATIVE_LIB ?? `${import.meta.dir}/../native/webview.dll`;

const webview = dlopen(dllPath, {
  webview_create: { args: [FFIType.int, FFIType.pointer], returns: FFIType.pointer },
  webview_run: { args: [FFIType.pointer], returns: FFIType.int },
  webview_terminate: { args: [FFIType.pointer], returns: FFIType.int },
  webview_navigate: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.int },
  webview_set_title: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.int },
  webview_set_size: { args: [FFIType.pointer, FFIType.int, FFIType.int, FFIType.int], returns: FFIType.int },
  webview_get_window: { args: [FFIType.pointer], returns: FFIType.pointer },
  webview_bind: { args: [FFIType.pointer, FFIType.pointer, FFIType.pointer, FFIType.pointer], returns: FFIType.int },
  webview_return: { args: [FFIType.pointer, FFIType.pointer, FFIType.int, FFIType.pointer], returns: FFIType.int },
});

// Win32 window controls the C API doesn't cover.
const user32 = dlopen("user32.dll", {
  SetWindowPos: { args: [FFIType.pointer, FFIType.i64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.int },
  GetWindowLongPtrW: { args: [FFIType.pointer, FFIType.i32], returns: FFIType.i64 },
  SetWindowLongPtrW: { args: [FFIType.pointer, FFIType.i32, FFIType.i64], returns: FFIType.i64 },
  GetWindowRect: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.int },
  GetClientRect: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.int },
  ShowWindow: { args: [FFIType.pointer, FFIType.i32], returns: FFIType.int },
  SetForegroundWindow: { args: [FFIType.pointer], returns: FFIType.int },
});

const cstr = (s: string) => ptr(Buffer.from(`${s}\0`, "utf8"));

const WEBVIEW_HINT_NONE = 0;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const GWL_STYLE = -16;
const WS_OVERLAPPEDWINDOW = 0x00cf0000;
const SW_MINIMIZE = 6;
const SW_MAXIMIZE = 3;
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;

if (Bun.env.BWV2_DEBUG === "1") console.error("[host-ffi] started");

const handle = webview.symbols.webview_create(0, null);
if (handle === 0n || handle === 0) {
  console.error("[host-ffi] webview_create failed");
  process.exit(1);
}
const hwnd = webview.symbols.webview_get_window(handle);

const emit = (payload: Record<string, unknown>): void => {
  console.log(JSON.stringify(payload));
};

function applyCommand(command: HostCommand): string {
  const args = command.args ?? [];
  switch (command.op) {
    case "hello":
      return "true";
    case "setTitle":
      return String(webview.symbols.webview_set_title(handle, cstr(String(args[0]))));
    case "setSize":
      return String(webview.symbols.webview_set_size(handle, Number(args[0]), Number(args[1]), WEBVIEW_HINT_NONE));
    case "setPosition": {
      const result = user32.symbols.SetWindowPos(
        hwnd,
        0n,
        Number(args[0]),
        Number(args[1]),
        0,
        0,
        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
      );
      return String(result);
    }
    case "setDecorations": {
      const current = user32.symbols.GetWindowLongPtrW(hwnd, GWL_STYLE);
      const decorationsOn = Boolean(args[0]);
      const masked = BigInt(current) & ~BigInt(WS_OVERLAPPEDWINDOW);
      const updated = decorationsOn ? masked | BigInt(WS_OVERLAPPEDWINDOW) : masked;
      const result = user32.symbols.SetWindowLongPtrW(hwnd, GWL_STYLE, updated);
      user32.symbols.SetWindowPos(hwnd, 0n, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
      return String(result);
    }
    case "setAlwaysOnTop": {
      const insertAfter = args[0] ? BigInt(HWND_TOPMOST) : BigInt(HWND_NOTOPMOST);
      const result = user32.symbols.SetWindowPos(hwnd, insertAfter, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
      return String(result);
    }
    case "focus":
      return String(user32.symbols.SetForegroundWindow(hwnd));
    case "minimize":
      return String(user32.symbols.ShowWindow(hwnd, SW_MINIMIZE));
    case "maximize":
      return String(user32.symbols.ShowWindow(hwnd, SW_MAXIMIZE));
    case "queryState": {
      const outer = Buffer.alloc(16); // RECT: left, top, right, bottom (i32 each)
      const inner = Buffer.alloc(16);
      if (user32.symbols.GetWindowRect(hwnd, ptr(outer)) === 0) return "null";
      if (user32.symbols.GetClientRect(hwnd, ptr(inner)) === 0) return "null";
      // client size (what tao's resize events report) + outer frame position
      return JSON.stringify({
        x: outer.readInt32LE(0),
        y: outer.readInt32LE(4),
        width: inner.readInt32LE(8) - inner.readInt32LE(0),
        height: inner.readInt32LE(12) - inner.readInt32LE(4),
      });
    }
    case "close":
      webview.symbols.webview_terminate(handle);
      return "true";
    default:
      return "null";
  }
}

const bindCallback = new JSCallback(
  (id: string, req: string) => {
    if (Bun.env.BWV2_DEBUG === "1") console.error(`[host-ffi] op: ${req.slice(0, 80)}`);
    let result = "null";
    try {
      const parsed = JSON.parse(req) as unknown[];
      const payload = typeof parsed[0] === "string" ? (JSON.parse(parsed[0]) as HostCommand) : (parsed[0] as HostCommand);
      result = applyCommand(payload);
    } catch (err) {
      console.error("[host-ffi] command failed:", err);
    }
    webview.symbols.webview_return(handle, cstr(id), 0, cstr(result));
  },
  { args: [FFIType.cstring, FFIType.cstring, FFIType.pointer], returns: FFIType.void },
);

webview.symbols.webview_set_title(handle, cstr(config.title ?? "bun-webview2"));
webview.symbols.webview_set_size(handle, config.width ?? 800, config.height ?? 600, WEBVIEW_HINT_NONE);
webview.symbols.webview_bind(handle, cstr("bwv2_host_cmd"), bindCallback.ptr, null);

// about:blank keeps the initial document inert; the parent drives all real
// content over CDP.
webview.symbols.webview_navigate(handle, cstr("about:blank"));

webview.symbols.webview_run(handle);
// run() returning means the window closed (user X or the "close" command).
emit({ event: "closed" });
process.exit(0);
