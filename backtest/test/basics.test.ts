import { describe, expect, it } from "vitest";
import { addDays, days, epochSec, parseKlines, buildSeries, SOURCES } from "../src/data/binance";
import { indexAtOrBefore, priceAtMs, seriesEndMs } from "../src/data/series";
import { unzipFirst } from "../src/data/zip";
import {
  blockBootstrapCi,
  bootstrapCi,
  maxDrawdown,
  mean,
  quantile,
  sharpeDaily,
  std,
} from "../src/metrics";
import { hashSeed, Rng } from "../src/rng";
import { makeZip } from "./helpers";

describe("rng", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const a = new Rng(1);
    const b = new Rng(1);
    const c = new Rng(2);
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(xs);
    expect(hashSeed("a", 1, 2)).toBe(hashSeed("a", 1, 2));
    expect(hashSeed("a", 1, 2)).not.toBe(hashSeed("a", 1, 3));
  });
  it("has the right moments", () => {
    const r = new Rng(9);
    const n = 200_000;
    let e = 0;
    let z = 0;
    let z2 = 0;
    const ln: number[] = [];
    for (let i = 0; i < n; i++) {
      e += r.exp(5);
      const g = r.normal();
      z += g;
      z2 += g * g;
      ln.push(r.lognormal(25, 1));
    }
    expect(e / n).toBeGreaterThan(4.9);
    expect(e / n).toBeLessThan(5.1);
    expect(Math.abs(z / n)).toBeLessThan(0.01);
    expect(z2 / n).toBeGreaterThan(0.98);
    expect(z2 / n).toBeLessThan(1.02);
    expect(quantile(ln, 0.5)).toBeGreaterThan(24.5);
    expect(quantile(ln, 0.5)).toBeLessThan(25.5);
    expect(new Rng(3).int(10)).toBeLessThan(10);
  });
});

describe("metrics", () => {
  it("computes moments, quantiles, drawdown and Sharpe", () => {
    expect(mean([])).toBe(0);
    expect(std([1])).toBe(0);
    expect(mean([1, 2, 3])).toBe(2);
    expect(std([1, 2, 3])).toBe(1);
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([5, 1, 3], 0)).toBe(1);
    expect(maxDrawdown([100, 120, 90, 130, 100])).toEqual({ abs: 30, frac: 0.25 });
    expect(maxDrawdown([])).toEqual({ abs: 0, frac: 0 });
    expect(sharpeDaily([1, 1, 1])).toBe(0);
    expect(sharpeDaily([1, 2, 3])).toBeCloseTo((2 / 1) * Math.sqrt(365), 9);
  });
  it("bootstrap is deterministic and brackets the mean", () => {
    const xs = Array.from({ length: 60 }, (_, i) => (i % 7) - 2);
    const a = bootstrapCi(xs, mean, 5);
    expect(bootstrapCi(xs, mean, 5)).toEqual(a);
    expect(a[0]).toBeLessThan(mean(xs));
    expect(a[1]).toBeGreaterThan(mean(xs));
    expect(bootstrapCi([], mean, 1)).toEqual([0, 0]);
  });
});

describe("moving-block bootstrap", () => {
  it("is deterministic, brackets the mean and is wider than the iid bootstrap on autocorrelated data", () => {
    // A slowly varying series: neighbouring days resemble each other.
    const xs = Array.from({ length: 120 }, (_, i) => 10 * Math.sin(i / 8) + (i % 3));
    const a = blockBootstrapCi(xs, mean, 5, 10);
    expect(blockBootstrapCi(xs, mean, 5, 10)).toEqual(a);
    expect(a[0]).toBeLessThan(mean(xs));
    expect(a[1]).toBeGreaterThan(mean(xs));
    const iid = bootstrapCi(xs, mean, 5);
    expect(a[1] - a[0]).toBeGreaterThan(iid[1] - iid[0]);
  });
  it("handles blocks longer than the series and an empty series", () => {
    expect(blockBootstrapCi([1, 2, 3], mean, 1, 50)).toEqual([2, 2]);
    expect(blockBootstrapCi([], mean, 1)).toEqual([0, 0]);
  });
});

describe("series", () => {
  const s = { label: "X", t0: 100, stepSec: 1, px: Float64Array.from([10, 20, 30, 40]) };
  it("interpolates, clamps, and indexes causally", () => {
    expect(priceAtMs(s, 100_500)).toBe(15);
    expect(priceAtMs(s, 0)).toBe(10);
    expect(priceAtMs(s, 1e9)).toBe(40);
    expect(seriesEndMs(s)).toBe(103_000);
    expect(indexAtOrBefore(s, 101.9)).toBe(1); // sample-and-hold: the last bar at or before t
    expect(indexAtOrBefore(s, 102)).toBe(2);
    expect(indexAtOrBefore(s, 500)).toBe(3);
  });
});

describe("zip and klines", () => {
  it("round-trips a deflated archive", () => {
    const z = makeZip("x.csv", "hello\nworld\n");
    expect(unzipFirst(z)).toEqual({ name: "x.csv", data: Buffer.from("hello\nworld\n") });
    expect(() => unzipFirst(Buffer.alloc(40))).toThrow("end of central directory");
  });
  it("parses ms and µs open times", () => {
    const rows = parseKlines(
      "1767225600000000,1.0,2,0.5,1.5,9,x,y\n1767225601000000,1.5,2,0.5,1.7,9,x,y\n1700000000000,3,4,2,3.5,1\n\n",
    );
    expect(rows.map((r) => r.openSec)).toEqual([1767225600, 1767225601, 1700000000]);
    expect(rows.map((r) => r.close)).toEqual([1.5, 1.7, 3.5]);
  });
  it("builds a causal series: a bar's close is the price at the bar's END, gaps are forward-filled", () => {
    const day = "2026-08-01";
    const t0 = epochSec(day);
    const csv = [
      `${(t0 + 0) * 1e6},100,0,0,101,0`, // bar [t0, t0+1) closes 101  -> price at t0+1
      `${(t0 + 1) * 1e6},101,0,0,102,0`, // -> price at t0+2
      `${(t0 + 4) * 1e6},105,0,0,106,0`, // gap at t0+3, t0+4 -> price at t0+5
    ].join("\n");
    const { series, stats } = buildSeries(SOURCES["BTC/USD"]!, [day], [makeZip("a.csv", csv)]);
    expect(series.px[0]).toBe(100); // first bar's open
    expect(series.px[1]).toBe(101);
    expect(series.px[2]).toBe(102);
    expect(series.px[3]).toBe(102); // forward-filled
    expect(series.px[4]).toBe(102);
    expect(series.px[5]).toBe(106);
    expect(series.px.length).toBe(86_401);
    expect(stats.missingSamples).toBeGreaterThan(0);
    expect(() => buildSeries(SOURCES["BTC/USD"]!, [day], [makeZip("a.csv", "")])).toThrow(
      "no data",
    );
  });
  it("date helpers", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(days("2026-07-30", "2026-08-02")).toEqual([
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ]);
  });
});
