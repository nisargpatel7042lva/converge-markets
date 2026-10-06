import { createServer, request, type Server } from "node:http";

export type Proxy = {
  url: string;
  port: number;
  /** While false every request is dropped (the socket is destroyed), like a dead RPC node. */
  enabled: boolean;
  requests: number;
  stop: () => Promise<void>;
};

/** A togglable HTTP pass-through to `target`, to switch an RPC endpoint off mid-run. */
export async function startProxy(target: string): Promise<Proxy> {
  const t = new URL(target);
  const state = { enabled: true, requests: 0 };
  const server: Server = createServer((req, res) => {
    state.requests += 1;
    if (!state.enabled) {
      req.destroy();
      res.destroy();
      return;
    }
    const up = request(
      { host: t.hostname, port: t.port, path: req.url, method: req.method, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => {
      res.destroy();
    });
    req.pipe(up);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    get enabled() {
      return state.enabled;
    },
    set enabled(v: boolean) {
      state.enabled = v;
    },
    get requests() {
      return state.requests;
    },
    stop: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
