import { DEFAULT_PARAMS, type MarketState, type StrategyParams } from "../src";

/** Deterministic PRNG (mulberry32) for statistical tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(r: () => number): number {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

export const P: StrategyParams = { ...DEFAULT_PARAMS };

export function state(over: Partial<MarketState> = {}): MarketState {
  return {
    spot: 100,
    strike: 100,
    tauSec: 600,
    roundSec: 900,
    sigma: 0.5,
    position: { cash: 0, shortUp: 0 },
    nav: 5000,
    otherAtRisk: 0,
    recentRangeBps: 0,
    breakerTripped: false,
    ...over,
  };
}
