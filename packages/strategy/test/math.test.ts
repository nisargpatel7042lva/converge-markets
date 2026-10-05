import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { clamp, normCdf, normInv, normPdf } from "../src";

describe("normCdf", () => {
  // Reference values from Python's math.erfc (double precision).
  const ref: [number, number][] = [
    [-8, 6.220960574271819e-16],
    [-5, 2.866515718791946e-7],
    [-3, 0.0013498980316300957],
    [-1, 0.15865525393145707],
    [0, 0.5],
    [0.5, 0.6914624612740131],
    [1, 0.8413447460685429],
    [1.96, 0.9750021048517795],
    [3, 0.9986501019683699],
    [8, 0.9999999999999993],
  ];
  it("matches double-precision references in both tails and the centre", () => {
    for (const [x, v] of ref) {
      expect(Math.abs(normCdf(x) - v)).toBeLessThanOrEqual(Math.max(1e-15, 1e-8 * v));
    }
  });
  it("handles extremes and NaN", () => {
    expect(normCdf(40)).toBe(1);
    expect(normCdf(-40)).toBe(0);
    expect(normCdf(Infinity)).toBe(1);
    expect(normCdf(-Infinity)).toBe(0);
    expect(normCdf(NaN)).toBeNaN();
  });
  it("is symmetric and monotone", () => {
    fc.assert(
      fc.property(fc.double({ min: -10, max: 10, noNaN: true }), (x) => {
        expect(Math.abs(normCdf(x) + normCdf(-x) - 1)).toBeLessThan(1e-15);
      }),
    );
    fc.assert(
      fc.property(
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.double({ min: 1e-9, max: 5, noNaN: true }),
        (x, d) => {
          expect(normCdf(x + d)).toBeGreaterThanOrEqual(normCdf(x));
        },
      ),
    );
  });
});

describe("normPdf", () => {
  it("peaks at 1/√(2π) and is symmetric", () => {
    expect(normPdf(0)).toBeCloseTo(0.3989422804014327, 15);
    expect(normPdf(1.3)).toBeCloseTo(normPdf(-1.3), 15);
  });
});

describe("normInv", () => {
  it("inverts normCdf across the unit interval, including tails", () => {
    fc.assert(
      fc.property(fc.double({ min: 1e-12, max: 1 - 1e-12, noNaN: true }), (p) => {
        const back = normCdf(normInv(p));
        const scale = Math.min(p, 1 - p);
        expect(Math.abs(back - p)).toBeLessThanOrEqual(Math.max(1e-15, 1e-7 * scale));
      }),
      { numRuns: 500 },
    );
  });
  it("hits known quantiles", () => {
    expect(normInv(0.5)).toBeCloseTo(0, 14);
    expect(normInv(0.975)).toBeCloseTo(1.959963984540054, 12);
    expect(normInv(0.001)).toBeCloseTo(-3.090232306167813, 11);
    expect(normInv(0.999)).toBeCloseTo(3.090232306167813, 11);
  });
  it("is defined at the ends and NaN outside", () => {
    expect(normInv(0)).toBe(-Infinity);
    expect(normInv(1)).toBe(Infinity);
    expect(normInv(-0.1)).toBeNaN();
    expect(normInv(1.1)).toBeNaN();
    expect(normInv(NaN)).toBeNaN();
  });
});

describe("clamp", () => {
  it("clamps both sides", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});
