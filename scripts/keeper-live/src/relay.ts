/**
 * Price relay for the testnet run: connects to the real exchange streams, forwards every message to the
 * keeper on local ports, and can distort them on command. The keeper still sees real, live market data; the
 * relay only adds the faults the run injects.
 *
 *   ws://127.0.0.1:9201/<SYMBOL>  binance-shaped      ws://127.0.0.1:9202/<PRODUCT>  coinbase-shaped
 *   (no path = the first asset, so a keeper from before the multi-asset relay still works)
 *   POST :9203/shock?pct=2&ms=30000[&source=binance]   multiply the prices (both sources, every asset)
 *   POST :9203/mute?source=coinbase&ms=20000           stop forwarding (a stale feed)
 *   POST :9203/clear                                    remove every fault
 *   GET  :9203/price[?asset=BTC]                        the undistorted mid (median of the sources); ETH by default
 *
 * Assets (RELAY_ASSETS, JSON; default ETH, BTC and MON):
 *   key      what GET /price?asset= takes
 *   binance  the keeper's "binance" symbol, and the stream behind it: Binance itself, or OKX re-shaped as a
 *            Binance bookTicker (Binance does not list MON; OKX does, with the same kind of order-book mid)
 *   coinbase the Coinbase Exchange product
 */
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";

const SOURCES = ["binance", "coinbase"] as const;
type Src = (typeof SOURCES)[number];
type AssetDef = {
  key: string;
  binance: { symbol: string; from: "binance" | "okx"; instId?: string };
  coinbase: string;
};
const ASSETS: AssetDef[] = process.env.RELAY_ASSETS
  ? (JSON.parse(process.env.RELAY_ASSETS) as AssetDef[])
  : [
      { key: "ETH", binance: { symbol: "ETHUSDT", from: "binance" }, coinbase: "ETH-USD" },
      { key: "BTC", binance: { symbol: "BTCUSDT", from: "binance" }, coinbase: "BTC-USD" },
      {
        key: "MON",
        binance: { symbol: "MONUSDT", from: "okx", instId: "MON-USDT" },
        coinbase: "MON-USD",
      },
    ];
const ports: Record<Src, number> = { binance: 9201, coinbase: 9202 };
const norm = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
/** the path a keeper connects with, per source */
const pathKey = (a: AssetDef, src: Src) => norm(src === "binance" ? a.binance.symbol : a.coinbase);

const mult: Record<Src, { m: number; until: number }> = {
  binance: { m: 1, until: 0 },
  coinbase: { m: 1, until: 0 },
};
const muted: Record<Src, number> = { binance: 0, coinbase: 0 };
/** last undistorted mid per asset and source */
const last = new Map<string, number>();
const lastMsg = new Map<string, { at: number; raw: string }>();
const log = (o: Record<string, unknown>) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

type Mid = { mid: number; raw: string } | null;

/** One upstream message -> its mid and the binance/coinbase-shaped message to forward. */
function shape(a: AssetDef, src: Src, raw: string): Mid {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (src === "binance" && a.binance.from === "okx") {
    const d = (msg.data as Record<string, string>[] | undefined)?.[0];
    if (!d) return null;
    const b = Number(d.bidPx);
    const k = Number(d.askPx);
    if (!(b > 0 && k >= b)) return null;
    return { mid: (b + k) / 2, raw: JSON.stringify({ b: d.bidPx, a: d.askPx }) };
  }
  const mid =
    src === "binance"
      ? (Number(msg.b) + Number(msg.a)) / 2
      : msg.type === "ticker"
        ? (Number(msg.best_bid) + Number(msg.best_ask)) / 2
        : NaN;
  if (!(mid > 0)) return src === "coinbase" ? { mid: NaN, raw } : null;
  return { mid, raw };
}

function distort(src: Src, raw: string): string {
  const m = Date.now() < mult[src].until ? mult[src].m : 1;
  if (m === 1) return raw;
  const msg = JSON.parse(raw) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...msg };
  for (const k of ["b", "a", "price", "best_bid", "best_ask"])
    if (msg[k] !== undefined) out[k] = String(Number(msg[k]) * m);
  return JSON.stringify(out);
}

const servers = {} as Record<Src, WebSocketServer>;
for (const src of SOURCES) {
  const wss = new WebSocketServer({ port: ports[src], host: "127.0.0.1" });
  servers[src] = wss;
  // a client that (re)connects gets the last message if it is fresh: the real exchanges send a
  // snapshot on subscribe, and the relay is one hop that must not hide that
  wss.on("connection", (c, req) => {
    const want = norm((req.url ?? "/").split("?")[0]!.slice(1));
    const a = ASSETS.find((x) => pathKey(x, src) === want) ?? (want ? undefined : ASSETS[0]);
    if (!a) return void c.close(1008, "unknown asset");
    (c as WebSocket & { asset?: string }).asset = a.key;
    const m = lastMsg.get(`${src}:${a.key}`);
    if (m && Date.now() - m.at < 10_000) c.send(m.raw);
  });
}
const send = (src: Src, key: string, raw: string) => {
  for (const c of servers[src].clients)
    if (c.readyState === WebSocket.OPEN && (c as WebSocket & { asset?: string }).asset === key)
      c.send(raw);
};

function connect(a: AssetDef, src: Src) {
  const id = `${src}:${a.key}`;
  const okx = src === "binance" && a.binance.from === "okx";
  const url =
    src === "coinbase"
      ? "wss://ws-feed.exchange.coinbase.com"
      : okx
        ? "wss://ws.okx.com:8443/ws/v5/public"
        : `wss://stream.binance.com:9443/ws/${a.binance.symbol.toLowerCase()}@bookTicker`;
  const up = new WebSocket(url);
  // A feed can stall without ever closing (the Coinbase one did, for hours, and the keeper then
  // halted on "few sources"): if nothing arrives for 8 s the connection is dropped and reopened.
  let heard = Date.now();
  let lastTrade = 0;
  let ping: NodeJS.Timeout | undefined;
  const dog = setInterval(() => {
    if (Date.now() - heard > 8000) {
      log({ ev: "upstream silent, reconnecting", src, asset: a.key });
      up.terminate();
    }
  }, 2000);
  up.on("open", () => {
    heard = Date.now();
    log({ ev: "upstream open", src, asset: a.key });
    if (src === "coinbase")
      up.send(
        JSON.stringify({
          type: "subscribe",
          product_ids: [a.coinbase],
          channels: ["ticker", "heartbeat"],
        }),
      );
    if (okx) {
      up.send(
        JSON.stringify({
          op: "subscribe",
          args: [{ channel: "tickers", instId: a.binance.instId }],
        }),
      );
      // OKX only speaks when the book or a trade changes; a text "ping" is answered with "pong", which proves
      // the connection is alive, so the quiet-market re-send below works for it too
      ping = setInterval(() => up.readyState === WebSocket.OPEN && up.send("ping"), 3000);
    }
  });
  const resendQuiet = () => {
    // The Coinbase ticker only speaks when a trade happens, and a quiet market can go 10 s or more without
    // one. A heartbeat (about 1/s) proves the connection is alive: while it keeps arriving, re-send the last
    // price (it has not changed) for up to a minute, so a quiet market is not mistaken for a dead feed. A
    // truly dead one goes silent and still halts.
    const m = lastMsg.get(id);
    if (m && Date.now() - m.at > 1000 && Date.now() - lastTrade < 60_000) send(src, a.key, m.raw);
  };
  up.on("message", (d) => {
    heard = Date.now();
    const text = String(d);
    if (okx && text === "pong") return resendQuiet();
    if (src === "coinbase") {
      let type: string | undefined;
      try {
        type = (JSON.parse(text) as { type?: string }).type;
      } catch {
        type = undefined;
      }
      if (type === "heartbeat") return resendQuiet();
      if (type === "ticker") lastTrade = Date.now();
    }
    const s = shape(a, src, text);
    if (!s) return;
    if (!(s.mid > 0)) return send(src, a.key, s.raw); // an acknowledgement, not a price: pass it on, never replay it
    if (okx) lastTrade = Date.now();
    last.set(id, s.mid);
    if (Date.now() < muted[src]) return;
    const out = distort(src, s.raw);
    lastMsg.set(id, { at: Date.now(), raw: out });
    send(src, a.key, out);
  });
  up.on("error", (e) => log({ ev: "upstream error", src, asset: a.key, err: e.message }));
  up.on("close", () => {
    clearInterval(dog);
    if (ping) clearInterval(ping);
    log({ ev: "upstream closed", src, asset: a.key });
    setTimeout(() => connect(a, src), 1000);
  });
}
for (const a of ASSETS) for (const src of SOURCES) connect(a, src);

createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && u.pathname === "/price") {
    const key = (u.searchParams.get("asset") ?? ASSETS[0]!.key).toUpperCase();
    const xs = SOURCES.map((s) => last.get(`${s}:${key}`) ?? 0).filter((x) => x > 0);
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
log({
  ev: "relay up",
  binance: ports.binance,
  coinbase: ports.coinbase,
  control: 9203,
  assets: ASSETS.map((a) => a.key),
});
