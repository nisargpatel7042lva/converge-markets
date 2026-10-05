import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyFill,
  buyRoom,
  drawdownBreaker,
  lossCeiling,
  marketExposure,
  maxLoss,
  pnlIfDown,
  pnlIfUp,
  sellRoom,
  totalAtRisk,
  type Position,
} from "../src";

const pos = fc.record({
  cash: fc.double({ min: -500, max: 500, noNaN: true }),
  shortUp: fc.double({ min: -800, max: 800, noNaN: true }),
});
const price = fc.double({ min: 0.02, max: 0.98, noNaN: true });

describe("positions", () => {
  it("settlement P&L and worst case", () => {
    const p: Position = { cash: 30, shortUp: 100 }; // sold 100 UP for 30
    expect(pnlIfUp(p)).toBe(-70);
    expect(pnlIfDown(p)).toBe(30);
    expect(maxLoss(p)).toBe(70);
    expect(marketExposure(p)).toBe(100);
    expect(maxLoss({ cash: 5, shortUp: 0 })).toBe(0); // a pure premium can't lose
    expect(maxLoss({ cash: -40, shortUp: -100 })).toBe(40); // bought 100 UP for 40
    expect(totalAtRisk([p, { cash: -40, shortUp: -100 }, { cash: 5, shortUp: 0 }])).toBe(110);
  });

  it("applyFill updates cash and exposure from the vault's side", () => {
    expect(applyFill({ cash: 0, shortUp: 0 }, "sell", 0.6, 10)).toEqual({ cash: 6, shortUp: 10 });
    expect(applyFill({ cash: 0, shortUp: 0 }, "buy", 0.4, 10)).toEqual({ cash: -4, shortUp: -10 });
  });
});

describe("room functions are exact: filling the room reaches the ceiling, never beyond", () => {
  const limits = { perMarketMaxFraction: 0.05, totalAtRiskMaxFraction: 0.4 };

  it("sellRoom", () => {
    fc.assert(
      fc.property(pos, price, fc.double({ min: 0, max: 600, noNaN: true }), (p, a, extra) => {
        const ceiling = Math.max(maxLoss(p), extra);
        const room = sellRoom(p, a, ceiling);
        expect(room).toBeGreaterThanOrEqual(0);
        expect(maxLoss(applyFill(p, "sell", a, room))).toBeLessThanOrEqual(ceiling + 1e-6);
        // Slightly more than the room would break the ceiling, if the room is not just zero.
        const over = maxLoss(applyFill(p, "sell", a, room + 1));
        expect(over).toBeGreaterThan(ceiling - 1e-9);
      }),
      { numRuns: 400 },
    );
  });

  it("buyRoom", () => {
    fc.assert(
      fc.property(pos, price, fc.double({ min: 0, max: 600, noNaN: true }), (p, b, extra) => {
        const ceiling = Math.max(maxLoss(p), extra);
        const room = buyRoom(p, b, ceiling);
        expect(room).toBeGreaterThanOrEqual(0);
        expect(maxLoss(applyFill(p, "buy", b, room))).toBeLessThanOrEqual(ceiling + 1e-6);
        const over = maxLoss(applyFill(p, "buy", b, room + 1));
        expect(over).toBeGreaterThan(ceiling - 1e-9);
      }),
      { numRuns: 400 },
    );
  });

  it("degenerate prices give no room", () => {
    expect(sellRoom({ cash: 0, shortUp: 0 }, 1, 100)).toBe(0);
    expect(buyRoom({ cash: 0, shortUp: 0 }, 0, 100)).toBe(0);
  });

  it("lossCeiling is the tighter of per-market and total room, never below the current loss", () => {
    const p: Position = { cash: 0, shortUp: 0 };
    expect(lossCeiling(p, 5000, 0, limits)).toBeCloseTo(250, 9);
    expect(lossCeiling(p, 5000, 1900, limits)).toBeCloseTo(100, 9); // total room 2000 − 1900
    expect(lossCeiling(p, 5000, 2500, limits)).toBe(0); // other markets already past the total
    const over: Position = { cash: 0, shortUp: 400 }; // loss 400 > per-market 250
    expect(lossCeiling(over, 5000, 0, limits)).toBe(400);
  });
});

describe("drawdown breaker", () => {
  it("trips at the limit and reports the drawdown", () => {
    expect(drawdownBreaker(5000, 4800, 0.05)).toEqual({ tripped: false, drawdown: 0.04 });
    expect(drawdownBreaker(5000, 4750, 0.05).tripped).toBe(true);
    expect(drawdownBreaker(5000, 5200, 0.05)).toEqual({ tripped: false, drawdown: 0 });
    expect(drawdownBreaker(0, 100, 0.05).tripped).toBe(true); // no valid reference: fail safe
  });
});
