import { createServer, type Server } from "node:http";

export type HealthState = {
  startedAt: number;
  lastTickAt: number | null;
  lastTickOk: boolean;
  lastError: string | null;
  ticks: number;
  leader: string | null;
  lateCount: number;
  intervalMs: number;
};

/** GET /health -> 200 when the last tick succeeded within 3 intervals, else 503. */
export function startHealthServer(port: number, state: () => HealthState): Server {
  const server = createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    const s = state();
    const fresh = s.lastTickAt !== null && Date.now() - s.lastTickAt < 3 * s.intervalMs;
    const ok = fresh && s.lastTickOk;
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok, ...s }));
  });
  server.listen(port);
  return server;
}
