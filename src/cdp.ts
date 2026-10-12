/**
 * Minimal Chrome DevTools Protocol client over Bun's native WebSocket.
 *
 * One connection per page target. Supports command/response dispatch and
 * event subscriptions. Deliberately tiny: bun-webview2 only needs
 * Runtime, Page, and a handful of methods — nothing more.
 */

export interface CdpTargetInfo {
  readonly type: string;
  readonly title: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

interface CdpResponse {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message: string; readonly data?: string };
}

export interface CdpErrorPayload {
  readonly code: number;
  readonly message: string;
  readonly data?: string;
}

type CdpEventHandler = (params: unknown) => void;

/** Ask the OS for a free TCP port by briefly listening on port 0. */
export async function pickFreePort(): Promise<number> {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

/**
 * Poll the DevTools HTTP endpoint until it lists an unclaimed page target.
 * The endpoint only exists once the WebView2 environment is live, which is
 * asynchronous relative to NativeWindow construction.
 */
export async function waitForPageTarget(
  port: number,
  claimed: ReadonlySet<string>,
  timeoutMs = 15_000,
  dataDirHint?: string,
): Promise<CdpTargetInfo> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const targets = (await (
        await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(500) })
      ).json()) as unknown;
      if (Array.isArray(targets)) {
        const page = targets.find(
          (t): t is CdpTargetInfo =>
            typeof t === "object" && t !== null &&
            "type" in t && (t as CdpTargetInfo).type === "page" &&
            "webSocketDebuggerUrl" in t && typeof (t as CdpTargetInfo).webSocketDebuggerUrl === "string" &&
            !claimed.has((t as CdpTargetInfo).webSocketDebuggerUrl),
        );
        if (page) return page;
      }
    } catch {
      // endpoint not up yet — keep polling
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `bun-webview2: no CDP page target appeared on port ${port} within ${timeoutMs}ms. ` +
      "Likely causes: another instance of this app is already running (apps are single-instance per data folder), " +
      "or a previous run was hard-killed leaving a wedged WebView2 browser process. " +
      (dataDirHint
        ? `Kill lingering msedgewebview2 processes for this data folder or delete it (${dataDirHint}), or pass a different dataDir.`
        : "Pass a different dataDir."),
  );
}

export class CdpConnection {
  readonly #ws: WebSocket;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly #events = new Map<string, Set<CdpEventHandler>>();
  #nextId = 1;
  #closed = false;

  constructor(readonly wsUrl: string) {
    this.#ws = new WebSocket(wsUrl);
  }

  connect(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#ws.addEventListener("open", () => resolve(), { once: true });
    this.#ws.addEventListener("error", () => reject(new Error(`bun-webview2: failed to open CDP socket ${this.wsUrl}`)), { once: true });
    this.#ws.addEventListener("message", (ev: MessageEvent) => this.#dispatch(ev));
    this.#ws.addEventListener("close", () => this.#handleClose());
    return promise;
  }

  #dispatch(ev: MessageEvent): void {
    const msg = JSON.parse(String(ev.data)) as CdpResponse;
    if (msg.id !== undefined) {
      const entry = this.#pending.get(msg.id);
      if (entry) {
        this.#pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`bun-webview2: CDP error: ${msg.error.message}`));
        else entry.resolve(msg.result);
      }
      return;
    }
    if (msg.method !== undefined) {
      this.#events.get(msg.method)?.forEach((handler) => handler(msg.params));
    }
  }

  #handleClose(): void {
    this.#closed = true;
    const err = new Error("bun-webview2: CDP connection closed");
    for (const entry of this.#pending.values()) entry.reject(err);
    this.#pending.clear();
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Send a command and await its response result. Commands that never get a
   * response become rejections after timeoutMs instead of hanging forever —
   * wedged WebView2 targets are a real failure mode, not a theory. */
  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("bun-webview2: CDP connection closed"));
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const id = this.#nextId++;
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new Error(`bun-webview2: CDP call ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    this.#pending.set(id, {
      resolve: (value: unknown) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err: Error) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    this.#ws.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  /** Subscribe to a CDP event; returns an unsubscribe function. */
  on(method: string, handler: CdpEventHandler): () => void {
    let handlers = this.#events.get(method);
    if (!handlers) {
      handlers = new Set();
      this.#events.set(method, handlers);
    }
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  close(): void {
    if (!this.#closed) this.#ws.close();
    this.#handleClose();
  }
}
