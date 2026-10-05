import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyFill,
  DEFAULT_PARAMS,
  fairProbUp,
  generateQuotes,
  halfSpread,
  inventorySkew,
  lossCeiling,
  maxLoss,
  SECONDS_PER_YEAR,
  shouldRepost,
  summarize,
  type MarketState,
  type StrategyParams,
} from "../src";
import { P, state } from "./helpers";

const TOL = 1e-9;
const onGrid = (price: number, tick: number) =>
  Math.abs(price / tick - Math.round(price / tick)) < 1e-6;

const paramsArb: fc.Arbitrary<StrategyParams> = fc
  .record({
    minHalfSpread: fc.double({ min: 0.005, max: 0.05, noNaN: true }),
    volSpreadK: fc.double({ min: 0, max: 3, noNaN: true }),
    stalenessSec: fc.double({ min: 0.2, max: 5, noNaN: true }),
    inventorySkewMax: fc.double({ min: 0, max: 0.1, noNaN: true }),
    inventorySkewK: fc.double({ min: 0, max: 5, noNaN: true }),
    toxicityPullBps: fc.double({ min: 3, max: 60, noNaN: true }),
    toxicityWidenMax: fc.double({ min: 0, max: 0.1, noNaN: true }),
    noQuoteWindowSec: fc.double({ min: 0, max: 120, noNaN: true }),
    levels: fc.integer({ min: 1, max: 5 }),
    baseRangeTicks: fc.double({ min: 0, max: 12, noNaN: true }),
    minRangeTicks: fc.double({ min: 0, max: 5, noNaN: true }),
    liquidityNavFraction: fc.double({ min: 0.05, max: 3, noNaN: true }),
    minLevelSize: fc.double({ min: 0, max: 5, noNaN: true }),
    tick: fc.constantFrom(0.01, 0.005, 0.0025),
  })
  .map((o) => ({ ...DEFAULT_PARAMS, ...o, maxHalfSpread: Math.max(0.2, o.minHalfSpread) }));

const stateArb: fc.Arbitrary<MarketState> = fc
  .record({
    m: fc.double({ min: -0.03, max: 0.03, noNaN: true }),
    roundSec: fc.constantFrom(900, 3600),
    frac: fc.double({ min: 0, max: 1, noNaN: true }),
    sigma: fc.double({ min: 0.1, max: 3, noNaN: true }),
    cash: fc.double({ min: -300, max: 300, noNaN: true }),
    shortUp: fc.double({ min: -600, max: 600, noNaN: true }),
    nav: fc.double({ min: 100, max: 100_000, noNaN: true }),
    otherFrac: fc.double({ min: 0, max: 0.6, noNaN: true }),
    range: fc.double({ min: 0, max: 80, noNaN: true }),
    breaker: fc.boolean(),
  })
  .map((o) => ({
    spot: 100 * Math.exp(o.m),
    strike: 100,
    tauSec: o.roundSec * o.frac,
    roundSec: o.roundSec,
    sigma: o.sigma,
    position: { cash: o.cash, shortUp: o.shortUp },
    nav: o.nav,
    otherAtRisk: o.otherFrac * o.nav,
    recentRangeBps: o.range,
    breakerTripped: o.breaker,
  }));

describe("generateQuotes: invariants (property tests)", () => {
  it("prices stay in bounds on the tick grid, are never crossed, and never quote through fair value", () => {
    fc.assert(
      fc.property(stateArb, paramsArb, (s, p) => {
        const q = generateQuotes(s, p);
        if (q.status !== "quoting") {
          expect(q.up.bids).toHaveLength(0);
          expect(q.up.asks).toHaveLength(0);
          return;
        }
        for (const l of [...q.up.bids, ...q.up.asks, ...q.down.bids, ...q.down.asks]) {
          expect(l.price).toBeGreaterThanOrEqual(p.priceMin - TOL);
          expect(l.price).toBeLessThanOrEqual(p.priceMax + TOL);
          expect(onGrid(l.price, p.tick)).toBe(true);
          expect(l.size).toBeGreaterThan(0);
          expect(Number.isFinite(l.size)).toBe(true);
        }
        for (let i = 1; i < q.up.bids.length; i++)
          expect(q.up.bids[i]!.price).toBeLessThan(q.up.bids[i - 1]!.price);
        for (let i = 1; i < q.up.asks.length; i++)
          expect(q.up.asks[i]!.price).toBeGreaterThan(q.up.asks[i - 1]!.price);
        if (q.up.bids[0] && q.up.asks[0])
          expect(q.up.bids[0].price).toBeLessThan(q.up.asks[0].price);
        if (q.down.bids[0] && q.down.asks[0])
          expect(q.down.bids[0].price).toBeLessThan(q.down.asks[0].price);
        const fair = q.fair;
        for (const b of q.up.bids)
          expect(b.price).toBeLessThanOrEqual(fair - 0.2 * q.halfSpread + TOL);
        for (const a of q.up.asks)
          expect(a.price).toBeGreaterThanOrEqual(fair + 0.2 * q.halfSpread - TOL);
        // DOWN is the complement of UP.
        expect(q.down.bids.map((l) => l.size)).toEqual(q.up.asks.map((l) => l.size).reverse());
        expect(q.down.asks.map((l) => l.size)).toEqual(q.up.bids.map((l) => l.size).reverse());
        q.down.bids.forEach((l, i) =>
          expect(l.price).toBeCloseTo(1 - q.up.asks[q.up.asks.length - 1 - i]!.price, 9),
        );
      }),
      { numRuns: 1500 },
    );
  });

  it("filling every posted level never pushes a market's worst-case loss past its ceiling", () => {
    fc.assert(
      fc.property(stateArb, paramsArb, (s, p) => {
        const q = generateQuotes(s, p);
        const ceiling = lossCeiling(s.position, s.nav, s.otherAtRisk, p);
        let pos = s.position;
        for (const a of q.up.asks) pos = applyFill(pos, "sell", a.price, a.size);
        expect(maxLoss(pos)).toBeLessThanOrEqual(ceiling + 1e-6);
        pos = s.position;
        for (const b of q.up.bids) pos = applyFill(pos, "buy", b.price, b.size);
        expect(maxLoss(pos)).toBeLessThanOrEqual(ceiling + 1e-6);
      }),
      { numRuns: 1500 },
    );
  });

  it("the half-spread never drops below the floor and the quote spread respects it", () => {
    fc.assert(
      fc.property(stateArb, paramsArb, (s, p) => {
        const q = generateQuotes(s, p);
        if (q.status !== "quoting") return;
        expect(q.halfSpread).toBeGreaterThanOrEqual(p.minHalfSpread - TOL);
        expect(q.halfSpread).toBeLessThanOrEqual(p.maxHalfSpread + TOL);
        if (q.up.bids[0] && q.up.asks[0])
          expect(q.up.asks[0].price - q.up.bids[0].price).toBeGreaterThanOrEqual(
            2 * 0.2 * q.halfSpread - TOL,
          );
      }),
      { numRuns: 800 },
    );
  });

  it("sizes shrink toward expiry (pm-AMM L_t = L·√(T−t), range narrowing) at fixed fair value", () => {
    const loose: StrategyParams = {
      ...P,
      perMarketMaxFraction: 1,
      totalAtRiskMaxFraction: 1,
      noQuoteWindowSec: 0,
      minLevelSize: 0,
    };
    fc.assert(
      fc.property(
        fc.double({ min: 90, max: 900, noNaN: true }),
        fc.double({ min: 0.6, max: 0.95, noNaN: true }),
        (tau, ratio) => {
          // sigma tiny and spot = strike keep fair ≈ 0.5 for both times.
          const a = generateQuotes(state({ tauSec: tau, sigma: 0.05 }), loose);
          const b = generateQuotes(state({ tauSec: tau * ratio, sigma: 0.05 }), loose);
          const total = (q: typeof a) =>
            q.up.asks.reduce((x, l) => x + l.size, 0) + q.up.bids.reduce((x, l) => x + l.size, 0);
          expect(total(b)).toBeLessThanOrEqual(total(a) * (1 + 1e-6));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("respects the concentration floor: the ladder spans at least minRangeTicks (centred fair)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.double({ min: 61, max: 900, noNaN: true }),
        fc.integer({ min: 1, max: 8 }),
        (levels, tau, floor) => {
          const p: StrategyParams = {
            ...P,
            levels,
            minRangeTicks: floor,
            baseRangeTicks: floor,
            noQuoteWindowSec: 0,
            maxHalfSpread: 0.2,
            liquidityNavFraction: 3,
            perMarketMaxFraction: 1,
            totalAtRiskMaxFraction: 1,
            minLevelSize: 0,
          };
          const q = generateQuotes(state({ tauSec: tau, sigma: 0.3 }), p);
          expect(q.status).toBe("quoting");
          const span = (ls: { price: number }[]) =>
            Math.abs(ls[0]!.price - ls[ls.length - 1]!.price) / p.tick;
          if (q.up.asks.length === levels)
            expect(span(q.up.asks)).toBeGreaterThanOrEqual(floor - 1e-6);
          if (q.up.bids.length === levels)
            expect(span(q.up.bids)).toBeGreaterThanOrEqual(floor - 1e-6);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("generateQuotes: behaviour", () => {
  it("quotes both sides around fair value for a balanced at-the-money market", () => {
    const q = generateQuotes(state(), P);
    expect(q.status).toBe("quoting");
    expect(q.up.bids.length).toBe(3);
    expect(q.up.asks.length).toBe(3);
    expect(q.fair).toBeCloseTo(fairProbUp(100, 100, 0.5, 600 / SECONDS_PER_YEAR), 12);
    expect(q.halfSpread).toBeGreaterThanOrEqual(P.minHalfSpread);
  });

  it("stops quoting in the no-quote window, on a trip, on toxic flow, and on bad input", () => {
    expect(generateQuotes(state({ tauSec: 60 }), P).status).toBe("no-quote-window");
    expect(generateQuotes(state({ tauSec: 59 }), P).status).toBe("no-quote-window");
    expect(generateQuotes(state({ tauSec: -5 }), P).status).toBe("no-quote-window");
    expect(generateQuotes(state({ breakerTripped: true }), P).status).toBe("breaker");
    expect(generateQuotes(state({ recentRangeBps: P.toxicityPullBps }), P).status).toBe("toxic");
    for (const bad of [
      { spot: NaN },
      { spot: -1 },
      { strike: 0 },
      { sigma: -1 },
      { tauSec: NaN },
      { nav: 0 },
      { otherAtRisk: NaN },
      { recentRangeBps: NaN },
      { position: { cash: NaN, shortUp: 0 } },
      { position: { cash: 0, shortUp: Infinity } },
    ]) {
      expect(generateQuotes(state(bad), P).status).toBe("invalid");
    }
  });

  it("widens the half-spread for toxicity and as expiry nears, and caps it", () => {
    const calm = halfSpread(state({ tauSec: 600 }), P);
    const near = halfSpread(state({ tauSec: 70 }), P);
    expect(near).toBeGreaterThan(calm);
    const half = P.toxicityPullBps * 0.5;
    expect(halfSpread(state({ recentRangeBps: half }), P)).toBeCloseTo(halfSpread(state(), P), 12);
    expect(halfSpread(state({ recentRangeBps: P.toxicityPullBps - 0.01 }), P)).toBeGreaterThan(
      halfSpread(state(), P) + 0.9 * P.toxicityWidenMax,
    );
    expect(halfSpread(state({ tauSec: 61, sigma: 3 }), { ...P, volSpreadK: 50 })).toBe(
      P.maxHalfSpread,
    );
    // Decided outcome (spot far from strike): the staleness term vanishes, only the floor remains.
    expect(halfSpread(state({ spot: 150 }), P)).toBe(P.minHalfSpread);
  });

  it("skews the centre against inventory: short UP raises quotes, long UP lowers them", () => {
    const flat = generateQuotes(state(), P);
    const short = generateQuotes(state({ position: { cash: 100, shortUp: 150 } }), P);
    const long = generateQuotes(state({ position: { cash: -100, shortUp: -150 } }), P);
    expect(short.skew).toBeGreaterThan(0);
    expect(long.skew).toBeLessThan(0);
    expect(flat.skew).toBe(0);
    expect(short.up.bids[0]!.price).toBeGreaterThanOrEqual(flat.up.bids[0]!.price);
    expect(long.up.asks[0]!.price).toBeLessThanOrEqual(flat.up.asks[0]!.price);
    // The skew can never reach through fair value: |skew| ≤ 0.8·h.
    const big = state({ position: { cash: 0, shortUp: 1e6 } });
    expect(inventorySkew(big.position, big.nav, P, 0.02)).toBeCloseTo(0.016, 12);
    expect(inventorySkew({ cash: 0, shortUp: -1e6 }, 5000, P, 0.02)).toBeCloseTo(-0.016, 12);
  });

  it("quotes only the safe side when fair value is near a bound, and nothing when it can't", () => {
    const deepUp = generateQuotes(state({ spot: 103 }), { ...P, noQuoteWindowSec: 0 });
    expect(deepUp.up.asks).toHaveLength(0); // would have to sell above 0.98
    expect(deepUp.up.bids.length).toBeGreaterThan(0);
    const deepDown = generateQuotes(state({ spot: 97 }), { ...P, noQuoteWindowSec: 0 });
    expect(deepDown.up.bids).toHaveLength(0);
    expect(deepDown.up.asks.length).toBeGreaterThan(0);
    const dead = generateQuotes(state({ spot: 200, tauSec: 70 }), { ...P, noQuoteWindowSec: 0 });
    expect(dead.status).toBe("quoting"); // one-sided bids at ≤ 0.98 − h still make sense
    expect(dead.up.asks).toHaveLength(0);
  });

  it("skips levels outside the bounds when fair value is beyond them (found by property test)", () => {
    const p = { ...P, noQuoteWindowSec: 0, minHalfSpread: 0.005 };
    // Decided UP (tie goes UP at expiry): fair ≈ 1, so bids above priceMax are dropped.
    const up = generateQuotes(state({ spot: 100.5, tauSec: 1 }), p);
    expect(up.fair).toBeGreaterThan(0.99999);
    expect(up.up.bids.length).toBeGreaterThan(0);
    for (const b of up.up.bids) expect(b.price).toBeLessThanOrEqual(p.priceMax);
    expect(up.up.asks).toHaveLength(0);
    // Decided DOWN: fair ≈ 0, so asks below priceMin are dropped.
    const down = generateQuotes(state({ spot: 99.5, tauSec: 1 }), p);
    expect(down.fair).toBeLessThan(0.00001);
    expect(down.up.asks.length).toBeGreaterThan(0);
    for (const a of down.up.asks) expect(a.price).toBeGreaterThanOrEqual(p.priceMin);
    expect(down.up.bids).toHaveLength(0);
  });

  it("returns 'no-liquidity' when risk limits leave nothing to quote", () => {
    const q = generateQuotes(
      state({ position: { cash: 0, shortUp: 0 }, otherAtRisk: 5000 * 0.4 }),
      P,
    );
    expect(q.status).toBe("no-liquidity");
    expect(q.up.bids).toHaveLength(0);
    expect(q.halfSpread).toBeGreaterThan(0);
  });

  it("stops adding to a position already past its limit but still lets it reduce", () => {
    const over = state({ position: { cash: 0, shortUp: 600 } }); // loss 600 > 5% of 5000
    const q = generateQuotes(over, P);
    expect(q.up.asks).toHaveLength(0);
    expect(q.up.bids.length).toBeGreaterThan(0);
  });

  it("with a single level it quotes one price per side", () => {
    const q = generateQuotes(state(), { ...P, levels: 1 });
    expect(q.up.bids).toHaveLength(1);
    expect(q.up.asks).toHaveLength(1);
  });

  it("drops dust levels", () => {
    const q = generateQuotes(state(), { ...P, minLevelSize: 1e9 });
    expect(q.status).toBe("no-liquidity");
  });
});

describe("shouldRepost (keeper posting rule)", () => {
  const q = generateQuotes(state(), P);
  const posted = summarize(q);

  it("posts first, on status changes, on age, and on a move of at least refreshTicks", () => {
    expect(shouldRepost(null, q, 0, P)).toBe(true);
    expect(shouldRepost(posted, q, 0, P)).toBe(false);
    expect(shouldRepost(posted, q, P.maxQuoteAgeBlocks, P)).toBe(true);
    const toxic = generateQuotes(state({ recentRangeBps: 50 }), P);
    expect(shouldRepost(posted, toxic, 0, P)).toBe(true);
    const moved = generateQuotes(state({ spot: 100.03 }), P);
    expect(moved.up.asks[0]!.price).not.toBe(q.up.asks[0]!.price);
    expect(shouldRepost(posted, moved, 0, P)).toBe(true);
    expect(shouldRepost(posted, moved, 0, { ...P, refreshTicks: 50 })).toBe(false);
  });

  it("treats a side appearing or vanishing as a change", () => {
    const oneSided = generateQuotes(state({ spot: 103 }), { ...P, noQuoteWindowSec: 0 });
    const twoSided = generateQuotes(state(), { ...P, noQuoteWindowSec: 0 });
    expect(shouldRepost(summarize(twoSided), oneSided, 0, P)).toBe(true);
    expect(shouldRepost(summarize(oneSided), twoSided, 0, P)).toBe(true);
    expect(shouldRepost(summarize(oneSided), oneSided, 0, P)).toBe(false);
  });
});
