/**
 * Pure read-side math shared with the Envio indexer (indexer/src/lib/{apy,position,lp}.ts keep a
 * copy because the hosted indexer must not import outside its own directory;
 * indexer/test/sdk-parity.test.ts asserts both copies agree on shared vectors).
 */
export const SECONDS_PER_YEAR = 365 * 86_400;
export const WAD = 10n ** 18n;

export interface NavObs {
  ppsWad: bigint;
  timestamp: number;
}

export interface Perf {
  periodReturn: number;
  apy: number;
  elapsedSeconds: number;
}

const SCALE = 1_000_000_000_000n;

/** period return and compound APY of the lower price per share between two observations. */
export function navPerformance(now: NavObs, then: NavObs): Perf | undefined {
  const elapsed = now.timestamp - then.timestamp;
  if (elapsed <= 0 || now.ppsWad <= 0n || then.ppsWad <= 0n) return undefined;
  const ratio = Number((now.ppsWad * SCALE) / then.ppsWad) / Number(SCALE);
  const apy = Math.pow(ratio, SECONDS_PER_YEAR / elapsed) - 1;
  if (!Number.isFinite(apy)) return undefined;
  return { periodReturn: ratio - 1, apy, elapsedSeconds: elapsed };
}

/**
 * Exact window performance from raw NavSnapshot rows (any order): the baseline is the LAST snapshot
 * at or before `now - windowSeconds`; undefined when history does not reach back that far. The
 * indexer's stored apy7d / apy30d use day buckets (baseline up to one day older); this is the exact
 * variant for charts and audits.
 */
export function windowPerformance(
  snapshots: readonly NavObs[],
  now: NavObs,
  windowSeconds: number,
): Perf | undefined {
  const target = now.timestamp - windowSeconds;
  let base: NavObs | undefined;
  for (const s of snapshots) {
    if (s.timestamp <= target && (base === undefined || s.timestamp >= base.timestamp)) base = s;
  }
  return base ? navPerformance(now, base) : undefined;
}

export type MarketValuation =
  { kind: "live"; upPriceWad: bigint } | { kind: "resolved"; outcome: "UP" | "DOWN" | "INVALID" };

export interface HoldingLike {
  upBalance: bigint;
  downBalance: bigint;
  upEscrowed: bigint;
  downEscrowed: bigint;
  upCost: bigint;
  downCost: bigint;
  realizedPnl: bigint;
}

/** Value of the tokens still held (wallet + sell-order escrow), collateral units. */
export function positionValue(p: HoldingLike, v: MarketValuation): bigint {
  const up = p.upBalance + p.upEscrowed;
  const down = p.downBalance + p.downEscrowed;
  if (v.kind === "resolved") {
    if (v.outcome === "UP") return up;
    if (v.outcome === "DOWN") return down;
    return (up + down) / 2n;
  }
  return (up * v.upPriceWad) / WAD + (down * (WAD - v.upPriceWad)) / WAD;
}

export const unrealizedPnl = (p: HoldingLike, v: MarketValuation): bigint =>
  positionValue(p, v) - (p.upCost + p.downCost);

/** realized + unrealized. */
export const totalPnl = (p: HoldingLike, v: MarketValuation): bigint =>
  p.realizedPnl + unrealizedPnl(p, v);

/** Unrealized PnL of an LP at the lower price per share (WAD). */
export function lpUnrealizedPnl(
  lp: { shares: bigint; escrowedShares: bigint; costBasis: bigint },
  ppsWad: bigint,
): bigint {
  return ((lp.shares + lp.escrowedShares) * ppsWad) / WAD - lp.costBasis;
}

/** Valuation of a market row for positionValue: exact when resolved, last fill price otherwise. */
export function valuationOf(m: {
  status: string;
  lastUpPrice: string | number | null | undefined;
}): MarketValuation {
  if (m.status === "RESOLVED_UP") return { kind: "resolved", outcome: "UP" };
  if (m.status === "RESOLVED_DOWN") return { kind: "resolved", outcome: "DOWN" };
  if (m.status === "INVALID") return { kind: "resolved", outcome: "INVALID" };
  const p = m.lastUpPrice === null || m.lastUpPrice === undefined ? 0.5 : Number(m.lastUpPrice);
  const clamped = Math.min(1, Math.max(0, p));
  return { kind: "live", upPriceWad: BigInt(Math.round(clamped * 1e9)) * 10n ** 9n };
}
