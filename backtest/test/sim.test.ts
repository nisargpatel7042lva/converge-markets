import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "@converge/strategy";
import { epochSec } from "../src/data/binance";
import type { PriceSeries } from "../src/data/series";
import { makeConfig } from "../src/scenarios";
import { isUp, simulate } from "../src/sim";
import { synthSeries } from "./helpers";

const T0 = epochSec("2026-08-09");
const DAY = 86_400;
const mk = (seed: number, sigma = 0.6) => synthSeries("BTC/USD", T0, 3 * DAY, sigma, seed);
/** Tests that are not about the circuit breaker switch it off so it cannot confound them. */
const NO_BREAKER = { ...DEFAULT_PARAMS, drawdownBreakerFraction: 0.99 };
const cfg = (over: Parameters<typeof makeConfig>[0] = {}) =>
  makeConfig({
    params: NO_BREAKER,
    assets: ["BTC/USD"],
    durations: [900],
    startDay: "2026-08-10",
    endDay: "2026-08-11",
    ...over,
  });
const run = (c: ReturnType<typeof cfg>, s: PriceSeries) => simulate(c, new Map([["BTC/USD", s]]));

describe("settlement rule", () => {
  it("ties go UP, as in Market.sol", () => {
    expect(isUp(100, 100)).toBe(true);
    expect(isUp(100.0001, 100)).toBe(true);
    expect(isUp(99.9999, 100)).toBe(false);
  });
});

describe("accounting", () => {
  const s = mk(1);
  const r = run(cfg(), s);

  it("P&L decomposes exactly: edge(noise) + edge(informed) + residual − gas − fees = total", () => {
    expect(Math.abs(r.pnl.check)).toBeLessThan(1e-6);
    expect(r.pnl.total).toBeCloseTo(
      r.pnl.edgeNoise + r.pnl.edgeInformed + r.pnl.residual - r.pnl.gasUsd - r.pnl.redeemFees,
      6,
    );
  });

  it("daily and per-market P&L add up to the total", () => {
    expect(r.daily.reduce((a, d) => a + d.pnl, 0)).toBeCloseTo(r.pnl.total, 6);
    expect(Object.values(r.byMarket).reduce((a, b) => a + b.pnl, 0)).toBeCloseTo(
      r.pnl.total + r.pnl.gasUsd,
      6,
    );
    expect(r.rounds).toBe(96); // 24 h of 15 m rounds, one asset
    expect(r.days).toBe(1);
  });

  it("no taker flow means no fills and P&L equals minus gas", () => {
    const quiet = run(cfg({ flow: { noiseUsdPerHourPerMarket: 0, informedShare: 0 } }), s);
    expect(quiet.flow.noiseFills + quiet.flow.informedFills).toBe(0);
    expect(quiet.pnl.total).toBeCloseTo(-quiet.pnl.gasUsd, 9);
    expect(quiet.pnl.gasUsd).toBeGreaterThan(0);
    expect(quiet.risk.meanAbsInventoryShares).toBe(0);
  });

  it("an LP-side taker fee is income that keeps the decomposition exact; a protocol fee is not", () => {
    const base = run(cfg({ venue: { takerFeeBps: 50, feeToLp: false } }), s);
    const lp = run(cfg({ venue: { takerFeeBps: 50, feeToLp: true } }), s);
    expect(base.pnl.feeIncome).toBe(0);
    expect(base.flow.protocolFeesUsd).toBeGreaterThan(0);
    expect(lp.pnl.feeIncome).toBeGreaterThan(0);
    expect(lp.flow.protocolFeesUsd).toBe(0);
    expect(Math.abs(lp.pnl.check)).toBeLessThan(1e-6);
    expect(Math.abs(base.pnl.check)).toBeLessThan(1e-6);
  });

  it("redeem fees only ever cost the vault money", () => {
    const free = run(cfg(), s);
    const fee = run(cfg({ venue: { redeemFeeBps: 100 } }), s);
    expect(fee.pnl.redeemFees).toBeGreaterThan(0);
    expect(fee.pnl.total).toBeLessThan(free.pnl.total);
    expect(Math.abs(fee.pnl.check)).toBeLessThan(1e-6);
  });

  it("noise takers with no tolerance only trade when the quote is through fair value", () => {
    const flow = { informedShare: 0 };
    const stingy = run(cfg({ flow: { ...flow, noiseToleranceMean: 1e-9 } }), s);
    const normal = run(cfg({ flow: { ...flow, noiseToleranceMean: 0.06 } }), s);
    const inelastic = run(cfg({ flow: { ...flow, noiseToleranceMean: Infinity } }), s);
    expect(stingy.flow.noiseVolumeUsd).toBeLessThan(0.5 * normal.flow.noiseVolumeUsd);
    expect(normal.flow.noiseVolumeUsd).toBeLessThanOrEqual(inelastic.flow.noiseVolumeUsd + 1e-9);
    expect(stingy.pnl.edgeNoise).toBeLessThanOrEqual(1e-9); // they never pay a positive cost
    expect(normal.pnl.edgeNoise).toBeGreaterThan(0);
  });
});

describe("determinism", () => {
  it("the same config and data give identical results (digest and every number)", () => {
    const s = mk(2);
    const a = run(cfg(), s);
    const b = run(cfg(), s);
    expect(b.digest).toBe(a.digest);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
  it("a different seed changes the flow", () => {
    const s = mk(2);
    expect(run(cfg({ seed: 99 }), s).digest).not.toBe(run(cfg(), s).digest);
  });
});

describe("causality (no look-ahead)", () => {
  const cutoff = Date.parse("2026-08-10T09:00:00Z");
  const cutSec = cutoff / 1000;
  it("changing prices after a cutoff cannot change any fill before it", () => {
    const base = mk(3);
    const altered: PriceSeries = { ...base, px: Float64Array.from(base.px) };
    // Rewrite the future wildly, from the cutoff second onward.
    const from = cutSec - base.t0;
    for (let i = from; i < altered.px.length; i++) altered.px[i] = 100 + 40 * Math.sin(i / 997);
    const c = cfg({ flow: { informedShare: 0.5, noiseUsdPerHourPerMarket: 500 } });
    const a = simulate({ ...c, stopAtMs: cutoff }, new Map([["BTC/USD", base]]));
    const b = simulate({ ...c, stopAtMs: cutoff }, new Map([["BTC/USD", altered]]));
    expect(b.digest).toBe(a.digest);
    expect(a.flow.noiseFills + a.flow.informedFills).toBeGreaterThan(20); // the test has teeth
  });
  it("...but changing prices BEFORE the cutoff does change them", () => {
    const base = mk(3);
    const altered: PriceSeries = { ...base, px: Float64Array.from(base.px) };
    const from = cutSec - base.t0 - 3600;
    for (let i = from; i < from + 600; i++) altered.px[i] = altered.px[i]! * 1.002;
    const c = cfg({ flow: { informedShare: 0.5, noiseUsdPerHourPerMarket: 500 } });
    const a = simulate({ ...c, stopAtMs: cutoff }, new Map([["BTC/USD", base]]));
    const b = simulate({ ...c, stopAtMs: cutoff }, new Map([["BTC/USD", altered]]));
    expect(b.digest).not.toBe(a.digest);
  });
  it("a longer vault latency never improves a pure sniper's edge against it", () => {
    const s = mk(4, 0.9);
    const lo = run(cfg({ flow: { informedMode: "sniper", latencyMs: 400 } }), s);
    const hi = run(cfg({ flow: { informedMode: "sniper", latencyMs: 2000 } }), s);
    expect(hi.pnl.edgeInformed).toBeLessThanOrEqual(lo.pnl.edgeInformed + 1e-6);
  });
});

describe("causality tripwire and fill-time cutoffs (review M2)", () => {
  /** Wraps px so that every read records the highest index touched. */
  function tripwire(s: PriceSeries) {
    const state = { max: -1 };
    const px = new Proxy(s.px, {
      get(t, p) {
        if (typeof p === "string" && /^\d+$/.test(p)) state.max = Math.max(state.max, Number(p));
        const v = Reflect.get(t, p, t) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    return { series: { ...s, px: px as unknown as Float64Array }, state };
  }

  it("no block ever reads a price newer than the bar at its own timestamp", () => {
    for (const mode of [
      { informedMode: "arrivals" as const, latencyMs: 400 },
      { informedMode: "sniper" as const, latencyMs: 1500 },
    ]) {
      const { series, state } = tripwire(mk(11, 0.8));
      const violations: string[] = [];
      let prevT: number | null = null;
      const c = cfg({
        flow: { ...mode, noiseUsdPerHourPerMarket: 500, informedShare: 0.4 },
        venue: { quoteMode: "swapTime", execDelayBlocks: 3 },
      });
      c.onBlock = (t) => {
        if (prevT !== null && state.max > Math.floor(prevT / 1000) - series.t0) {
          violations.push(
            `block ${prevT}: read index ${state.max} > ${Math.floor(prevT / 1000) - series.t0}`,
          );
        }
        state.max = -1;
        prevT = t;
      };
      const r = simulate(c, new Map([["BTC/USD", series]]));
      expect(violations).toEqual([]);
      expect(r.flow.noiseFills + r.flow.informedFills).toBeGreaterThan(10);
    }
  });

  it("rewriting the future from the very bar after a fill never changes that fill or any earlier one", () => {
    const base = mk(12, 0.9);
    const c = cfg({
      flow: { informedMode: "sniper", latencyMs: 1000, noiseUsdPerHourPerMarket: 600 },
    });
    const times: number[] = [];
    const probe = { ...c, debugFill: (f: { tMs: number }) => void times.push(f.tMs) };
    simulate(probe, new Map([["BTC/USD", base]]));
    expect(times.length).toBeGreaterThan(15);
    const picks = [...new Set(times)]
      .filter((_, i) => i % Math.ceil(times.length / 8) === 0)
      .slice(0, 8);
    for (const t of picks) {
      const altered: PriceSeries = { ...base, px: Float64Array.from(base.px) };
      const idxNow = Math.floor(t / 1000) - base.t0;
      for (let i = idxNow + 1; i < altered.px.length; i++) altered.px[i] = altered.px[i]! * 1.01;
      const stop = { ...c, stopAtMs: t + 1 };
      const a = simulate(stop, new Map([["BTC/USD", base]]));
      const b = simulate(stop, new Map([["BTC/USD", altered]]));
      expect(b.digest).toBe(a.digest);
    }
  });
});

describe("independent P&L reconstruction (review: the identity alone is algebraic)", () => {
  it("rebuilding settlement from the raw fills reproduces the simulator's total", () => {
    const s = mk(13, 0.7);
    for (const venue of [
      { quoteMode: "posted" as const, execDelayBlocks: 0 },
      { quoteMode: "swapTime" as const, execDelayBlocks: 5 },
    ]) {
      const c = cfg({
        venue,
        flow: { informedShare: 0.3, noiseUsdPerHourPerMarket: 500, noiseToleranceMean: 0.1 },
      });
      const rounds = new Map<string, { cash: number; short: number; start: number; dur: number }>();
      let takerDollars = 0;
      c.debugFill = (f) => {
        const dur = f.market.endsWith("15m") ? 900_000 : 3_600_000;
        const start = Math.floor(f.tMs / dur) * dur;
        const k = `${f.market}|${start}`;
        const r = rounds.get(k) ?? { cash: 0, short: 0, start, dur };
        takerDollars += f.shares * (f.sign === 1 ? f.price : 1 - f.price);
        r.cash += f.sign * f.shares * f.price;
        r.short += f.sign * f.shares;
        rounds.set(k, r);
      };
      const res = run(c, s);
      let total = 0;
      for (const r of rounds.values()) {
        const strike = s.px[r.start / 1000 - s.t0]!;
        const end = s.px[(r.start + r.dur) / 1000 - s.t0]!;
        total += r.cash - (end >= strike ? r.short : 0);
      }
      expect(rounds.size).toBeGreaterThan(5);
      expect(total).toBeCloseTo(res.pnl.total + res.pnl.gasUsd, 6);
      // Reported volumes are taker dollars: UP at `price` when the vault sells UP, DOWN at 1 - price
      // when it buys UP (review: the DOWN-side change had no test).
      expect(takerDollars).toBeCloseTo(res.flow.noiseVolumeUsd + res.flow.informedVolumeUsd, 6);
    }
  });
});

describe("single-shot execution vs a sniper with a timing option (review H1)", () => {
  it("letting a sniper wait for a favourable block costs the vault money", () => {
    const s = mk(5, 0.9);
    const base = {
      informedMode: "sniper" as const,
      latencyMs: 2000,
      noiseUsdPerHourPerMarket: 250,
    };
    const venue = { quoteMode: "swapTime" as const, execDelayBlocks: 5 };
    const single = run(cfg({ flow: base, venue: { ...venue, execWindowBlocks: 0 } }), s);
    const patient = run(cfg({ flow: base, venue: { ...venue, execWindowBlocks: 25 } }), s);
    expect(patient.flow.informedFills).toBeGreaterThanOrEqual(single.flow.informedFills);
    expect(patient.pnl.edgeInformed).toBeLessThan(single.pnl.edgeInformed);
    expect(Math.abs(patient.pnl.check)).toBeLessThan(1e-6);
  });

  it("counts informed gains as zero per day, and losses in full", () => {
    const r = run(cfg({ flow: { informedMode: "sniper", latencyMs: 1000 } }), mk(14, 0.9));
    expect(r.pnl.edgeInformedCounted).toBeLessThanOrEqual(0);
    expect(r.pnl.edgeInformedCounted).toBeCloseTo(Math.min(0, r.pnl.edgeInformed), 9);
    expect(r.flow.informedOrdersPlaced).toBeLessThanOrEqual(r.flow.informedOrders);
  });
});

describe("gas, risk caps and statistics (review iteration 2)", () => {
  it("forward-priced execution charges gas for every executed order that fills, informed ones included", () => {
    const s = mk(15, 0.9);
    const r = run(
      cfg({
        flow: {
          informedMode: "sniper",
          latencyMs: 3000,
          noiseUsdPerHourPerMarket: 0,
          informedShare: 0,
        },
        venue: { quoteMode: "swapTime", execDelayBlocks: 3 },
      }),
      s,
    );
    expect(r.flow.informedOrdersTraded).toBeGreaterThan(5);
    const perFill = 400_000 * 102e-9 * 0.0343;
    expect(r.pnl.gasUsd).toBeCloseTo(r.flow.informedOrdersTraded * perFill, 9);
  });

  it("the total at-risk cap binds across markets even though each market is under its own cap", () => {
    const s = mk(16, 0.8);
    const tight = {
      ...NO_BREAKER,
      liquidityNavFraction: 1,
      perMarketMaxFraction: 0.05,
      totalAtRiskMaxFraction: 0.06, // barely more than one market's cap, with 2 markets live
    };
    const r = run(
      cfg({
        params: tight,
        durations: [900, 3600],
        flow: { noiseUsdPerHourPerMarket: 2000, noiseToleranceMean: Infinity, informedShare: 0 },
      }),
      s,
    );
    expect(r.flow.noiseFills).toBeGreaterThan(50);
    // 6% of NAV, plus a little slack for NAV moving between the check and the fill.
    expect(r.risk.peakAtRiskPct).toBeLessThanOrEqual(6.5);
  });
});

describe("economics sanity", () => {
  it("informed flow loses the vault money against a drifting price; noise flow earns", () => {
    const s = mk(5, 0.9);
    const r = run(
      cfg({
        flow: { informedMode: "sniper", latencyMs: 2000, noiseToleranceMean: Infinity },
        params: { ...NO_BREAKER, minHalfSpread: 0.005 },
      }),
      s,
    );
    expect(r.pnl.edgeNoise).toBeGreaterThan(0);
    expect(r.pnl.edgeInformed).toBeLessThan(0);
  });
  it("the breaker pauses quoting after a large drawdown but never touches settled accounting", () => {
    const s = mk(6, 2);
    const tight = { ...DEFAULT_PARAMS, drawdownBreakerFraction: 0.001 };
    const loose = run(cfg({ flow: { noiseUsdPerHourPerMarket: 3000 } }), s);
    const r = run(cfg({ params: tight, flow: { noiseUsdPerHourPerMarket: 3000 } }), s);
    expect(loose.risk.breakerTripDays).toBe(0);
    expect(r.risk.breakerTripDays).toBe(1);
    expect(r.venue.quoteUptimePct).toBeLessThan(loose.venue.quoteUptimePct);
    expect(Math.abs(r.pnl.check)).toBeLessThan(1e-6);
  });
  it("evaluates only strided days when asked", () => {
    const s = mk(7);
    const two = simulate(
      { ...cfg({ startDay: "2026-08-10", endDay: "2026-08-12", dayStride: 2 }) },
      new Map([["BTC/USD", s]]),
    );
    expect(two.days).toBe(1);
  });
});
