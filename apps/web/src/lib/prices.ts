"use client";
import { useCallback, useSyncExternalStore } from "react";
import { env } from "@/config/deployment";
import type { Series } from "@/config/deployment";

/**
 * Live spot price for the chart and the sparkline. Display only: fills are priced on chain from
 * the oracle report for the order's second, never from this number. Public exchange sockets
 * (Binance first, Coinbase if Binance is unreachable, e.g. blocked in the viewer's country); a
 * deterministic random walk in test builds (`NEXT_PUBLIC_MOCK_PRICES=1`, refused in production).
 */
export type Point = { t: number; p: number };
export type PriceState = { price: number | null; history: Point[]; live: boolean; source: string };

const EMPTY: PriceState = { price: null, history: [], live: false, source: "none" };
const MAX_POINTS = 600;

class Feed {
  state: PriceState = EMPTY;
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refs = 0;
  private lastPush = 0;
  private lastTick = 0;
  private attempt = 0;
  private stopped = false;

  constructor(private readonly series: Series) {}

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    if (++this.refs === 1) this.start();
    return () => {
      this.listeners.delete(cb);
      if (--this.refs === 0) this.stop();
    };
  };

  snapshot = () => this.state;

  private emit() {
    this.listeners.forEach((l) => l());
  }

  private push(p: number, source: string) {
    const now = Date.now();
    this.lastTick = now;
    const history = this.state.history;
    let next = history;
    if (now - this.lastPush >= 1000 || history.length === 0) {
      this.lastPush = now;
      next = [...history, { t: now, p }].slice(-MAX_POINTS);
    }
    this.state = { price: p, history: next, live: true, source };
    this.emit();
  }

  private start() {
    this.stopped = false;
    if (env.mockPrices) return this.startMock();
    // after the first paint: the page is usable before the socket is, and its handshake costs nothing at load
    setTimeout(() => this.connect(0), 1200);
    this.timer = setInterval(() => {
      if (this.state.live && Date.now() - this.lastTick > 10_000) {
        this.state = { ...this.state, live: false };
        this.emit();
      }
    }, 2000);
  }

  private stop() {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private startMock() {
    let p = Number(process.env.NEXT_PUBLIC_MOCK_BASE ?? 3000);
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5;
    const tick = () => {
      p = p * (1 + rnd() * 0.0004);
      this.push(p, "mock");
    };
    tick();
    this.timer = setInterval(tick, 1000);
  }

  private connect(which: 0 | 1) {
    if (this.stopped) return;
    const { binance, coinbase } = this.series;
    const url =
      which === 0
        ? `wss://stream.binance.com:9443/ws/${binance.toLowerCase()}@miniTicker`
        : "wss://ws-feed.exchange.coinbase.com";
    let opened = false;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      opened = true;
      this.attempt = 0;
      if (which === 1)
        ws.send(
          JSON.stringify({ type: "subscribe", product_ids: [coinbase], channels: ["ticker"] }),
        );
    };
    ws.onmessage = (m) => {
      try {
        const j = JSON.parse(String(m.data)) as { c?: string; type?: string; price?: string };
        const raw = which === 0 ? j.c : j.type === "ticker" ? j.price : undefined;
        const p = Number(raw);
        if (p > 0) this.push(p, which === 0 ? "Binance" : "Coinbase");
      } catch {
        // ignore a malformed frame
      }
    };
    ws.onclose = () => {
      if (this.stopped) return;
      // never connected to Binance: try Coinbase; otherwise reconnect to the same one with back-off
      const next: 0 | 1 = which === 0 && !opened ? 1 : which;
      const wait = Math.min(15_000, 500 * 2 ** this.attempt++);
      setTimeout(() => this.connect(next), next !== which ? 0 : wait);
    };
    ws.onerror = () => ws.close();
  }
}

const feeds = new Map<string, Feed>();
function feedFor(s: Series): Feed {
  let f = feeds.get(s.label);
  if (!f) feeds.set(s.label, (f = new Feed(s)));
  return f;
}

export function usePrice(series: Series | undefined): PriceState {
  const feed = series ? feedFor(series) : null;
  // The subscribe function must keep its identity between renders: React re-subscribes whenever it
  // changes, and a feed that starts on subscribe would restart (and re-emit) on every render.
  const subscribe = useCallback((cb: () => void) => (feed ? feed.subscribe(cb) : () => {}), [feed]);
  const snapshot = useCallback(() => (feed ? feed.snapshot() : EMPTY), [feed]);
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}
