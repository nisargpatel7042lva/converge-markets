/**
 * Vault return metrics from price-per-share (WAD) observations. Pure, unit-tested.
 *
 * period return = ppsNow / ppsThen - 1
 * APY           = (1 + period return) ^ (365 d / elapsed) - 1   (compound, over the ACTUAL elapsed time)
 *
 * The price per share is the LOWER price (conservative NAV, ADR-005); it includes the mark band, so a
 * short window is noisy and APY over a short window is amplified by annualisation. Callers decide
 * whether a window is long enough to display.
 */
export const SECONDS_PER_YEAR = 365 * 86_400;

export interface Obs {
  ppsWad: bigint;
  timestamp: number;
}

export interface Perf {
  periodReturn: number;
  apy: number;
  elapsedSeconds: number;
}

const SCALE = 1_000_000_000_000n; // 1e12 keeps the ratio exact enough for a double

export function performance(now: Obs, then: Obs): Perf | undefined {
  const elapsed = now.timestamp - then.timestamp;
  if (elapsed <= 0 || now.ppsWad <= 0n || then.ppsWad <= 0n) return undefined;
  const ratio = Number((now.ppsWad * SCALE) / then.ppsWad) / Number(SCALE);
  const periodReturn = ratio - 1;
  const apy = Math.pow(ratio, SECONDS_PER_YEAR / elapsed) - 1;
  // A non-finite APY (astronomically short window) is not representable in JSON/GraphQL: no value.
  if (!Number.isFinite(apy)) return undefined;
  return { periodReturn, apy, elapsedSeconds: elapsed };
}

/**
 * Baseline for a window from a time-ordered list of observations: the LAST observation at or
 * before `now - windowSeconds`. Undefined when history does not reach back that far.
 */
export function baselineFor(
  obs: readonly Obs[],
  nowTs: number,
  windowSeconds: number,
): Obs | undefined {
  const target = nowTs - windowSeconds;
  let best: Obs | undefined;
  for (const o of obs) {
    if (o.timestamp <= target && (best === undefined || o.timestamp >= best.timestamp)) best = o;
  }
  return best;
}

/** window APY from raw observations (the exact version; the indexer's incremental version is day-bucketed). */
export function windowPerformance(
  obs: readonly Obs[],
  now: Obs,
  windowSeconds: number,
): Perf | undefined {
  const base = baselineFor(obs, now.timestamp, windowSeconds);
  return base ? performance(now, base) : undefined;
}

export const dayOf = (ts: number): number => Math.floor(ts / 86_400);
