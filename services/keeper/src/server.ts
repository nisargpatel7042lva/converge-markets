import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Metrics } from "./metrics";
import type { KillSwitch } from "./killswitch";

export type Status = {
  mode: string;
  startedAt: number;
  lastTickAt: number | null;
  tickIntervalMs: number;
  ready: boolean;
  readyReasons: string[];
  halted: boolean;
  vaultPaused: boolean;
  [k: string]: unknown;
};

function tokenOk(req: IncomingMessage, token: string): boolean {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1] as string);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * GET /health   liveness: 200 while the loop ticks (503 when it has stalled for 5 intervals)
 * GET /ready    200 when the keeper can quote now (sources healthy, RPC ok, not killed, not halted)
 * GET /metrics  Prometheus
 * GET /status   JSON detail
 * POST /kill, /unkill  (Authorization: Bearer KILL_TOKEN) the HTTP kill switch
 */
export function startServer(
  port: number,
  host: string,
  deps: {
    status: () => Status;
    metrics: Metrics;
    kill: KillSwitch;
    killToken: string | undefined;
    onKill?: (on: boolean) => void;
  },
): Server {
  const server = createServer((req, res) => {
    void (async () => {
      const url = (req.url ?? "").split("?")[0];
      if (req.method === "GET" && url === "/metrics") {
        res.writeHead(200, { "content-type": deps.metrics.registry.contentType });
        res.end(await deps.metrics.registry.metrics());
        return;
      }
      if (req.method === "GET" && (url === "/health" || url === "/ready" || url === "/status")) {
        const s = deps.status();
        const alive =
          s.lastTickAt !== null && Date.now() - s.lastTickAt < 5 * s.tickIntervalMs + 5_000;
        const code =
          url === "/health" ? (alive ? 200 : 503) : url === "/ready" ? (s.ready ? 200 : 503) : 200;
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...s, alive }));
        return;
      }
      if (req.method === "POST" && (url === "/kill" || url === "/unkill")) {
        if (!deps.killToken) {
          res.writeHead(404).end();
          return;
        }
        if (!tokenOk(req, deps.killToken)) {
          res.writeHead(401).end();
          return;
        }
        deps.kill.setHttp(url === "/kill");
        deps.onKill?.(url === "/kill");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ killed: deps.kill.killed, sources: deps.kill.sources }));
        return;
      }
      res.writeHead(404).end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.listen(port, host);
  return server;
}
