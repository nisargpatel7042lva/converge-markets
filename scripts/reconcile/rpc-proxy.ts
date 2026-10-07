/**
 * Rate-limiting JSON-RPC proxy for the shared PUBLIC Monad RPC (15 rps per IP): every client (the
 * Envio indexer, the reconcile script) points at this proxy, which forwards requests upstream at no
 * more than --rps per second in total (a JSON-RPC batch counts once per element), retries 429/5xx
 * with backoff, and records the request volume. The hard ceiling is the guarantee that a run never
 * floods the endpoint.
 *
 * Usage: tsx rpc-proxy.ts --upstream https://testnet-rpc.monad.xyz [--port 8612] [--rps 6]
 *                         [--stats docs/evidence/phase-6/rpc-usage-testnet.json]
 * HTTP only (the indexer is configured with an `rpc:` HTTP source; no WebSocket).
 */
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { opt, parseArgs, sleep } from "./lib/common";

const args = parseArgs(process.argv.slice(2));
const upstream = opt(args, "upstream", "UPSTREAM")!;
const port = Number(opt(args, "port", "PORT", "8612"));
const rps = Number(opt(args, "rps", "RPS", "6"));
const statsFile = opt(args, "stats", "STATS");
if (!upstream) throw new Error("--upstream required");

let nextSlot = 0;
let total = 0;
let retries = 0;
const perSecond = new Map<number, number>();
const methods = new Map<string, number>();
const started = Date.now();

async function slot(n: number): Promise<void> {
  // reserve n slots spaced 1/rps apart (a batch of n elements takes n slots)
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + (n * 1000) / rps;
  total += n;
  const sec = Math.floor(start / 1000);
  perSecond.set(sec, (perSecond.get(sec) ?? 0) + n);
  if (start > now) await sleep(start - now);
}

async function forward(body: string): Promise<{ status: number; text: string }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 8) {
      retries++;
      await sleep(Math.min(8000, 500 * 2 ** attempt));
      await slot(1); // a retry spends budget too
      continue;
    }
    return { status: res.status, text: await res.text() };
  }
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks).toString("utf8");
    try {
      const parsed = JSON.parse(body) as unknown;
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of calls) {
        const m = String((c as { method?: string }).method ?? "?");
        methods.set(m, (methods.get(m) ?? 0) + 1);
      }
      await slot(calls.length);
      const out = await forward(body);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(out.text);
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
});

function summary() {
  const peak = Math.max(0, ...perSecond.values());
  return {
    upstream: upstream.replace(/\/\/[^/@]*@/, "//"),
    ceilingRps: rps,
    totalRequests: total,
    retries,
    peakRequestsInAnySecondSlot: peak,
    seconds: Math.round((Date.now() - started) / 1000),
    averageRps: Number((total / Math.max(1, (Date.now() - started) / 1000)).toFixed(2)),
    methods: Object.fromEntries([...methods].sort((a, b) => b[1] - a[1])),
  };
}

function flush() {
  if (!statsFile) return;
  const p = resolve(statsFile);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(summary(), null, 2));
}

server.listen(port, "127.0.0.1", () =>
  console.log(`rpc proxy on 127.0.0.1:${port} -> ${upstream} at <= ${rps} rps`),
);
setInterval(flush, 5000).unref();
process.on("SIGTERM", () => {
  flush();
  process.exit(0);
});
process.on("SIGINT", () => {
  flush();
  process.exit(0);
});
