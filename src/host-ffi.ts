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
  CallWindowProcW: { args: [FFIType.pointer, FFIType.pointer, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
  TrackMouseEvent: { args: [FFIType.pointer], returns: FFIType.int },
  GetKeyState: { args: [FFIType.i32], returns: FFIType.i16 },
});
const advapi32 = dlopen("advapi32.dll", {
  RegGetValueW: { args: [FFIType.pointer, FFIType.pointer, FFIType.pointer, FFIType.u32, FFIType.u32, FFIType.pointer, FFIType.pointer], returns: FFIType.i32 },
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

// --- Window events via WndProc subclassing -------------------------------
// The flat C API has no event subscriptions, so the window's own procedure
// is replaced: interesting messages become stdout events (the parent's
// generic routing picks them up); everything chains to the original proc.

const GWL_WNDPROC = -4;
const WM_MOVE = 0x0003;
const WM_SIZE = 0x0005;
// Only non-client, window-level messages reach this procedure: input over
// the page surface goes to the WebView2 child HWND and is delivered to apps
// as page DOM events instead (src/inject.ts page-event bridge). Keys,
// mouse, wheel, and file drops therefore have no WndProc cases at all.
const WM_ACTIVATE = 0x0006;
const WM_THEMECHANGED = 0x031a;

// personalization: 1 = apps light theme, 0 = dark
const themeText = (): "light" | "dark" => {
  const value = Buffer.alloc(4);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(4, 0);
  const subkey = Buffer.from("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0", "utf16le");
  const valueName = Buffer.from("AppsUseLightTheme\0", "utf16le");
  const ok = advapi32.symbols.RegGetValueW(0x80000001n /* HKEY_CURRENT_USER */, ptr(subkey), ptr(valueName), 0x0002 /* RRF_RT_REG_DWORD */, 0, ptr(value), ptr(size));
  return ok === 0 && value.readUInt32LE(0) === 1 ? "light" : "dark";
};

const originalProc: { handle: bigint | undefined } = { handle: undefined };

const wndProc = new JSCallback(
  (hwndArg: number | bigint, msg: number | bigint, wParam: number | bigint, lParam: number | bigint) => {
    // FFI delivers u64/i64 as number or bigint; normalize once at the boundary
    const hwnd = BigInt(hwndArg);
    const msgN = Number(msg);
    const wp = BigInt.asUintN(64, BigInt(wParam));
    const lp = BigInt.asIntN(64, BigInt(lParam));
    switch (msgN) {
      case WM_MOVE: {
        const l = BigInt.asUintN(32, lp);
        emit({ event: "move", x: Number(BigInt.asIntN(16, l & 0xffffn)), y: Number(BigInt.asIntN(16, (l >> 16n) & 0xffffn)) });
        break;
      }
      case WM_SIZE: {
        const l = BigInt.asUintN(32, lp);
        emit({ event: "resize", width: Number(l & 0xffffn), height: Number((l >> 16n) & 0xffffn) });
        break;
      }
      case WM_ACTIVATE: {
        // window activation: clicks on the page activate the top window too,
        // unlike WM_SETFOCUS which the WebView2 child HWND claims.
        const active = (BigInt.asUintN(16, wp) & 0xffffn) !== 0n;
        emit({ event: active ? "focus" : "blur" });
        break;
      }
      case WM_THEMECHANGED:
        emit({ event: "theme-changed", text: themeText() });
        break;
    }
    // chain everything (handled or not) to the original procedure
    if (originalProc.handle !== undefined) {
      return user32.symbols.CallWindowProcW(originalProc.handle, hwnd, msgN, wp, lp);
    }
    return 0n;
  },
  { args: [FFIType.pointer, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
);

// Subclass the window so the parent receives native window events.
originalProc.handle = user32.symbols.SetWindowLongPtrW(hwnd, GWL_WNDPROC, BigInt(wndProc.ptr ?? 0));

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

    case "close":
      // restore the original procedure before tearing the window down
      if (originalProc.handle !== undefined) {
        user32.symbols.SetWindowLongPtrW(hwnd, GWL_WNDPROC, BigInt(originalProc.handle));
        originalProc.handle = undefined;
      }
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
