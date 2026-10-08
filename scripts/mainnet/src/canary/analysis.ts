/**
 * Canary judgement: pure functions over what was observed on chain and in the trader's log, so the
 * acceptance numbers ("0 missed rounds, 0 failed claims") are computed, not asserted by hand.
 */
export const OPEN_STATE = 1;
export const RESOLVED_UP = 2;
export const RESOLVED_DOWN = 3;
export const INVALID_STATE = 4;

export interface SeriesSpec {
  label: string;
  /** Round lengths in seconds that the scheduler must create for this series. */
  durations: number[];
}

export interface RoundObs {
  series: string;
  duration: number;
  start: number;
  created: boolean;
  /** Market.State; null when the round does not exist. */
  state: number | null;
  /** Block time of the `Opened` event. */
  openedAt: number | null;
  /** Block time of the `Resolved` / `Invalidated` event. */
  resolvedAt: number | null;
}

export interface Limits {
  /** A round must be open this soon after its start. */
  openLateSec: number;
  /** A round must be resolved this soon after its end. */
  resolveLateSec: number;
}

export const DEFAULT_LIMITS: Limits = { openLateSec: 60, resolveLateSec: 600 };

export interface MissedRound {
  series: string;
  duration: number;
  start: number;
  reason:
    "not-created" | "not-opened" | "opened-late" | "not-resolved" | "resolved-late" | "invalid";
}

/** Every grid start whose whole round lies inside [from, to]. */
export function expectedStarts(duration: number, from: number, to: number): number[] {
  const first = Math.ceil(from / duration) * duration;
  const out: number[] = [];
  for (let s = first; s + duration <= to; s += duration) out.push(s);
  return out;
}

export interface RoundVerdict {
  expected: number;
  resolved: number;
  invalid: number;
  missed: MissedRound[];
}

export function judgeRounds(
  obs: RoundObs[],
  series: SeriesSpec[],
  window: { from: number; to: number },
  limits: Limits = DEFAULT_LIMITS,
): RoundVerdict {
  const byKey = new Map(obs.map((o) => [`${o.series}|${o.duration}|${o.start}`, o]));
  const missed: MissedRound[] = [];
  let expected = 0;
  let resolved = 0;
  let invalid = 0;
  for (const s of series) {
    for (const d of s.durations) {
      for (const start of expectedStarts(d, window.from, window.to)) {
        expected++;
        const base = { series: s.label, duration: d, start };
        const o = byKey.get(`${s.label}|${d}|${start}`);
        if (!o || !o.created) {
          missed.push({ ...base, reason: "not-created" });
          continue;
        }
        if (o.state === INVALID_STATE) {
          invalid++;
          missed.push({ ...base, reason: "invalid" });
          continue;
        }
        if (o.openedAt === null) {
          missed.push({ ...base, reason: "not-opened" });
          continue;
        }
        if (o.openedAt - start > limits.openLateSec) {
          missed.push({ ...base, reason: "opened-late" });
          continue;
        }
        if (o.resolvedAt === null || (o.state !== RESOLVED_UP && o.state !== RESOLVED_DOWN)) {
          missed.push({ ...base, reason: "not-resolved" });
          continue;
        }
        if (o.resolvedAt - (start + d) > limits.resolveLateSec) {
          missed.push({ ...base, reason: "resolved-late" });
          continue;
        }
        resolved++;
      }
    }
  }
  return { expected, resolved, invalid, missed };
}

// ------------------------------------------------------------------ trades and claims

export interface TradeRecord {
  orderId: string;
  market: string;
  series: string;
  side: "UP" | "DOWN";
  placedAt: number;
  /** What happened to the order. `open` after the lateness window means it is stuck. */
  status: "executed" | "expired" | "open";
  statusAt?: number;
  /** The trader had to expire it itself because nobody executed it in time: the keeper missed it. */
  fallbackExpired?: boolean;
  filledShares?: string;
  costUsdc?: string;
  /** Redeem after resolution: ok, failed (reverted), or not attempted (market not resolved yet). */
  redeem?: "ok" | "failed" | "pending" | "not-needed";
  redeemError?: string;
  payoutUsdc?: string;
}

export interface TradeVerdict {
  placed: number;
  executed: number;
  /** Executed orders that bought something (filledShares > 0). */
  filled: number;
  expired: number;
  stuckOrders: TradeRecord[];
  failedClaims: TradeRecord[];
  pendingClaims: TradeRecord[];
}

/** An order the keeper should have executed (or expired) within this long after it was placed. */
export const ORDER_STUCK_AFTER_SEC = 60;

export function judgeTrades(trades: TradeRecord[], now: number): TradeVerdict {
  return {
    placed: trades.length,
    executed: trades.filter((t) => t.status === "executed").length,
    filled: trades.filter((t) => t.status === "executed" && BigInt(t.filledShares ?? "0") > 0n)
      .length,
    expired: trades.filter((t) => t.status === "expired").length,
    stuckOrders: trades.filter(
      (t) =>
        t.fallbackExpired === true ||
        (t.status === "open" && now - t.placedAt > ORDER_STUCK_AFTER_SEC),
    ),
    failedClaims: trades.filter((t) => t.redeem === "failed"),
    pendingClaims: trades.filter((t) => t.status === "executed" && t.redeem === "pending"),
  };
}

// ------------------------------------------------------------------ vault performance

export interface NavSnapshot {
  at: number;
  navLower: bigint;
  navUpper: bigint;
  /** Lower price per share, WAD. */
  pps: bigint;
  supply: bigint;
}

export interface PnlReport {
  hours: number;
  ppsStart: number;
  ppsEnd: number;
  /** Change in the lower price per share over the run, as a fraction (not annualised). */
  ppsChange: number;
  navLowerStartUsdc: number;
  navLowerEndUsdc: number;
  note: string;
}

/** Share-price change is the honest measure: deposits and withdrawals do not move it. */
export function pnl(start: NavSnapshot, end: NavSnapshot): PnlReport {
  const wad = 1e18;
  const a = Number(start.pps) / wad;
  const b = Number(end.pps) / wad;
  return {
    hours: (end.at - start.at) / 3600,
    ppsStart: a,
    ppsEnd: b,
    ppsChange: a > 0 ? b / a - 1 : 0,
    navLowerStartUsdc: Number(start.navLower) / 1e6,
    navLowerEndUsdc: Number(end.navLower) / 1e6,
    note: "Lower-bound share price (the vault's conservative valuation). A run of this length says almost nothing about expected returns: the number is reported, not interpreted.",
  };
}

export interface CanaryVerdict {
  pass: boolean;
  reasons: string[];
}

export function overall(
  hoursRun: number,
  minHours: number,
  rounds: RoundVerdict,
  trades: TradeVerdict,
  minFilled = 5,
): CanaryVerdict {
  const reasons: string[] = [];
  if (hoursRun < minHours) reasons.push(`ran ${hoursRun.toFixed(1)} h, needs ${minHours} h`);
  if (rounds.expected === 0) reasons.push("no round was expected in the window");
  if (rounds.missed.length) reasons.push(`${rounds.missed.length} missed round(s)`);
  if (trades.failedClaims.length) reasons.push(`${trades.failedClaims.length} failed claim(s)`);
  if (trades.stuckOrders.length) reasons.push(`${trades.stuckOrders.length} stuck order(s)`);
  if (trades.placed === 0) reasons.push("the trader placed no order");
  if (trades.filled < minFilled)
    reasons.push(
      `only ${trades.filled} order(s) actually filled (need ${minFilled}): an order that is executed with nothing filled proves nothing about quoting`,
    );
  return { pass: reasons.length === 0, reasons };
}
