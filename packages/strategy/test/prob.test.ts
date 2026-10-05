import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  d2,
  fairProbUp,
  normCdf,
  PROB_MAX,
  PROB_MIN,
  probVolPerRootSec,
  SECONDS_PER_YEAR,
} from "../src";
import { gauss, rng } from "./helpers";

const YEAR = SECONDS_PER_YEAR;

describe("fairProbUp", () => {
  it("at the money equals Φ(−½σ√τ) (drift correction), a bit under one half", () => {
    const sigma = 0.5;
    const tau = 900 / YEAR;
    const expected = normCdf(-0.5 * sigma * Math.sqrt(tau));
    expect(fairProbUp(100, 100, sigma, tau)).toBeCloseTo(expected, 14);
    expect(expected).toBeLessThan(0.5);
  });

  it("agrees with a Monte Carlo of the driftless log-normal price (UP iff S_T >= K)", () => {
    const r = rng(7);
    const sigma = 0.6;
    const tau = 3600 / YEAR;
    for (const m of [-0.004, 0, 0.003]) {
      const spot = 100 * Math.exp(m);
      let up = 0;
      const n = 200_000;
      for (let i = 0; i < n; i++) {
        const sT = spot * Math.exp(-0.5 * sigma * sigma * tau + sigma * Math.sqrt(tau) * gauss(r));
        if (sT >= 100) up++;
      }
      expect(Math.abs(up / n - fairProbUp(spot, 100, sigma, tau))).toBeLessThan(0.004);
    }
  });

  it("resolves deterministically at expiry (ties go UP) and is clamped away from 0 and 1", () => {
    expect(fairProbUp(100, 100, 0.5, 0)).toBe(PROB_MAX);
    expect(fairProbUp(100.0001, 100, 0.5, 0)).toBe(PROB_MAX);
    expect(fairProbUp(99.9999, 100, 0.5, 0)).toBe(PROB_MIN);
    expect(fairProbUp(100, 100, 0, 1 / YEAR)).toBe(PROB_MAX);
    expect(fairProbUp(1e6, 1, 0.2, 1e-9)).toBe(PROB_MAX);
    expect(fairProbUp(1, 1e6, 0.2, 1e-9)).toBe(PROB_MIN);
  });

  it("is stable at tiny τ and extreme moneyness (finite, in [1e-6, 1-1e-6])", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e-3, max: 1e7, noNaN: true }),
        fc.double({ min: 1e-3, max: 1e7, noNaN: true }),
        fc.double({ min: 0, max: 20, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (s, k, sigma, tau) => {
          const p = fairProbUp(s, k, sigma, tau);
          expect(Number.isFinite(p)).toBe(true);
          expect(p).toBeGreaterThanOrEqual(PROB_MIN);
          expect(p).toBeLessThanOrEqual(PROB_MAX);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("is non-decreasing in spot", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 50, max: 150, noNaN: true }),
        fc.double({ min: 1e-6, max: 50, noNaN: true }),
        fc.double({ min: 0.05, max: 3, noNaN: true }),
        fc.double({ min: 1 / YEAR, max: 7200 / YEAR, noNaN: true }),
        (s, ds, sigma, tau) => {
          expect(fairProbUp(s + ds, 100, sigma, tau)).toBeGreaterThanOrEqual(
            fairProbUp(s, 100, sigma, tau),
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it("when in the money, the probability falls as time to expiry grows (and at the money too)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 0.05, noNaN: true }),
        fc.double({ min: 0.05, max: 3, noNaN: true }),
        fc.double({ min: 1 / YEAR, max: 3600 / YEAR, noNaN: true }),
        fc.double({ min: 1e-6, max: 3600 / YEAR, noNaN: true }),
        (m, sigma, t1, dt) => {
          const spot = 100 * Math.exp(m);
          expect(fairProbUp(spot, 100, sigma, t1 + dt)).toBeLessThanOrEqual(
            fairProbUp(spot, 100, sigma, t1) + 1e-12,
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it("rejects invalid inputs", () => {
    expect(() => fairProbUp(0, 100, 0.5, 0.1)).toThrow(RangeError);
    expect(() => fairProbUp(100, -1, 0.5, 0.1)).toThrow(RangeError);
    expect(() => fairProbUp(100, 100, -0.5, 0.1)).toThrow(RangeError);
    expect(() => fairProbUp(100, 100, NaN, 0.1)).toThrow(RangeError);
    expect(() => fairProbUp(100, 100, 0.5, -1)).toThrow(RangeError);
    expect(() => fairProbUp(Infinity, 100, 0.5, 0.1)).toThrow(RangeError);
  });
});

describe("d2 and probability volatility", () => {
  it("d2 is ±∞ when σ√τ is degenerate", () => {
    expect(d2({ spot: 101, strike: 100, sigma: 0, tauYears: 1 })).toBe(Infinity);
    expect(d2({ spot: 100, strike: 100, sigma: 0.5, tauYears: 0 })).toBe(Infinity);
    expect(d2({ spot: 99, strike: 100, sigma: 0.5, tauYears: 0 })).toBe(-Infinity);
  });

  it("φ(d2)/√τ is the per-√s volatility of the probability: matches a finite difference", () => {
    const sigma = 0.5;
    const tauSec = 600;
    const tau = tauSec / YEAR;
    const inputs = { spot: 100, strike: 100, sigma, tauYears: tau };
    const v = probVolPerRootSec(inputs);
    // One-second move of ln S with std σ√(1s): the probability moves by dp/dlnS · σ√dt.
    const eps = 1e-6;
    const dpdlns =
      (fairProbUp(100 * Math.exp(eps), 100, sigma, tau) -
        fairProbUp(100 * Math.exp(-eps), 100, sigma, tau)) /
      (2 * eps);
    expect(v).toBeCloseTo(dpdlns * sigma * Math.sqrt(1 / YEAR), 4);
  });

  it("is zero when the outcome is decided or time is up", () => {
    expect(probVolPerRootSec({ spot: 200, strike: 100, sigma: 0.5, tauYears: 1e-12 })).toBe(0);
    expect(probVolPerRootSec({ spot: 100, strike: 100, sigma: 0.5, tauYears: 0 })).toBe(0);
  });
});
