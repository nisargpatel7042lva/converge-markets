import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { liquidityScale, normCdf, normInv, normPdf, pmAmmShares, rangeTicks } from "../src";

/** Reserves of the static pm-AMM at price P (Paradigm paper): y−x = L·Φ⁻¹(P) and the invariant
 * (y−x)Φ((y−x)/L) + Lφ((y−x)/L) − y = 0 solved for y. */
function reserves(P: number, L: number): { x: number; y: number } {
  const z = normInv(P);
  const y = L * (z * normCdf(z) + normPdf(z));
  return { x: y - L * z, y };
}

describe("liquidity schedule (Paradigm dynamic pm-AMM, L_t = L·√(T−t))", () => {
  it("scales as √(τ/T), clamped to [0, 1]", () => {
    expect(liquidityScale(900, 900)).toBe(1);
    expect(liquidityScale(225, 900)).toBeCloseTo(0.5, 12);
    expect(liquidityScale(0, 900)).toBe(0);
    expect(liquidityScale(-5, 900)).toBe(0);
    expect(liquidityScale(2000, 900)).toBe(1);
    expect(() => liquidityScale(10, 0)).toThrow(RangeError);
  });

  it("is non-increasing as expiry approaches", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 3600, noNaN: true }),
        fc.double({ min: 0, max: 3600, noNaN: true }),
        (a, b) => {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          expect(liquidityScale(lo, 3600)).toBeLessThanOrEqual(liquidityScale(hi, 3600));
        },
      ),
    );
  });

  it("pmAmmShares equals the reserve-difference change of the paper's invariant", () => {
    const L = 250;
    for (const [p0, p1] of [
      [0.5, 0.55],
      [0.3, 0.7],
      [0.9, 0.95],
      [0.02, 0.5],
    ] as const) {
      const a = reserves(p0, L);
      const b = reserves(p1, L);
      expect(pmAmmShares(p0, p1, L)).toBeCloseTo(Math.abs(b.y - b.x - (a.y - a.x)), 9);
    }
  });

  it("the reserves satisfy the invariant and the pool value is L·φ(Φ⁻¹(P))", () => {
    const L = 100;
    for (const P of [0.05, 0.3, 0.5, 0.8, 0.97]) {
      const { x, y } = reserves(P, L);
      const z = (y - x) / L;
      expect(Math.abs((y - x) * normCdf(z) + L * normPdf(z) - y)).toBeLessThan(1e-9);
      expect(P * x + (1 - P) * y).toBeCloseTo(L * normPdf(normInv(P)), 9);
    }
  });

  it("depth is proportional to liquidity and symmetric around one half", () => {
    expect(pmAmmShares(0.4, 0.5, 200)).toBeCloseTo(2 * pmAmmShares(0.4, 0.5, 100), 12);
    expect(pmAmmShares(0.4, 0.5, 100)).toBeCloseTo(pmAmmShares(0.5, 0.6, 100), 12);
    expect(() => pmAmmShares(0.4, 0.5, -1)).toThrow(RangeError);
  });

  it("the ladder range narrows with √(τ/T) but never below the concentration floor", () => {
    expect(rangeTicks(900, 900, 8, 2)).toBe(8);
    expect(rangeTicks(225, 900, 8, 2)).toBeCloseTo(4, 12);
    expect(rangeTicks(1, 900, 8, 2)).toBe(2);
    fc.assert(
      fc.property(fc.double({ min: 0, max: 900, noNaN: true }), (tau) => {
        expect(rangeTicks(tau, 900, 8, 3)).toBeGreaterThanOrEqual(3);
      }),
    );
  });
});
