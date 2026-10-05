import { describe, expect, it } from "vitest";
import { annualizationFactor, EwmaVol, RollingRange, SECONDS_PER_YEAR } from "../src";
import { gauss, rng } from "./helpers";

const cfg = { halfLifeSec: 600, priorAnnualVol: 0.5, minAnnualVol: 0.05, maxAnnualVol: 5 };

/** GBM path at 1 s resolution with annual vol `sigma`. */
function path(sigma: number, seconds: number, seed: number): number[] {
  const r = rng(seed);
  const out = [100];
  const sd = sigma / Math.sqrt(SECONDS_PER_YEAR);
  for (let i = 0; i < seconds; i++) out.push(out[i]! * Math.exp(sd * gauss(r)));
  return out;
}

describe("annualization", () => {
  it("scales a sample σ by √(year/sample)", () => {
    expect(annualizationFactor(1)).toBeCloseTo(Math.sqrt(SECONDS_PER_YEAR), 9);
    expect(annualizationFactor(60)).toBeCloseTo(Math.sqrt(SECONDS_PER_YEAR / 60), 9);
    expect(() => annualizationFactor(0)).toThrow(RangeError);
    expect(() => annualizationFactor(NaN)).toThrow(RangeError);
  });
});

describe("EwmaVol", () => {
  it("recovers the true annualized σ from 1 s samples", () => {
    const v = new EwmaVol(cfg);
    const p = path(0.8, 6 * 3600, 11);
    p.forEach((x, i) => v.update(x, i));
    expect(v.annualVol).toBeGreaterThan(0.8 * 0.85);
    expect(v.annualVol).toBeLessThan(0.8 * 1.15);
  });

  it("gives the same answer when the same path is sampled every 60 s (annualization is right)", () => {
    const p = path(0.8, 24 * 3600, 5);
    const a = new EwmaVol({ ...cfg, halfLifeSec: 4 * 3600 });
    const b = new EwmaVol({ ...cfg, halfLifeSec: 4 * 3600 });
    p.forEach((x, i) => a.update(x, i));
    p.forEach((x, i) => {
      if (i % 60 === 0) b.update(x, i);
    });
    expect(Math.abs(a.annualVol - b.annualVol) / a.annualVol).toBeLessThan(0.12);
    expect(b.annualVol).toBeGreaterThan(0.8 * 0.8);
    expect(b.annualVol).toBeLessThan(0.8 * 1.2);
  });

  it("forgets with the configured half-life", () => {
    const quiet = new EwmaVol({ ...cfg, priorAnnualVol: 2, minAnnualVol: 1e-6 });
    // Flat prices: every return is 0, so variance decays by 2^(-dt/halfLife).
    quiet.update(100, 0);
    const v0 = quiet.annualVol;
    quiet.update(100, 600);
    expect(quiet.annualVol).toBeCloseTo(v0 / Math.SQRT2, 9);
    quiet.update(100, 1200);
    expect(quiet.annualVol).toBeCloseTo(v0 / 2, 9);
  });

  it("clamps, ignores bad or non-advancing data, and keeps the prior until data arrives", () => {
    const v = new EwmaVol(cfg);
    expect(v.annualVol).toBeCloseTo(0.5, 12);
    expect(v.update(100, 10)).toBeCloseTo(0.5, 12); // first price only sets the reference
    expect(v.update(100, 10)).toBeCloseTo(0.5, 12); // dt = 0 ignored
    expect(v.update(100, 5)).toBeCloseTo(0.5, 12); // time going back ignored
    expect(v.update(-1, 20)).toBeCloseTo(0.5, 12);
    expect(v.update(NaN, 20)).toBeCloseTo(0.5, 12);
    expect(v.update(100, Infinity)).toBeCloseTo(0.5, 12);
    const hi = new EwmaVol({ ...cfg, maxAnnualVol: 0.6, halfLifeSec: 1 });
    hi.update(100, 0);
    hi.update(150, 1); // a huge return
    expect(hi.annualVol).toBe(0.6);
    const lo = new EwmaVol({ ...cfg, minAnnualVol: 0.4, halfLifeSec: 1 });
    lo.update(100, 0);
    lo.update(100, 100);
    expect(lo.annualVol).toBe(0.4);
  });

  it("validates its config", () => {
    expect(() => new EwmaVol({ ...cfg, halfLifeSec: 0 })).toThrow(RangeError);
    expect(() => new EwmaVol({ ...cfg, minAnnualVol: 0 })).toThrow(RangeError);
    expect(() => new EwmaVol({ ...cfg, maxAnnualVol: 0.01 })).toThrow(RangeError);
    expect(() => new EwmaVol({ ...cfg, priorAnnualVol: 0 })).toThrow(RangeError);
  });
});

describe("RollingRange", () => {
  it("reports the largest log excursion inside the window, in bps", () => {
    const w = new RollingRange(5);
    expect(w.rangeBps).toBe(0);
    w.push(100, 0);
    w.push(101, 1);
    w.push(100.5, 2);
    expect(w.rangeBps).toBeCloseTo(Math.log(101 / 100) * 1e4, 9);
  });

  it("drops observations older than the window", () => {
    const w = new RollingRange(5);
    w.push(100, 0);
    w.push(102, 1);
    w.push(101, 7); // t=0 and t=1 are out of the window: only 101 remains
    expect(w.rangeBps).toBe(0);
    w.push(100, 8);
    expect(w.rangeBps).toBeCloseTo(Math.log(101 / 100) * 1e4, 9);
  });

  it("ignores invalid input and survives many pushes (queue compaction)", () => {
    const w = new RollingRange(2);
    w.push(NaN, 0);
    w.push(-3, 0);
    w.push(100, Infinity);
    expect(w.rangeBps).toBe(0);
    for (let i = 0; i < 5000; i++) w.push(100 + (i % 2), i);
    expect(w.rangeBps).toBeCloseTo(Math.log(101 / 100) * 1e4, 9);
    expect(() => new RollingRange(0)).toThrow(RangeError);
  });

  it("compacts both queues on long monotone runs and stays exact", () => {
    const w = new RollingRange(2);
    let price = 100;
    for (let t = 0; t < 3000; t++) {
      price *= 1.0001; // strictly rising: the min-queue grows, the max-queue stays short
      w.push(price, t);
    }
    expect(w.rangeBps).toBeCloseTo(Math.log(1.0001 ** 2) * 1e4, 6);
    for (let t = 3000; t < 6000; t++) {
      price /= 1.0001; // strictly falling: the max-queue grows
      w.push(price, t);
    }
    expect(w.rangeBps).toBeCloseTo(Math.log(1.0001 ** 2) * 1e4, 6);
  });

  it("matches a brute-force range on random data", () => {
    const r = rng(3);
    const w = new RollingRange(10);
    const hist: [number, number][] = [];
    let price = 100;
    for (let t = 0; t < 400; t += 1) {
      price *= Math.exp(0.001 * gauss(r));
      w.push(price, t);
      hist.push([t, price]);
      const win = hist.filter(([ts]) => ts >= t - 10).map(([, p]) => Math.log(p));
      const expected = (Math.max(...win) - Math.min(...win)) * 1e4;
      expect(w.rangeBps).toBeCloseTo(expected, 8);
    }
  });
});
