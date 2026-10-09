"use client";
import { useCallback, useSyncExternalStore } from "react";
import { env } from "@/config/deployment";
import type { Series } from "@/config/deployment";

/**
 * Live spot price for the chart, the odds and the buttons. Display only: fills are priced on chain
 * from the oracle report for the order's second, never from this number.
 *
 * The keeper prices from the MEDIAN of Binance and Coinbase, and the oracle's strike sits on that
 * basis (the two exchanges differ by about a dollar on ETH: USDT vs USD), so the app listens to both
 * and shows their mean. One exchange alone would put the line about 4 cents of probability away from
 * what the vault quotes. When only one is reachable (Binance is blocked in some countries) it is used
 * on its own. A deterministic random walk in test builds (`NEXT_PUBLIC_MOCK_PRICES=1`, refused in
 * production).
 *
 * The chart is full on arrival: the last minutes are back-filled from the exchange's public candles
 * (1 s on Binance, 1 min on Coinbase), shifted onto the composite's basis, so nobody watches an empty
 * graph slowly draw itself.
 */
export type Point = { t: number; p: number };
export type PriceState = { price: number | null; history: Point[]; live: boolean; source: string };

const EMPTY: PriceState = { price: null, history: [], live: false, source: "none" };
const MAX_POINTS = 1800; // 30 minutes at one point a second
const FRESH_MS = 6000;
const EMIT_MS = 250; // numbers move four times a second, not once

type SrcName = "Binance" | "Coinbase";

class Feed {
  state: PriceState = EMPTY;
  private listeners = new Set<() => void>();
  private sockets: Partial<Record<SrcName, WebSocket>> = {};
  private last: Partial<Record<SrcName, { p: number; t: number }>> = {};
  private attempts: Record<SrcName, number> = { Binance: 0, Coinbase: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;
  private refs = 0;
  private lastPush = 0;
  private lastEmit = 0;
  private stopped = false;
  private backfilled = false;

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
    this.lastEmit = Date.now();
    this.listeners.forEach((l) => l());
  }

  /** The mean of the fresh sources (the median of two), or null if none is fresh. */
  private composite(now: number): { p: number; names: SrcName[] } | null {
    const fresh = (Object.entries(this.last) as [SrcName, { p: number; t: number }][]).filter(
      ([, v]) => now - v.t <= FRESH_MS,
    );
    if (fresh.length === 0) return null;
    return {
      p: fresh.reduce((a, [, v]) => a + v.p, 0) / fresh.length,
      names: fresh.map(([n]) => n),
    };
  }

  private update() {
    const now = Date.now();
    const c = this.composite(now);
    if (!c) return;
    const history = this.state.history;
    let next = history;
    if (now - this.lastPush >= 1000 || history.length === 0) {
      this.lastPush = now;
      next = [...history, { t: now, p: c.p }].slice(-MAX_POINTS);
    }
    this.state = { price: c.p, history: next, live: true, source: c.names.join(" + ") };
    if (now - this.lastEmit >= EMIT_MS || next !== history) this.emit();
  }

  private tick(name: SrcName, p: number) {
    if (!(p > 0)) return;
    this.last[name] = { p, t: Date.now() };
    if (!this.backfilled && !env.mockPrices) void this.backfill();
    this.update();
  }

  private start() {
    this.stopped = false;
    if (env.mockPrices) return this.startMock();
    // after the first paint: the page is usable before the sockets are
    setTimeout(() => {
      this.connect("Binance");
      this.connect("Coinbase");
    }, 800);
    this.timer = setInterval(() => {
      const c = this.composite(Date.now());
      if (!c && this.state.live) {
        this.state = { ...this.state, live: false };
        this.emit();
      } else if (c) this.update();
    }, 1000);
  }

  private stop() {
    this.stopped = true;
    for (const w of Object.values(this.sockets)) w?.close();
    this.sockets = {};
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private startMock() {
    let p = Number(process.env.NEXT_PUBLIC_MOCK_BASE ?? 3000);
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5;
    const tick = () => {
      p = p * (1 + rnd() * 0.0004);
      this.tick("Binance", p);
      this.last.Coinbase = { p, t: Date.now() };
    };
    tick();
    this.timer = setInterval(tick, 500);
  }

  private connect(name: SrcName) {
    if (this.stopped) return;
    const { binance, coinbase } = this.series;
    const url =
      name === "Binance"
        ? `wss://stream.binance.com:9443/ws/${binance.toLowerCase()}@miniTicker`
        : "wss://ws-feed.exchange.coinbase.com";
    const ws = new WebSocket(url);
    this.sockets[name] = ws;
    ws.onopen = () => {
      this.attempts[name] = 0;
      if (name === "Coinbase")
        ws.send(
          JSON.stringify({ type: "subscribe", product_ids: [coinbase], channels: ["ticker"] }),
        );
    };
    ws.onmessage = (m) => {
      try {
        const j = JSON.parse(String(m.data)) as { c?: string; type?: string; price?: string };
        const raw = name === "Binance" ? j.c : j.type === "ticker" ? j.price : undefined;
        this.tick(name, Number(raw));
      } catch {
        // ignore a malformed frame
      }
    };
    ws.onclose = () => {
      if (this.stopped) return;
      const wait = Math.min(20_000, 600 * 2 ** this.attempts[name]++);
      setTimeout(() => this.connect(name), wait);
    };
    ws.onerror = () => ws.close();
  }

  /** The recent past, so the chart is full when the page opens. */
  private async backfill() {
    this.backfilled = true;
    const { binance, coinbase } = this.series;
    let points: Point[] = [];
    let from: SrcName = "Binance";
    try {
      const r = await fetch(
        `https://api.binance.com/api/v3/klines?symbol=${binance}&interval=1s&limit=1000`,
        { signal: AbortSignal.timeout(6000) },
      );
      const rows = (await r.json()) as [number, string, string, string, string][];
      points = rows.map((k) => ({ t: k[0], p: Number(k[4]) })).filter((x) => x.p > 0);
    } catch {
      /* try Coinbase */
    }
    if (points.length < 30) {
      try {
        from = "Coinbase";
        const r = await fetch(
          `https://api.exchange.coinbase.com/products/${coinbase}/candles?granularity=60`,
          { signal: AbortSignal.timeout(6000) },
        );
        const rows = (await r.json()) as [number, number, number, number, number, number][];
        points = rows
          .map((k) => ({ t: k[0] * 1000, p: k[4] }))
          .filter((x) => x.p > 0)
          .reverse()
          .slice(-30);
      } catch {
        return;
      }
    }
    if (this.stopped || points.length === 0) return;
    // put the past on the composite's basis: shift it by the gap between now and the same exchange now
    const own = this.last[from];
    const comp = this.composite(Date.now());
    const lastPast = points[points.length - 1]!;
    const shift = own && comp ? comp.p - own.p : 0;
    void lastPast;
    const firstLive = this.state.history[0]?.t ?? Date.now();
    const past = points
      .filter((x) => x.t < firstLive - 500)
      .map((x) => ({ t: x.t, p: x.p + shift }));
    this.state = {
      ...this.state,
      history: [...past, ...this.state.history].slice(-MAX_POINTS),
    };
    this.emit();
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
