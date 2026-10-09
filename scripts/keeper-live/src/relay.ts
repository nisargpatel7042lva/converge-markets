/**
 * Price relay for the testnet run: connects to the real Binance and Coinbase streams, forwards every
 * message to the keeper on local ports, and can distort them on command. The keeper still sees real,
 * live market data; the relay only adds the faults the run injects.
 *
 *   ws://127.0.0.1:9201  binance-shaped      ws://127.0.0.1:9202  coinbase-shaped
 *   POST :9203/shock?pct=2&ms=30000[&source=binance]   multiply the prices (both sources by default)
 *   POST :9203/mute?source=coinbase&ms=20000           stop forwarding (a stale feed)
 *   POST :9203/clear                                    remove every fault
 *   GET  :9203/price                                    the undistorted mid (median of the sources)
 */
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";

const SOURCES = ["binance", "coinbase"] as const;
type Src = (typeof SOURCES)[number];
const symbol = process.env.BINANCE_SYMBOL ?? "ethusdt";
const product = process.env.COINBASE_PRODUCT ?? "ETH-USD";
const upstream: Record<Src, string> = {
  binance: `wss://stream.binance.com:9443/ws/${symbol}@bookTicker`,
  coinbase: "wss://ws-feed.exchange.coinbase.com",
};
const ports: Record<Src, number> = { binance: 9201, coinbase: 9202 };

const mult: Record<Src, { m: number; until: number }> = {
  binance: { m: 1, until: 0 },
  coinbase: { m: 1, until: 0 },
};
const muted: Record<Src, number> = { binance: 0, coinbase: 0 };
const last: Record<Src, number> = { binance: 0, coinbase: 0 };
const lastMsg: Record<Src, { at: number; raw: string } | null> = { binance: null, coinbase: null };
const log = (o: Record<string, unknown>) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

function distort(src: Src, raw: string): string | null {
  const now = Date.now();
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const mid =
    src === "binance"
      ? (Number(msg.b) + Number(msg.a)) / 2
      : msg.type === "ticker"
        ? (Number(msg.best_bid) + Number(msg.best_ask)) / 2
        : NaN;
  if (!(mid > 0)) return src === "coinbase" ? raw : null;
  last[src] = mid;
  if (now < muted[src]) return null;
  const m = now < mult[src].until ? mult[src].m : 1;
  if (m === 1) return raw;
  const f = (k: string) => (msg[k] !== undefined ? String(Number(msg[k]) * m) : undefined);
  const out: Record<string, unknown> = { ...msg };
  for (const k of ["b", "a", "price", "best_bid", "best_ask"]) {
    const v = f(k);
    if (v !== undefined) out[k] = v;
  }
  return JSON.stringify(out);
}

for (const src of SOURCES) {
  const wss = new WebSocketServer({ port: ports[src], host: "127.0.0.1" });
  // a client that (re)connects gets the last message if it is fresh: the real exchanges send a
  // snapshot on subscribe, and the relay is one hop that must not hide that
  wss.on("connection", (c) => {
    const m = lastMsg[src];
    if (m && Date.now() - m.at < 10_000) c.send(m.raw);
  });
  const connect = () => {
    const up = new WebSocket(upstream[src]);
    // A feed can stall without ever closing (the Coinbase one did, for hours, and the keeper then
    // halted on "few sources"): if nothing arrives for 8 s the connection is dropped and reopened.
    let heard = Date.now();
    const dog = setInterval(() => {
      if (Date.now() - heard > 8000) {
        log({ ev: "upstream silent, reconnecting", src });
        up.terminate();
      }
    }, 2000);
    up.on("close", () => clearInterval(dog));
    up.on("open", () => {
      heard = Date.now();
      log({ ev: "upstream open", src });
      if (src === "coinbase")
        up.send(
          JSON.stringify({ type: "subscribe", product_ids: [product], channels: ["ticker"] }),
        );
    });
    up.on("message", (d) => {
      heard = Date.now();
      const out = distort(src, String(d));
      if (out === null) return;
      lastMsg[src] = { at: Date.now(), raw: out };
      for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(out);
    });
    up.on("error", (e) => log({ ev: "upstream error", src, err: e.message }));
    up.on("close", () => {
      log({ ev: "upstream closed", src });
      setTimeout(connect, 1000);
    });
  };
  connect();
}

createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && u.pathname === "/price") {
    const xs = SOURCES.map((s) => last[s]).filter((x) => x > 0);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ price: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null }),
    );
    return;
  }
  if (req.method === "POST" && u.pathname === "/shock") {
    const pct = Number(u.searchParams.get("pct") ?? "2");
    const ms = Number(u.searchParams.get("ms") ?? "30000");
    const only = u.searchParams.get("source") as Src | null;
    for (const s of only ? [only] : SOURCES) mult[s] = { m: 1 + pct / 100, until: Date.now() + ms };
    log({ ev: "SHOCK INJECTED", pct, ms, source: only ?? "both" });
  } else if (req.method === "POST" && u.pathname === "/mute") {
    const s = (u.searchParams.get("source") ?? "coinbase") as Src;
    muted[s] = Date.now() + Number(u.searchParams.get("ms") ?? "20000");
    log({ ev: "FEED MUTED", source: s });
  } else if (req.method === "POST" && u.pathname === "/clear") {
    for (const s of SOURCES) {
      mult[s] = { m: 1, until: 0 };
      muted[s] = 0;
    }
    log({ ev: "FAULTS CLEARED" });
  } else {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200).end("ok");
}).listen(9203, "127.0.0.1");
log({ ev: "relay up", binance: ports.binance, coinbase: ports.coinbase, control: 9203 });
