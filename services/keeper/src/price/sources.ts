import WebSocket from "ws";
import type { Logger } from "pino";
import type { Tick } from "./aggregator";

/** Binance `<symbol>@bookTicker` message -> mid price. */
export function parseBinance(raw: string, now: () => number = Date.now): Tick | null {
  try {
    const m = JSON.parse(raw) as { b?: string; a?: string };
    if (m.b === undefined || m.a === undefined) return null;
    const bid = Number(m.b);
    const ask = Number(m.a);
    if (!(bid > 0 && ask > 0 && ask >= bid)) return null;
    return { source: "binance", price: (bid + ask) / 2, tsMs: now() };
  } catch {
    return null;
  }
}

/** Coinbase Exchange `ticker` message -> mid of best bid/ask (last trade if absent). */
export function parseCoinbase(raw: string, now: () => number = Date.now): Tick | null {
  try {
    const m = JSON.parse(raw) as {
      type?: string;
      price?: string;
      best_bid?: string;
      best_ask?: string;
    };
    if (m.type !== "ticker") return null;
    const bid = Number(m.best_bid);
    const ask = Number(m.best_ask);
    if (bid > 0 && ask >= bid) return { source: "coinbase", price: (bid + ask) / 2, tsMs: now() };
    const p = Number(m.price);
    return p > 0 ? { source: "coinbase", price: p, tsMs: now() } : null;
  } catch {
    return null;
  }
}

export type WsSourceOpts = {
  name: string;
  url: string;
  subscribe?: unknown;
  parse: (raw: string, now: () => number) => Tick | null;
  onTick: (t: Tick) => void;
  log: Logger;
  /** No message for this long: the socket is considered dead and reopened. */
  watchdogMs?: number;
  /** How often the watchdog looks (default 2 s; tests use less). */
  checkEveryMs?: number;
  now?: () => number;
};

/** A reconnecting WebSocket price source (exponential backoff, watchdog on silence). */
export class WsPriceSource {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs = 500;
  private lastMsgMs = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  connects = 0;

  constructor(private readonly o: WsSourceOpts) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    this.open();
    this.watchdog = setInterval(() => {
      if (this.ws && this.now() - this.lastMsgMs > (this.o.watchdogMs ?? 10_000)) {
        this.o.log.warn({ source: this.o.name }, "price socket silent, reconnecting");
        this.ws.terminate();
      }
    }, this.o.checkEveryMs ?? 2_000);
    this.watchdog.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.terminate();
  }

  private open(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.o.url);
    this.ws = ws;
    ws.on("open", () => {
      this.connects += 1;
      this.backoffMs = 500;
      this.lastMsgMs = this.now();
      if (this.o.subscribe !== undefined) ws.send(JSON.stringify(this.o.subscribe));
      this.o.log.info({ source: this.o.name }, "price socket open");
    });
    ws.on("message", (d) => {
      this.lastMsgMs = this.now();
      const t = this.o.parse(String(d), this.now);
      if (t) this.o.onTick(t);
    });
    ws.on("error", (e) =>
      this.o.log.warn({ source: this.o.name, err: e.message }, "price socket error"),
    );
    ws.on("close", () => {
      if (this.stopped) return;
      const wait = this.backoffMs;
      this.backoffMs = Math.min(30_000, this.backoffMs * 2);
      setTimeout(() => this.open(), wait).unref();
    });
  }
}

export const BINANCE_URL = (symbol: string) =>
  `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@bookTicker`;
export const COINBASE_URL = "wss://ws-feed.exchange.coinbase.com";
export const coinbaseSubscribe = (product: string) => ({
  type: "subscribe",
  product_ids: [product],
  channels: ["ticker"],
});
