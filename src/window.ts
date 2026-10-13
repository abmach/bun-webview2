/**
 * Webview2Window — a native WebView2 window fully controlled from Bun.
 *
 * Architecture: each window is owned by a dedicated child host process
 * (src/host.ts) running @webviewjs/webview (tao + wry over the system
 * WebView2 runtime); the page inside it is driven by this process over the
 * Chrome DevTools Protocol via a loopback WebSocket.
 *
 * Why one process per window: wry/tao only supports window creation before
 * its native event loop has ever been pumped, so a second window from a
 * live host deadlocks at the native level. Fresh process = the only proven
 * creation context, plus per-window crash isolation.
 *
 * Why commands ride the page: on Windows, webviewjs's "non-blocking" pump
 * is tao's blocking run_return(), which sometimes never returns control to
 * JS (verified in their app.rs and reproduced here). A wedged host has a
 * dead Bun event loop — timers, sockets, stdin are all gone — but tao
 * still processes window messages and re-enters JS through native
 * ThreadsafeFunction callbacks. So parent→host commands are delivered by
 * CDP-evaluating window.ipc.postMessage(...) in the page (wry delivers it
 * natively to the host), and host→parent events arrive on stdout, which
 * works in both wedged and healthy states.
 */

import { CdpConnection, pickFreePort, waitForPageTarget, type CdpTargetInfo } from "./cdp.ts";
import { buildHardeningScript, buildIpcBridgeScript, buildPageEventsScript, type HardeningOptions } from "./inject.ts";

export interface Webview2WindowOptions extends HardeningOptions {
  readonly title?: string;
  readonly width?: number;
  readonly height?: number;
  /** Minimum window size. Both must be set together — one-sided limits are rejected. */
  readonly minWidth?: number;
  /** @see minWidth */
  readonly minHeight?: number;
  /** Initial URL to load. */
  readonly url?: string;
  /** Initial inline HTML to load (delivered as a data: URL). */
  readonly html?: string;
  /** Seconds to wait for a navigation's load event before rejecting. Default 30. */
  readonly navigationTimeoutSeconds?: number;
  /** Fixed CDP port. Default: a free port is picked. All windows of an app share one port. */
  readonly port?: number;
  /**
   * WebView2 user-data folder for this app (cookies, storage, cache).
   * Default: `%LOCALAPPDATA%\bun-webview2\<hash of the project directory>`.
   * App-wide — the first window's value wins. One browser process serves one
   * data folder: a second *app process* using the same folder attaches to the
   * first one's WebView2 browser and its own CDP port never appears — treat
   * it as a single-instance guard.
   */
  readonly dataDir?: string;
}

export type ExposedFunction = (...args: unknown[]) => unknown | Promise<unknown>;

export interface ScreenshotFormat {
  readonly format?: "png" | "jpeg";
  readonly quality?: number;
}

/** Typed payloads for `win.on(...)`, mirroring tao's window events. */
export interface WindowEventPayloads {
  move: { readonly x: number; readonly y: number };
  resize: { readonly width: number; readonly height: number };
  focus: Record<string, never>;
  blur: Record<string, never>;
  "key-down": { readonly key?: string; readonly code?: string; readonly modifiers?: number; readonly isRepeat?: boolean };
  "key-up": { readonly key?: string; readonly code?: string; readonly modifiers?: number };
  "mouse-enter": { readonly x: number; readonly y: number; readonly button?: number; readonly modifiers?: number };
  "mouse-leave": Record<string, never>;
  "mouse-down": { readonly x: number; readonly y: number; readonly button?: number; readonly modifiers?: number };
  "mouse-up": { readonly x: number; readonly y: number; readonly button?: number; readonly modifiers?: number };
  scroll: { readonly deltaX: number; readonly deltaY: number };
  "file-drop": { readonly files?: Array<{ readonly name: string; readonly size: number; readonly type: string }> };
  "theme-changed": { readonly text: "light" | "dark" };
}

export type WindowEventName = keyof WindowEventPayloads;

interface NavigationResult {
  readonly errorText?: string;
}

interface EvaluateResult {
  readonly result?: { readonly value?: unknown };
  readonly exceptionDetails?: { readonly text?: string; readonly exception?: { readonly description?: string } };
}

interface ScreenshotResult {
  readonly data: string;
}

interface BindingCalledParams {
  readonly name: string;
  readonly payload: string;
}

interface FrameNavigatedParams {
  readonly frame?: { readonly parentId?: string; readonly url?: string };
}

/** Module-level: one WebView2 browser process per app, hence one port and one data folder. */
let activePort: number | undefined;
let activeDataDir: string | undefined;
const claimedTargets = new Set<string>();
const liveHosts = new Set<WindowHost>();

// A dying app must not orphan host processes: a lingering host holds the
// shared WebView2 browser for the data folder, wedging the next run.
process.on("exit", () => {
  for (const host of liveHosts) host.kill();
});

/** Per-app WebView2 data folder: without this, every Bun process on the
 * machine would share one browser process keyed to bun.exe. */
function defaultDataDir(): string {
  const localAppData = Bun.env.LOCALAPPDATA ?? import.meta.dir;
  const projectKey = new Bun.CryptoHasher("sha256").update(process.cwd()).digest("hex").slice(0, 16);
  return `${localAppData}\\bun-webview2\\${projectKey}`;
}

/** A live child host process owning exactly one window. */
class WindowHost {
  readonly #child: Bun.Subprocess<"ignore", "pipe", "inherit">;
  #closed = false;
  readonly #closedWaiters: Array<() => void> = [];
  readonly #eventWaiters = new Set<(event: string, payload: unknown) => void>();

  constructor(
    readonly options: { title: string; width: number; height: number; minWidth?: number; minHeight?: number },
  ) {
    const config = JSON.stringify(options);
    // Compiled executables re-run themselves instead of acting as a runtime,
    // so shipped apps point BWV2_HOST_EXE at a pre-compiled host binary.
    // host-ffi.ts drives the C webview library directly via bun:ffi.
    const command = Bun.env.BWV2_HOST_EXE
      ? [Bun.env.BWV2_HOST_EXE]
      : [process.execPath, `${import.meta.dir}/host-ffi.ts`];
    this.#child = Bun.spawn([...command, config], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
      env: {
        ...Bun.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${activePort}`,
        WEBVIEW2_USER_DATA_FOLDER: activeDataDir,
      },
    });
    this.#watchStdout();
    // host death closes the window, whatever the cause
    void this.#child.exited.then(() => this.#handleClosed());
    liveHosts.add(this);
  }

  async #watchStdout(): Promise<void> {
    const decoder = new TextDecoder();
    const reader = this.#child.stdout.getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          // tolerate stray non-JSON lines (inherited handles, renderer
          // warnings): one bad line must never kill the whole reader loop
          let message: unknown;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          const event = (message as Record<string, unknown>).event;
          if (typeof event === "string") {
            if (event === "closed") this.#handleClosed();
            for (const waiter of this.#eventWaiters) waiter(event, message);
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
  }

  #handleClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    liveHosts.delete(this);
    for (const notify of this.#closedWaiters) notify();
  }

  onClosed(listener: () => void): void {
    if (this.#closed) listener();
    else this.#closedWaiters.push(listener);
  }

  /** Subscribe to host stdout events (window events + lifecycle). */
  onHostEvent(listener: (event: string, payload: unknown) => void): () => void {
    this.#eventWaiters.add(listener);
    return () => this.#eventWaiters.delete(listener);
  }

  get closed(): boolean {
    return this.#closed;
  }

  kill(): void {
    if (!this.#closed) this.#child.kill();
    this.#handleClosed();
  }
}

export class Webview2Window {
  readonly #host: WindowHost;
  readonly #cdp: CdpConnection;
  readonly #exposed = new Map<string, ExposedFunction>();
  #closed = false;
  #url: string | undefined;
  readonly #closedWaiters: Array<() => void> = [];
  readonly #eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  #navigationTimeoutMs: number;

  private constructor(host: WindowHost, cdp: CdpConnection, opts: Webview2WindowOptions) {
    this.#host = host;
    this.#cdp = cdp;
    this.#navigationTimeoutMs = (opts.navigationTimeoutSeconds ?? 30) * 1000;
    host.onClosed(() => this.#handleClosed());
    // Events arrive as JSON from our own child process — trusted channel,
    // so one narrow cast from unknown is all the validation needed.
    host.onHostEvent((event, payload) => {
      if (event === "closed") return;
      this.#eventHandlers.get(event)?.forEach((handler) => handler(payload));
    });
    cdp.on("Runtime.bindingCalled", (params) => this.#handleBinding(params));
    cdp.on("Page.frameNavigated", (params) => {
      const frame = (params as Partial<FrameNavigatedParams>)?.frame;
      if (frame && frame.parentId === undefined && typeof frame.url === "string") {
        this.#url = frame.url;
      }
    });
  }

  #handleClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cdp.close();
    for (const notify of this.#closedWaiters) notify();
  }

  /**
   * Create a window (in its own host process) and attach to its page target.
   * Resolves once the initial content (if any) has loaded.
   */
  static async create(opts: Webview2WindowOptions = {}): Promise<Webview2Window> {
    if (activePort === undefined) {
      const port = opts.port ?? (await pickFreePort());
      activeDataDir = opts.dataDir ?? defaultDataDir();
      activePort = port;
    } else if (opts.port !== undefined && opts.port !== activePort) {
      throw new Error(
        `bun-webview2: port ${opts.port} requested, but this app already drives its WebView2 browser on ${activePort}. All windows share one port.`,
      );
    } else if (opts.dataDir !== undefined && opts.dataDir !== activeDataDir) {
      throw new Error(
        `bun-webview2: dataDir ${opts.dataDir} requested, but this app already uses ${activeDataDir}. All windows share one data folder.`,
      );
    }
    if ((opts.minWidth !== undefined) !== (opts.minHeight !== undefined)) {
      throw new Error("bun-webview2: minWidth and minHeight must be set together — one-sided limits are not supported.");
    }

    const host = new WindowHost({
      title: opts.title ?? "bun-webview2",
      width: opts.width ?? 800,
      height: opts.height ?? 600,
      minWidth: opts.minWidth,
      minHeight: opts.minHeight,
    });

    const target: CdpTargetInfo = await waitForPageTarget(activePort, claimedTargets, 15_000, activeDataDir);
    claimedTargets.add(target.webSocketDebuggerUrl);

    const cdp = new CdpConnection(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.call("Page.enable");

    const win = new Webview2Window(host, cdp, opts);

    // Prime the target with one committed document before any other CDP
    // setup: on a never-navigated webview, Runtime.enable and even
    // Page.navigate can wedge forever (bisected empirically — commands that
    // need a renderer have none yet). about:blank commits one, fast.
    await win.navigate("about:blank");

    await cdp.call("Runtime.enable");
    await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: buildHardeningScript(opts) });
    await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: buildIpcBridgeScript() });
    await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: buildPageEventsScript() });
    await cdp.call("Runtime.addBinding", { name: "__bwv2Ipc" });

    // Confirm the parent→host command channel (CDP -> page -> bind -> host).
    await win.#sendCommand("hello");

    if (opts.url) await win.navigate(opts.url);
    else if (opts.html) await win.setHTML(opts.html);
    return win;
  }

  #handleBinding(params: unknown): void {
    const { name, payload } = (params ?? {}) as Partial<BindingCalledParams>;
    if (name !== "__bwv2Ipc" || typeof payload !== "string") return;
    const request = JSON.parse(payload) as { id: number; name: string; args?: unknown[] };
    if (request.name === "__event") {
      // page-surface event forwarded by the injected bridge; no reply expected
      const [eventName, eventPayload] = request.args ?? [];
      if (typeof eventName === "string") {
        this.#eventHandlers.get(eventName)?.forEach((handler) => handler(eventPayload));
      }
      return;
    }
    const fn = this.#exposed.get(request.name);
    if (!fn) {
      void this.#reply(request.id, false, `bun-webview2: nothing exposed under "${request.name}"`);
      return;
    }
    Promise.resolve()
      .then(() => fn(...(request.args ?? [])))
      .then((result) => void this.#reply(request.id, true, result))
      .catch((err: unknown) => void this.#reply(request.id, false, err instanceof Error ? err.message : String(err)));
  }

  async #reply(id: number, ok: boolean, value: unknown): Promise<void> {
    if (this.#closed) return;
    // undefined serializes to the literal `undefined` expression — acceptable to CDP evaluate.
    await this.#cdp
      .call("Runtime.evaluate", {
        expression: `window.__bwv2Resolve(${id}, ${ok}, ${JSON.stringify(value) ?? "undefined"})`,
      })
      .catch(() => {
        // window closed mid-reply; nothing to do
      });
  }

  /**
   * Deliver a window-control command to the host process and return its
   * reply: CDP-evaluate the bound bwv2_host_cmd in the page; the C webview
   * library hands it to the host natively (all host JS runs re-entrantly
   * inside webview_run, so nothing here depends on a JS event loop), and
   * webview_return resolves the page-side promise the parent awaits — the
   * resolved call IS the delivery confirmation. Commands are resent on
   * failure (mid-navigation); ops are idempotent setters.
   */
  async #sendCommand(op: string, ...args: unknown[]): Promise<unknown> {
    if (this.#closed) return;
    const expression = `bwv2_host_cmd(${JSON.stringify(JSON.stringify({ op, args }))})`;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (this.#closed) return;
      try {
        const response = (await this.#cdp.call("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        })) as EvaluateResult;
        return response.result?.value;
      } catch {
        // mid-navigation or window closing — next attempt may land
      }
      await Bun.sleep(100);
    }
    console.error(`[bwv2] host command "${op}" never resolved after 20 attempts`);
  }

  /** Navigate to a URL. Resolves when the main frame's load event fires. */
  async navigate(url: string): Promise<void> {
    if (this.#closed) throw new Error("bun-webview2: window is closed");

    const { promise: loaded, resolve: fireLoaded, reject: failLoaded } = Promise.withResolvers<void>();
    const unsubscribe = this.#cdp.on("Page.loadEventFired", () => fireLoaded());
    const timer = setTimeout(() => failLoaded(new Error(`bun-webview2: navigation to ${url} timed out`)), this.#navigationTimeoutMs);

    try {
      // cdp.call's timeout guards the command itself; the load-wait timer
      // below guards the navigation completing.
      const result = (await this.#cdp.call("Page.navigate", { url }, this.#navigationTimeoutMs)) as NavigationResult;
      if (typeof result?.errorText === "string" && result.errorText !== "") {
        throw new Error(`bun-webview2: navigation to ${url} failed: ${result.errorText}`);
      }
      await loaded;
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  }

  /** Replace the page with inline HTML (delivered as a data: URL). */
  async setHTML(html: string): Promise<void> {
    await this.navigate(`data:text/html,${encodeURIComponent(html)}`);
  }

  /**
   * Evaluate an expression in the page and return its JSON-serializable
   * result. Promises are awaited. Functions, `undefined`, and symbols come
   * back as `undefined`; circular structures throw inside the page.
   */
  async evaluate<T = unknown>(expression: string): Promise<T | undefined> {
    if (this.#closed) throw new Error("bun-webview2: window is closed");
    const response = (await this.#cdp.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as EvaluateResult;
    if (response?.exceptionDetails) {
      const details = response.exceptionDetails;
      throw new Error(`bun-webview2: page threw: ${details.exception?.description ?? details.text ?? "unknown error"}`);
    }
    return (response?.result?.value ?? undefined) as T | undefined;
  }

  /**
   * Expose a Bun function to the page as `await window.bwv2.call(name, ...args)`.
   * Arguments and return values are JSON round-tripped.
   */
  async expose(name: string, fn: ExposedFunction): Promise<void> {
    this.#exposed.set(name, fn);
  }

  /** Capture the current viewport as an image. */
  async screenshot(opts: ScreenshotFormat = {}): Promise<Blob> {
    if (this.#closed) throw new Error("bun-webview2: window is closed");
    const result = (await this.#cdp.call("Page.captureScreenshot", {
      format: opts.format ?? "png",
      ...(opts.quality !== undefined && opts.format === "jpeg" ? { quality: opts.quality } : {}),
    })) as ScreenshotResult;
    const bytes = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: opts.format === "jpeg" ? "image/jpeg" : "image/png" });
  }

  /** The URL the page is currently showing. */
  get url(): string | undefined {
    return this.#url;
  }

  /**
   * The live CDP connection for this window's page — the escape hatch to the
   * full Chrome DevTools Protocol (Network, DOM, Input, Emulation, …) when
   * the typed methods here don't cover a need.
   */
  get cdp(): CdpConnection {
    return this.#cdp;
  }

  /** True once the window has been closed by the user or `close()`. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Runs when the window is closed (user close button or `close()`). */
  onClosed(listener: () => void): void {
    if (this.#closed) listener();
    else this.#closedWaiters.push(listener);
  }

  /**
   * Subscribe to a native window event (move, resize, focus/blur, key/mouse,
   * file-drop for drag & drop, scroll, theme-changed). Returns an
   * unsubscribe function.
   */
  on<K extends WindowEventName>(event: K, handler: (payload: WindowEventPayloads[K]) => void): () => void {
    const handlers = this.#eventHandlers.get(event) ?? new Set<(payload: unknown) => void>();
    // trusted child-protocol payloads; the double cast bridges the generic's
    // contravariance, which a single cast cannot express
    const wrapped = handler as unknown as (payload: unknown) => void;
    handlers.add(wrapped);
    this.#eventHandlers.set(event, handlers);
    return () => handlers.delete(wrapped);
  }

  // --- Native window controls (delivered to the host via the page) ---

  /** Fire-and-forget; commands retry in the background until the call resolves. */
  #command(op: string, ...args: unknown[]): void {
    void this.#sendCommand(op, ...args);
  }

  setTitle(title: string): void {
    this.#command("setTitle", title);
  }

  setSize(width: number, height: number): void {
    this.#command("setSize", width, height);
  }

  setPosition(x: number, y: number): void {
    this.#command("setPosition", x, y);
  }

  setDecorations(decorations: boolean): void {
    this.#command("setDecorations", decorations);
  }

  setAlwaysOnTop(alwaysOnTop: boolean): void {
    this.#command("setAlwaysOnTop", alwaysOnTop);
  }

  focus(): void {
    this.#command("focus");
  }

  minimize(): void {
    this.#command("minimize");
  }

  maximize(): void {
    this.#command("maximize");
  }

  /** Close the window, stop its host process, and detach from CDP. */
  close(): void {
    if (!this.#closed) {
      this.#host.kill();
      this.#handleClosed();
    }
  }

  /**
   * Close via the host's own close op and wait for its "closed" event — the
   * same path a user's close button takes. Rejects if the host doesn't
   * confirm within `timeoutMs` (default 5s), after which the window is
   * force-closed instead.
   */
  async closeGracefully(timeoutMs = 5_000): Promise<void> {
    if (this.#closed) return;
    const confirmed = Promise.withResolvers<void>();
    this.onClosed(() => confirmed.resolve());
    void this.#sendCommand("close");
    const winner = await Promise.race([confirmed.promise.then(() => "closed" as const), Bun.sleep(timeoutMs).then(() => "timeout" as const)]);
    if (winner === "timeout") {
      this.#host.kill();
      this.#handleClosed();
      throw new Error("bun-webview2: host did not confirm close in time; window force-closed");
    }
  }
}

/** Shorthand for `Webview2Window.create`. */
export function createWindow(opts: Webview2WindowOptions = {}): Promise<Webview2Window> {
  return Webview2Window.create(opts);
}
