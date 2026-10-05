import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buyRoomOf,
  DEFAULT_PARAMS,
  generateQuotes,
  lossCeilingOf,
  lossOf,
  onchainD2,
  onchainQuote,
  sellRoomOf,
  SECONDS_PER_YEAR,
  fairProbUp,
  type OnchainParams,
  type Pos,
} from "../src";

const P: OnchainParams = {
  minHalfSpread: 0.05,
  maxHalfSpread: 0.2,
  volSpreadK: 1,
  stalenessSec: 4,
  inventorySkewMax: 0.1,
  inventorySkewK: 2,
  noQuoteWindowSec: 30,
  priceMin: 0.02,
  priceMax: 0.98,
  tick: 0.01,
  levels: 2,
  baseRangeTicks: 8,
  minRangeTicks: 2,
  liquidityNavFraction: 0.12,
  minLevelSize: 1,
  perMarketMaxFraction: 0.01,
  totalAtRiskMaxFraction: 0.08,
};
const FLAT: Pos = { basis: 0, cash: 0, up: 0, down: 0 };

describe("onchainD2", () => {
  it("is ±100 when the digital is degenerate, ties UP", () => {
    expect(onchainD2(100, 100, 0.5, 0)).toBe(100);
    expect(onchainD2(100, 100, 0, 600)).toBe(100);
    expect(onchainD2(99, 100, 0.5, 0)).toBe(-100);
    expect(onchainD2(1e9, 1, 0.001, 1)).toBe(100);
  });
});

describe("onchainQuote", () => {
  it("quotes both sides around fair value at the money", () => {
    const q = onchainQuote(70_000, 70_000, 0.5, 600, 900, 5000, FLAT, P);
    expect(q.quoting).toBe(true);
    expect(q.fair).toBeCloseTo(fairProbUp(70_000, 70_000, 0.5, 600 / SECONDS_PER_YEAR), 12);
    expect(q.bids).toHaveLength(2);
    expect(q.asks).toHaveLength(2);
    expect(q.skew).toBeCloseTo(0, 12);
  });

  it("does not quote in the no-quote window or on unusable inputs", () => {
    for (const args of [
      [70_000, 70_000, 0.5, 30, 900, 5000],
      [70_000, 70_000, 0.5, 0, 900, 5000],
      [0, 70_000, 0.5, 600, 900, 5000],
      [70_000, 0, 0.5, 600, 900, 5000],
      [70_000, 70_000, 0.5, 600, 900, 0],
      [70_000, 70_000, 0.5, 600, 0, 5000],
    ] as const) {
      expect(onchainQuote(...args, FLAT, P).quoting).toBe(false);
    }
    expect(
      onchainQuote(70_000, 70_000, 0.5, 600, 900, 5000, FLAT, { ...P, minLevelSize: 1e12 }).quoting,
    ).toBe(false);
  });

  it("leans against inventory and shrinks depth toward expiry", () => {
    const longUp = onchainQuote(
      70_000,
      70_000,
      0.5,
      600,
      900,
      5000,
      { basis: 500, cash: 0, up: 500, down: 0 },
      P,
    );
    const shortUp = onchainQuote(
      70_000,
      70_000,
      0.5,
      600,
      900,
      5000,
      { basis: 500, cash: 0, up: 0, down: 500 },
      P,
    );
    expect(longUp.skew).toBeLessThan(0);
    expect(shortUp.skew).toBeGreaterThan(0);
    const early = onchainQuote(70_000, 70_000, 0.3, 900, 900, 5000, FLAT, P);
    const late = onchainQuote(70_000, 70_000, 0.3, 200, 900, 5000, FLAT, P);
    expect(late.asks[0]!.size).toBeLessThan(early.asks[0]!.size);
  });

  it("agrees with the keeper-side generateQuotes on fair value, spread floor and the first prices", () => {
    // Same state, flat inventory, toxicity off: fair value and spread are identical; the first
    // level matches (only deeper levels differ: z-space vs price-space spacing).
    const p = {
      ...DEFAULT_PARAMS,
      minHalfSpread: 0.05,
      stalenessSec: 4,
      levels: 2,
      baseRangeTicks: 8,
      noQuoteWindowSec: 30,
    };
    const keeper = generateQuotes(
      {
        spot: 70_000,
        strike: 70_000,
        tauSec: 600,
        roundSec: 900,
        sigma: 0.5,
        position: { cash: 0, shortUp: 0 },
        nav: 5000,
        otherAtRisk: 0,
        recentRangeBps: 0,
        breakerTripped: false,
      },
      p,
    );
    const chain = onchainQuote(70_000, 70_000, 0.5, 600, 900, 5000, FLAT, {
      ...P,
      liquidityNavFraction: p.liquidityNavFraction,
      perMarketMaxFraction: p.perMarketMaxFraction,
      totalAtRiskMaxFraction: p.totalAtRiskMaxFraction,
    });
    expect(chain.fair).toBeCloseTo(keeper.fair, 12);
    expect(chain.halfSpread).toBeCloseTo(keeper.halfSpread, 12);
    expect(chain.bids[0]!.price).toBeCloseTo(keeper.up.bids[0]!.price, 9);
    expect(chain.asks[0]!.price).toBeCloseTo(keeper.up.asks[0]!.price, 9);
  });

  it("merges ladder levels that land on the same tick (flat tails)", () => {
    const q = onchainQuote(70_000 * 1.0005, 70_000, 1.5, 900, 900, 5000, FLAT, {
      ...P,
      levels: 4,
      minHalfSpread: 0.02,
      maxHalfSpread: 0.2,
      volSpreadK: 0,
    });
    for (const side of [q.bids, q.asks]) {
      for (let i = 1; i < side.length; i++) expect(side[i]!.price).not.toBe(side[i - 1]!.price);
    }
    const deep = onchainQuote(70_000 * 1.02, 70_000, 0.1, 900, 900, 5000, FLAT, {
      ...P,
      levels: 4,
      minHalfSpread: 0.001,
      tick: 0.001,
      priceMin: 0.001,
      priceMax: 0.999,
    });
    const total = deep.bids.reduce((a, l) => a + l.size, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("holds the quote invariants for random states (bounds, grid, never crossed, never through fair)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -0.03, max: 0.03, noNaN: true }),
        fc.double({ min: 31, max: 3600, noNaN: true }),
        fc.double({ min: 0.1, max: 2, noNaN: true }),
        fc.double({ min: 0, max: 800, noNaN: true }),
        fc.double({ min: 0, max: 800, noNaN: true }),
        fc.integer({ min: 1, max: 4 }),
        (m, tau, sigma, up, down, levels) => {
          const pos: Pos = { basis: Math.max(up, down) + 10, cash: 5, up, down };
          const q = onchainQuote(70_000 * Math.exp(m), 70_000, sigma, tau, 3600, 5000, pos, {
            ...P,
            levels,
          });
          if (!q.quoting) return;
          expect(q.halfSpread).toBeGreaterThanOrEqual(P.minHalfSpread);
          for (const b of q.bids) {
            expect(b.price).toBeGreaterThanOrEqual(P.priceMin - 1e-9);
            expect(b.price).toBeLessThanOrEqual(q.fair - 0.2 * q.halfSpread + 1e-9);
            expect(Math.abs(b.price / P.tick - Math.round(b.price / P.tick))).toBeLessThan(1e-6);
          }
          for (const a of q.asks) {
            expect(a.price).toBeLessThanOrEqual(P.priceMax + 1e-9);
            expect(a.price).toBeGreaterThanOrEqual(q.fair + 0.2 * q.halfSpread - 1e-9);
          }
          if (q.bids[0] && q.asks[0]) expect(q.bids[0].price).toBeLessThan(q.asks[0].price);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("risk room on token balances", () => {
  const pos = fc.record({
    up: fc.double({ min: 0, max: 500, noNaN: true }),
    down: fc.double({ min: 0, max: 500, noNaN: true }),
    extra: fc.double({ min: 0, max: 30, noNaN: true }),
    cash: fc.double({ min: -100, max: 200, noNaN: true }),
    price: fc.double({ min: 0.02, max: 0.98, noNaN: true }),
    slack: fc.double({ min: 0, max: 60, noNaN: true }),
  });

  it("filling the room never pushes the loss past the ceiling, for all four actions", () => {
    fc.assert(
      fc.property(pos, (s) => {
        const p: Pos = {
          basis: Math.max(s.up, s.down) + s.extra,
          cash: s.cash,
          up: s.up,
          down: s.down,
        };
        const ceiling = lossOf(p) + s.slack;
        const tol = 1e-6;
        const x = sellRoomOf(p.basis, p.cash, p.up, p.down, s.price, ceiling);
        expect(x).toBeLessThanOrEqual(p.up + tol);
        expect(lossOf({ ...p, cash: p.cash + s.price * x, up: p.up - x })).toBeLessThanOrEqual(
          ceiling + tol,
        );
        const y = buyRoomOf(p.basis, p.cash, p.up, p.down, s.price, ceiling);
        expect(lossOf({ ...p, cash: p.cash - s.price * y, up: p.up + y })).toBeLessThanOrEqual(
          ceiling + tol,
        );
        const z = sellRoomOf(p.basis, p.cash, p.down, p.up, s.price, ceiling);
        expect(lossOf({ ...p, cash: p.cash + s.price * z, down: p.down - z })).toBeLessThanOrEqual(
          ceiling + tol,
        );
        const w = buyRoomOf(p.basis, p.cash, p.down, p.up, s.price, ceiling);
        expect(lossOf({ ...p, cash: p.cash - s.price * w, down: p.down + w })).toBeLessThanOrEqual(
          ceiling + tol,
        );
      }),
      { numRuns: 500 },
    );
  });

  it("edge cases and the loss ceiling", () => {
    expect(sellRoomOf(0, 0, 0, 0, 0.5, 100)).toBe(0);
    expect(sellRoomOf(0, 0, 10, 0, 1, 100)).toBe(0);
    expect(buyRoomOf(0, 0, 0, 0, 0, 100)).toBe(0);
    const p: Pos = { basis: 100, cash: 30, up: 40, down: 40 };
    expect(lossOf(p)).toBe(30);
    expect(lossOf({ basis: 100, cash: 90, up: 50, down: 50 })).toBe(0);
    const q = { perMarketMaxFraction: 0.01, totalAtRiskMaxFraction: 0.08 };
    expect(lossCeilingOf(p, 100, 0, q)).toBe(30); // never below the current loss
    expect(lossCeilingOf({ basis: 100, cash: 90, up: 50, down: 50 }, 1000, 0, q)).toBe(10);
    expect(lossCeilingOf({ basis: 100, cash: 90, up: 50, down: 50 }, 1000, 75, q)).toBeCloseTo(
      5,
      9,
    );
    expect(lossCeilingOf({ basis: 100, cash: 90, up: 50, down: 50 }, 1000, 500, q)).toBe(0);
  });
});
