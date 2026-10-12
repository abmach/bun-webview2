/**
 * Local content serving — bun-webview2's answer to custom protocols.
 *
 * Instead of registering an `app://` scheme handler, serve your frontend from
 * Bun itself on a free loopback port and point a window at it. Same ergonomics
 * (fetch-style `Request → Response`, works with Hono or plain handlers),
 * zero extra machinery: it's just `Bun.serve`.
 */

export interface ServedApp {
  /** Navigate a window here: `createWindow({ url: served.url })`. */
  readonly url: string;
  readonly port: number;
  /** Stop the server. Windows navigating to `url` afterwards will fail. */
  readonly stop: () => void;
}

/** Serve app content on a free 127.0.0.1 port from a fetch-style handler. */
export function serveApp(handler: (req: Request) => Response | Promise<Response>): ServedApp {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req: Request): Response | Promise<Response> => handler(req),
  });
  const { port } = server;
  if (typeof port !== "number") throw new Error("bun-webview2: Bun.serve did not report an assigned port");
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stop: () => {
      server.stop(true);
    },
  };
}
