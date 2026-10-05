import { DEFAULT_PARAMS, type StrategyParams } from "@converge/strategy";
import { WINDOW } from "./data/binance";
import type { FlowConfig, SimConfig, VenueConfig } from "./types";

/** Day after the last evaluation day (end is exclusive). */
export const END_EXCLUSIVE = "2026-10-04";

export const BASE_VENUE: VenueConfig = {
  blockMs: 400,
  quoteMode: "posted",
  execDelayBlocks: 0,
  execWindowBlocks: 0,
  // Conservative for the LPs: no taker fee deters informed flow, and no redeem fee is assumed.
  takerFeeBps: 0,
  feeToLp: false,
  redeemFeeBps: 0,
  // ADR-001 estimated 67-107k gas for a 6-round batched update excluding report verification and
  // onchain ln/√/Φ. 100k + 20k per updated market is about 2-3x that (ADR-001: "realistic 2-3x").
  // Forward-priced design: executing a delayed order and pricing it on chain, per filled order.
  gasPerFill: 400_000,
  gasBase: 100_000,
  gasPerMarket: 20_000,
  gasPriceGwei: 102,
  monUsd: 0.0343,
  openDelaySec: 30,
};

export const BASE_FLOW: FlowConfig = {
  noiseUsdPerHourPerMarket: 250,
  noiseSizeMedianUsd: 25,
  noiseSizeSigma: 1,
  noiseToleranceMean: 0.06,
  informedShare: 0.2,
  informedMode: "arrivals",
  sniperPresence: 1,
  informedEdgeThreshold: 0.005,
  latencyMs: 1000,
};

export const PESSIMISTIC_FLOW: FlowConfig = {
  ...BASE_FLOW,
  noiseUsdPerHourPerMarket: 125,
  noiseToleranceMean: 0.04,
  informedShare: 0.5,
  latencyMs: 2000,
};

export function makeConfig(over: {
  params?: StrategyParams;
  flow?: Partial<FlowConfig>;
  venue?: Partial<VenueConfig>;
  nav0?: number;
  seed?: number;
  startDay?: string;
  endDay?: string;
  dayStride?: number;
  dayOffset?: number;
  assets?: string[];
  durations?: number[];
}): SimConfig {
  return {
    assets: over.assets ?? ["BTC/USD", "ETH/USD"],
    durations: over.durations ?? [900, 3600],
    nav0: over.nav0 ?? 5000,
    params: over.params ?? DEFAULT_PARAMS,
    flow: { ...BASE_FLOW, ...over.flow },
    venue: { ...BASE_VENUE, ...over.venue },
    seed: over.seed ?? 20261004,
    startDay: over.startDay ?? WINDOW.start,
    endDay: over.endDay ?? END_EXCLUSIVE,
    ...(over.dayStride !== undefined ? { dayStride: over.dayStride } : {}),
    ...(over.dayOffset !== undefined ? { dayOffset: over.dayOffset } : {}),
  };
}
