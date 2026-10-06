import type { OnchainParams } from "@converge/strategy";

/** config/strategy.default.json (the launch parameters). */
export const DEFAULT_PARAMS_ONCHAIN: OnchainParams = {
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
  minLevelSize: 1e-18,
  perMarketMaxFraction: 0.01,
  totalAtRiskMaxFraction: 0.08,
};
