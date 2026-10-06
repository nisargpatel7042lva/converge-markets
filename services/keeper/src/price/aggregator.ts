import type { PriceCfg } from "../config";

export type Tick = { source: string; price: number; tsMs: number };

export type PriceReason =
  "NO_PRICE" | "FEW_SOURCES" | "DIVERGENCE" | "SHOCK" | "CHAINLINK_MISMATCH";

export type SourceStatus = {
  name: string;
  price: number | null;
  ageMs: number | null;
  healthy: boolean;
};

export type PriceSnapshot = {
  tsMs: number;
  /** Median of the healthy sources; null when there are none. */
  price: number | null;
  /** True when the price may be used for quoting: enough healthy sources, no alarm. */
  healthy: boolean;
  reasons: PriceReason[];
  sources: SourceStatus[];
  /** Largest move of the median inside the shock window, in bps (absolute). */
  shockBps: number;
  /** Largest distance of a healthy source from the median, in bps. */
  divergenceBps: number;
  /** Distance of the median from the Chainlink answer, in bps (null when unavailable). */
  chainlinkBps: number | null;
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

const bps = (a: number, b: number): number => Math.abs(Math.log(a / b)) * 10_000;

/**
 * The reference price: the median of the healthy exchange feeds, checked for staleness, for
 * divergence between the sources, for a shock (a large move inside a short window) and against the
 * on-chain Chainlink feed. Pure: time comes in through `ingest` and `snapshot`.
 *
 * A source that sent nothing for `staleMs` is dropped. Fewer than `minSources` healthy sources, a
 * divergence, a shock or a Chainlink mismatch each make the snapshot unhealthy; the keeper pulls
 * every quote while it is.
 */
export class ReferencePrice {
  private readonly last = new Map<string, Tick>();
  /** Medians over time (for the shock check and for `priceAt`). */
  private history: { tsMs: number; price: number }[] = [];
  private chainlink: { price: number; updatedAtMs: number } | null = null;
  private lastShockMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly cfg: PriceCfg,
    private readonly sourceNames: readonly string[],
    /** The shock stays reported this long after the move left the window. */
    private readonly shockHoldMs = 10_000,
  ) {}

  ingest(t: Tick): void {
    if (!(Number.isFinite(t.price) && t.price > 0)) return;
    const prev = this.last.get(t.source);
    if (prev && t.tsMs < prev.tsMs) return; // out of order
    this.last.set(t.source, t);
    const healthy = this.healthyTicks(t.tsMs);
    if (healthy.length >= 1) {
      this.history.push({ tsMs: t.tsMs, price: median(healthy.map((x) => x.price)) });
      const cutoff = t.tsMs - 3_600_000;
      if (this.history.length > 50_000 || (this.history[0] && this.history[0].tsMs < cutoff)) {
        this.history = this.history.filter((h) => h.tsMs >= cutoff).slice(-50_000);
      }
    }
  }

  setChainlink(price: number, updatedAtMs: number): void {
    if (Number.isFinite(price) && price > 0) this.chainlink = { price, updatedAtMs };
  }

  private healthyTicks(nowMs: number): Tick[] {
    const out: Tick[] = [];
    for (const t of this.last.values()) if (nowMs - t.tsMs <= this.cfg.staleMs) out.push(t);
    return out;
  }

  snapshot(nowMs: number): PriceSnapshot {
    const healthy = this.healthyTicks(nowMs);
    const sources: SourceStatus[] = this.sourceNames.map((name) => {
      const t = this.last.get(name);
      const age = t ? nowMs - t.tsMs : null;
      return {
        name,
        price: t ? t.price : null,
        ageMs: age,
        healthy: t !== undefined && (age as number) <= this.cfg.staleMs,
      };
    });
    const reasons: PriceReason[] = [];
    if (healthy.length === 0) {
      return {
        tsMs: nowMs,
        price: null,
        healthy: false,
        reasons: ["NO_PRICE", "FEW_SOURCES"],
        sources,
        shockBps: 0,
        divergenceBps: 0,
        chainlinkBps: null,
      };
    }
    const price = median(healthy.map((t) => t.price));
    if (healthy.length < this.cfg.minSources) reasons.push("FEW_SOURCES");

    let divergenceBps = 0;
    for (const t of healthy) divergenceBps = Math.max(divergenceBps, bps(t.price, price));
    if (healthy.length >= 2 && divergenceBps > this.cfg.divergenceBps) reasons.push("DIVERGENCE");

    // Shock: the largest excursion of the median against any sample inside the window.
    let shockBps = 0;
    const from = nowMs - this.cfg.shockWindowMs;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i] as { tsMs: number; price: number };
      if (h.tsMs < from) break;
      shockBps = Math.max(shockBps, bps(price, h.price));
    }
    if (shockBps > this.cfg.shockBps) this.lastShockMs = nowMs;
    if (nowMs - this.lastShockMs <= this.shockHoldMs) reasons.push("SHOCK");

    let chainlinkBps: number | null = null;
    if (this.chainlink && nowMs - this.chainlink.updatedAtMs <= this.cfg.chainlinkMaxAgeMs) {
      chainlinkBps = bps(price, this.chainlink.price);
      if (chainlinkBps > this.cfg.sanityBps) reasons.push("CHAINLINK_MISMATCH");
    }
    return {
      tsMs: nowMs,
      price,
      healthy: reasons.length === 0,
      reasons,
      sources,
      shockBps,
      divergenceBps,
      chainlinkBps,
    };
  }

  /**
   * The median at (or just before) `tsMs`, if a sample exists no older than `staleMs`. Used to
   * build the report for a past second (an order's pricing time, an epoch end).
   */
  priceAt(tsMs: number): number | null {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i] as { tsMs: number; price: number };
      if (h.tsMs <= tsMs) return tsMs - h.tsMs <= this.cfg.staleMs * 2 ? h.price : null;
    }
    return null;
  }
}
