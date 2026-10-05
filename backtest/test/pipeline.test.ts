import { describe, expect, it } from "vitest";
import { classifyWindow, summarizeDays } from "../src/pipeline/stages";
import { Rng } from "../src/rng";
import type { DailyRow } from "../src/types";

const day = (i: number, over: Partial<DailyRow> = {}): DailyRow => ({
  day: `2026-08-${String(i + 1).padStart(2, "0")}`,
  pnl: 10,
  gasUsd: 1,
  edgeNoise: 11,
  edgeInformed: 0,
  residual: 0,
  rounds: 10,
  breakerTripped: false,
  feeIncome: 0,
  redeemFees: 0,
  noiseVolumeUsd: 100,
  informedVolumeUsd: 0,
  ...over,
});
const rows = (n: number, over: Partial<DailyRow> = {}) =>
  Array.from({ length: n }, (_, i) => day(i, over));

describe("summarizeDays", () => {
  it("sums, annualizes and counts trips", () => {
    const s = summarizeDays(
      rows(20, { breakerTripped: false }).map((d, i) =>
        i === 3 ? { ...d, breakerTripped: true } : d,
      ),
    );
    expect(s.days).toBe(20);
    expect(s.netPnl).toBe(200);
    expect(s.expectedNetEdge).toBeCloseTo(200, 9); // 11 spread − 1 gas per day
    expect(s.expectedPerDay).toBeCloseTo(10, 9);
    expect(s.expectedApyPct).toBeCloseTo((10 * 365 * 100) / 5000, 9);
    expect(s.breakerTripDays).toBe(1);
    expect(s.profitableDaysPct).toBe(100);
  });

  it("counts informed losses in full but never counts informed gains as income", () => {
    const losing = summarizeDays(rows(10, { edgeInformed: -4 }));
    expect(losing.expectedPerDay).toBeCloseTo(10 - 4, 9);
    const winning = summarizeDays(rows(10, { edgeInformed: +4 }));
    expect(winning.expectedPerDay).toBeCloseTo(10, 9); // gains excluded
    expect(winning.edgeInformed).toBe(40); // but still reported raw
  });

  it("includes LP fee income and redeem fees", () => {
    const s = summarizeDays(rows(10, { feeIncome: 2, redeemFees: 0.5 }));
    expect(s.expectedPerDay).toBeCloseTo(10 + 2 - 0.5, 9);
  });

  it("is deterministic and its CI brackets the mean", () => {
    const rnd = new Rng(8);
    const d = rows(30).map((r) => ({ ...r, pnl: 10 + 12 * rnd.normal() }));
    const a = summarizeDays(d, 5000, 3);
    expect(summarizeDays(d, 5000, 3)).toEqual(a);
    expect(a.meanDailyCi95[0]).toBeLessThan(a.meanDaily);
    expect(a.meanDailyCi95[1]).toBeGreaterThan(a.meanDaily);
    expect(a.totalCi95[0]).toBeCloseTo(a.meanDailyCi95[0] * 30, 9);
  });

  it("clamps informed gains per day, not over the window", () => {
    // Alternating days: the vault loses 6 to informed flow on even days and wins 6 on odd days.
    const d = rows(10).map((r, i) => ({ ...r, edgeInformed: i % 2 === 0 ? -6 : 6 }));
    const s = summarizeDays(d);
    expect(s.expectedPerDay).toBeCloseTo(10 - 3, 9); // losses (−6) counted on half the days only
    expect(s.expectedPerDayCi95[0]).toBeLessThanOrEqual(s.expectedPerDay);
    expect(s.expectedPerDayCi95[1]).toBeGreaterThanOrEqual(s.expectedPerDay);
  });

  it("reports the outcome residual's mean and t-statistic", () => {
    const calibrated = summarizeDays(
      rows(40).map((r, i) => ({ ...r, residual: i % 2 === 0 ? 20 : -20 })),
    );
    expect(Math.abs(calibrated.residualT)).toBeLessThan(0.2);
    const biased = summarizeDays(
      rows(40).map((r, i) => ({ ...r, residual: -15 + (i % 2 === 0 ? 3 : -3) })),
    );
    expect(biased.residualT).toBeLessThan(-10);
    expect(biased.residualPerDay).toBeCloseTo(-15, 9);
  });

  it("measures drawdown of the cumulative daily P&L as a share of NAV", () => {
    const d = [day(0, { pnl: 100 }), day(1, { pnl: -300 }), day(2, { pnl: 50 })];
    expect(summarizeDays(d, 5000).maxDrawdownDailyPct).toBeCloseTo((300 / 5000) * 100, 9);
  });
});

describe("classifyWindow (the verdict rule)", () => {
  it("UNPROFITABLE when the expected edge is not positive, whatever the luck", () => {
    const s = summarizeDays(rows(30, { pnl: 50, edgeNoise: 1, gasUsd: 5 })); // luck up, edge negative
    expect(s.expectedPerDay).toBeLessThan(0);
    expect(s.netPnl).toBeGreaterThan(0);
    expect(classifyWindow(s)).toBe("UNPROFITABLE");
  });
  it("MARGINAL when the edge is positive but the realized CI includes losses", () => {
    const d = rows(30).map((r, i) => ({ ...r, pnl: i % 2 === 0 ? 300 : -290 }));
    const s = summarizeDays(d);
    expect(s.expectedPerDay).toBeGreaterThan(0);
    expect(s.meanDailyCi95[0]).toBeLessThan(0);
    expect(classifyWindow(s)).toBe("MARGINAL");
  });
  it("PROFITABLE needs BOTH the expected-edge CI and the realized (ex informed gains) CI above zero", () => {
    expect(classifyWindow(summarizeDays(rows(30)))).toBe("PROFITABLE");
    // Realized P&L is only positive because of informed gains, which are not counted.
    const donated = summarizeDays(rows(30, { pnl: 40, edgeInformed: 35, edgeNoise: 11 }));
    expect(donated.expectedPerDay).toBeGreaterThan(0);
    expect(donated.meanDailyCi95[0]).toBeLessThan(donated.meanDaily);
    const rnd = new Rng(9);
    const noisy = summarizeDays(
      rows(30).map((r) => ({ ...r, edgeNoise: 12 + 80 * rnd.normal(), pnl: 10 })),
    );
    expect(noisy.expectedPerDayCi95[0]).toBeLessThan(0);
    expect(classifyWindow(noisy)).toBe("MARGINAL");
  });
});
