/**
 * Parameter search. The strategy is tuned on the TRAIN window only (the first 60 evaluation days);
 * the last 30 days are never seen by the search and are used to report out-of-sample results.
 */
import { DEFAULT_PARAMS, validateParams, type StrategyParams } from "@converge/strategy";
import { Rng } from "./rng";
import type { RunResult } from "./types";

export const TRAIN = { start: "2026-07-06", end: "2026-09-04" } as const; // 60 days
export const HOLDOUT = { start: "2026-09-04", end: "2026-10-04" } as const; // 30 days

/** The search space: each parameter takes one of these values. */
export const SPACE = {
  minHalfSpread: [0.01, 0.015, 0.02, 0.03, 0.04, 0.05, 0.07, 0.1],
  volSpreadK: [0.5, 1, 1.5, 2, 3],
  stalenessSec: [1.5, 2.5, 4],
  inventorySkewMax: [0.01, 0.03, 0.06, 0.1],
  inventorySkewK: [1, 2, 4],
  toxicityPullBps: [8, 12, 20, 40],
  toxicityWidenMax: [0, 0.03, 0.06],
  noQuoteWindowSec: [30, 60, 120, 240, 360, 600],
  levels: [2, 3, 4],
  baseRangeTicks: [4, 8, 14],
  liquidityNavFraction: [0.03, 0.06, 0.12, 0.25, 0.5],
  perMarketMaxFraction: [0.01, 0.02, 0.035, 0.05],
  refreshTicks: [1, 2, 3, 5],
  maxQuoteAgeBlocks: [25, 75, 200],
} as const;

type SpaceKey = keyof typeof SPACE;

/** `volScale` is fixed from calibration on the training window, not searched. */
export function sampleParams(rng: Rng, volScale = 1): StrategyParams {
  const pick = <K extends SpaceKey>(k: K): (typeof SPACE)[K][number] => {
    const arr = SPACE[k] as readonly (typeof SPACE)[K][number][];
    return arr[rng.int(arr.length)]!;
  };
  const minHalfSpread = pick("minHalfSpread");
  const p: StrategyParams = {
    ...DEFAULT_PARAMS,
    minHalfSpread,
    maxHalfSpread: Math.max(0.2, minHalfSpread),
    volSpreadK: pick("volSpreadK"),
    stalenessSec: pick("stalenessSec"),
    inventorySkewMax: pick("inventorySkewMax"),
    inventorySkewK: pick("inventorySkewK"),
    toxicityPullBps: pick("toxicityPullBps"),
    toxicityWidenMax: pick("toxicityWidenMax"),
    noQuoteWindowSec: pick("noQuoteWindowSec"),
    levels: pick("levels"),
    baseRangeTicks: pick("baseRangeTicks"),
    liquidityNavFraction: pick("liquidityNavFraction"),
    perMarketMaxFraction: pick("perMarketMaxFraction"),
    refreshTicks: pick("refreshTicks"),
    maxQuoteAgeBlocks: pick("maxQuoteAgeBlocks"),
    vol: { ...DEFAULT_PARAMS.vol, scale: volScale },
  };
  // Keep the total at-risk limit at 8x the per-market limit (CLAUDE.md: 40% vs 5%), at most 40%.
  p.totalAtRiskMaxFraction = Math.min(0.4, 8 * p.perMarketMaxFraction);
  return validateParams(p);
}

/** Neighbour of `base`: re-draws a few parameters (used to refine the best candidates). */
export function mutate(base: StrategyParams, rng: Rng, count = 2): StrategyParams {
  const fresh = sampleParams(rng);
  const keys = Object.keys(SPACE) as SpaceKey[];
  const p = { ...base };
  for (let i = 0; i < count; i++) {
    const k = keys[rng.int(keys.length)]!;
    (p as Record<string, unknown>)[k] = fresh[k as keyof StrategyParams];
  }
  p.maxHalfSpread = Math.max(0.2, p.minHalfSpread);
  p.totalAtRiskMaxFraction = Math.min(0.4, 8 * p.perMarketMaxFraction);
  return validateParams(p);
}

export type Score = {
  /**
   * Expected net edge per day: spread capture + adverse selection (losses only) + fees − gas −
   * redeem fees. Zero-mean outcome luck is excluded.
   */
  expectedPerDay: number;
  stdDaily: number;
  tripFraction: number;
  maxDrawdownPct: number;
  /** expectedPerDay − 0.5·stdDaily, with hard penalties for breaker trips and deep drawdowns. */
  score: number;
};

/** Risk-adjusted objective. Expected edge excludes the zero-mean outcome residual. */
export function scoreRun(r: RunResult, nav0: number): Score {
  const days = Math.max(1, r.days);
  // Informed traders that lose money are not counted as income: a rational one would stop trading.
  const expectedPerDay =
    (r.pnl.edgeNoise +
      r.pnl.edgeInformedCounted +
      r.pnl.feeIncome -
      r.pnl.gasUsd -
      r.pnl.redeemFees) /
    days;
  const tripFraction = r.risk.breakerTripDays / days;
  const penalty =
    0.1 * nav0 * tripFraction +
    (r.risk.maxDrawdownPct > 12 ? (r.risk.maxDrawdownPct - 12) * 0.01 * nav0 : 0);
  return {
    expectedPerDay,
    stdDaily: r.returns.stdDailyPnl,
    tripFraction,
    maxDrawdownPct: r.risk.maxDrawdownPct,
    score: expectedPerDay - 0.5 * r.returns.stdDailyPnl - penalty,
  };
}
