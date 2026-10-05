import type { EwmaVolConfig } from "./vol";

/**
 * Every tunable of the quoting strategy. Units: prices and spreads are probabilities (0..1),
 * `*Sec` seconds, `*Bps` basis points of price, `*Fraction` fractions of NAV.
 */
export type StrategyParams = {
  // ---- spread ----
  /** Floor on the half-spread. */
  minHalfSpread: number;
  /** Ceiling on the half-spread (a wider quote is not worth posting). */
  maxHalfSpread: number;
  /** Multiple of the staleness-risk term φ(d2)·√(stalenessSec/τ) added to the half-spread. */
  volSpreadK: number;
  /** How stale the vault assumes its posted quote can be when it is hit. */
  stalenessSec: number;

  // ---- inventory ----
  /** Max shift of the quote centre against inventory (price units). */
  inventorySkewMax: number;
  /** tanh steepness: inventory (as a fraction of the per-market cap) at which skew is ~76% of max. */
  inventorySkewK: number;

  // ---- toxicity guard ----
  /** Pull all quotes when the price range over `toxicityWindowSec` is at least this many bps. */
  toxicityPullBps: number;
  toxicityWindowSec: number;
  /** Extra half-spread added just below the pull threshold (ramps linearly from half of it). */
  toxicityWidenMax: number;

  // ---- windows, bounds, tick ----
  /** No quotes in the final N seconds of a round. */
  noQuoteWindowSec: number;
  priceMin: number;
  priceMax: number;
  tick: number;

  // ---- ladder and pm-AMM liquidity ----
  /** Price levels per side (>= 1). */
  levels: number;
  /** Ladder span in ticks at round start; narrows with √(τ/T). */
  baseRangeTicks: number;
  /** Concentration floor: the ladder never narrows below this many ticks. */
  minRangeTicks: number;
  /** pm-AMM L (shares per unit of Φ⁻¹) as a fraction of NAV. */
  liquidityNavFraction: number;
  /** Levels smaller than this many shares are dropped. */
  minLevelSize: number;

  // ---- risk ----
  perMarketMaxFraction: number;
  totalAtRiskMaxFraction: number;
  drawdownBreakerFraction: number;

  // ---- volatility estimator ----
  vol: EwmaVolConfig;

  // ---- keeper posting rule ----
  /** Re-post when the best quote moves by at least this many ticks. */
  refreshTicks: number;
  /** ...or when the posted quote is this many blocks old. */
  maxQuoteAgeBlocks: number;
};

/**
 * Conservative defaults from CLAUDE.md; the Phase 3 backtest chooses the launch values
 * (config/strategy.default.json).
 */
export const DEFAULT_PARAMS: StrategyParams = {
  minHalfSpread: 0.02,
  maxHalfSpread: 0.2,
  volSpreadK: 1,
  stalenessSec: 1.5,
  inventorySkewMax: 0.03,
  inventorySkewK: 2,
  toxicityPullBps: 12,
  toxicityWindowSec: 5,
  toxicityWidenMax: 0.03,
  noQuoteWindowSec: 60,
  priceMin: 0.02,
  priceMax: 0.98,
  tick: 0.01,
  levels: 3,
  baseRangeTicks: 6,
  minRangeTicks: 2,
  liquidityNavFraction: 0.5,
  minLevelSize: 1,
  perMarketMaxFraction: 0.05,
  totalAtRiskMaxFraction: 0.4,
  drawdownBreakerFraction: 0.05,
  vol: { halfLifeSec: 1800, priorAnnualVol: 0.5, minAnnualVol: 0.1, maxAnnualVol: 3 },
  refreshTicks: 1,
  maxQuoteAgeBlocks: 25,
};

export class ParamError extends Error {}

/** Validates a parameter set; throws `ParamError` naming the first violated rule. */
export function validateParams(p: StrategyParams): StrategyParams {
  const bad = (m: string): never => {
    throw new ParamError(m);
  };
  const pos = (v: number, n: string) => {
    if (!(Number.isFinite(v) && v > 0)) bad(`${n} must be > 0`);
  };
  const nonneg = (v: number, n: string) => {
    if (!(Number.isFinite(v) && v >= 0)) bad(`${n} must be >= 0`);
  };
  pos(p.tick, "tick");
  pos(p.minHalfSpread, "minHalfSpread");
  if (!(p.maxHalfSpread >= p.minHalfSpread)) bad("maxHalfSpread must be >= minHalfSpread");
  nonneg(p.volSpreadK, "volSpreadK");
  pos(p.stalenessSec, "stalenessSec");
  nonneg(p.inventorySkewMax, "inventorySkewMax");
  nonneg(p.inventorySkewK, "inventorySkewK");
  pos(p.toxicityPullBps, "toxicityPullBps");
  pos(p.toxicityWindowSec, "toxicityWindowSec");
  nonneg(p.toxicityWidenMax, "toxicityWidenMax");
  nonneg(p.noQuoteWindowSec, "noQuoteWindowSec");
  if (!(p.priceMin > 0 && p.priceMax < 1 && p.priceMin < p.priceMax))
    bad("need 0 < priceMin < priceMax < 1");
  if (!(Number.isInteger(p.levels) && p.levels >= 1)) bad("levels must be an integer >= 1");
  nonneg(p.baseRangeTicks, "baseRangeTicks");
  nonneg(p.minRangeTicks, "minRangeTicks");
  pos(p.liquidityNavFraction, "liquidityNavFraction");
  nonneg(p.minLevelSize, "minLevelSize");
  if (!(p.perMarketMaxFraction > 0 && p.perMarketMaxFraction <= 1))
    bad("perMarketMaxFraction in (0,1]");
  if (!(p.totalAtRiskMaxFraction >= p.perMarketMaxFraction && p.totalAtRiskMaxFraction <= 1))
    bad("totalAtRiskMaxFraction must be in [perMarketMaxFraction, 1]");
  if (!(p.drawdownBreakerFraction > 0 && p.drawdownBreakerFraction < 1))
    bad("drawdownBreakerFraction in (0,1)");
  pos(p.vol.halfLifeSec, "vol.halfLifeSec");
  pos(p.vol.priorAnnualVol, "vol.priorAnnualVol");
  if (!(p.vol.minAnnualVol > 0 && p.vol.maxAnnualVol >= p.vol.minAnnualVol))
    bad("vol clamp invalid");
  nonneg(p.refreshTicks, "refreshTicks");
  if (!(Number.isInteger(p.maxQuoteAgeBlocks) && p.maxQuoteAgeBlocks >= 1))
    bad("maxQuoteAgeBlocks must be an integer >= 1");
  return p;
}
