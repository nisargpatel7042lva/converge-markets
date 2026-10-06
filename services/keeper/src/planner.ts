import type { Address, Hex } from "viem";
import type { KeeperFile } from "./config";
import type { MarketInfo, OrderRow, VaultState } from "./chain/vault";
import { MARKET_STATE } from "./chain/vault";

export type Action =
  | { type: "executeOrder"; key: string; priority: number; order: OrderRow }
  | { type: "expireOrder"; key: string; priority: number; order: OrderRow }
  | { type: "settle"; key: string; priority: number; epochId: number; end: number; feeds: Hex[] }
  | { type: "resolve"; key: string; priority: number; market: Address }
  | {
      type: "setSigma";
      key: string;
      priority: number;
      assetId: Hex;
      sigmaWad: bigint;
      sigma: number;
    }
  | { type: "checkpoint"; key: string; priority: number; feeds: Hex[] }
  | { type: "redeemResolved"; key: string; priority: number; market: Address }
  | { type: "pruneEmpty"; key: string; priority: number; market: Address }
  | { type: "merge"; key: string; priority: number; market: Address; amount: bigint }
  | { type: "split"; key: string; priority: number; market: Address; amount: bigint };

/** Lower number = sooner. */
export const PRIORITY = {
  executeOrder: 0,
  settle: 1,
  resolve: 2,
  setSigma: 3,
  checkpoint: 4,
  redeemResolved: 5,
  merge: 6,
  split: 7,
  pruneEmpty: 8,
  expireOrder: 9,
} as const;

export type PlanInput = {
  nowSec: number;
  state: VaultState;
  /** Annual volatility estimate per assetId (lower-case hex); missing = estimator not ready. */
  sigmaTarget: ReadonlyMap<string, number>;
  /** Pending (OPEN) venue orders. */
  orders: readonly OrderRow[];
  venue: { maxLateness: number };
  cfg: Pick<
    KeeperFile,
    | "sigmaRefreshSec"
    | "sigmaMoveFraction"
    | "targetPairFraction"
    | "topUpBelowFraction"
    | "minSecondsLeftToSplit"
    | "checkpointEverySec"
  >;
  /** True while the keeper has pulled its quotes (or is about to): nothing that adds exposure. */
  pulling: boolean;
};

const NAV_DEC = 1e6; // the vault's asset has 6 decimals

const isOpen = (m: MarketInfo) => m.state === MARKET_STATE.OPEN;
const isDone = (m: MarketInfo) =>
  m.state === MARKET_STATE.RESOLVED_UP ||
  m.state === MARKET_STATE.RESOLVED_DOWN ||
  m.state === MARKET_STATE.INVALID;
const pairsOf = (m: MarketInfo) => (m.upBal < m.downBal ? m.upBal : m.downBal);

function sigmaAction(a: PlanInput["state"]["assets"][number], p: PlanInput): Action | null {
  const target = p.sigmaTarget.get(a.assetId.toLowerCase());
  if (target === undefined || !a.enabled) return null;
  const lim = p.state.limits;
  const age = p.nowSec - a.sigmaUpdatedAt;
  const unset = a.sigma === 0;
  const stale = unset || age > lim.sigmaMaxAge;
  const wanted = Math.min(a.sigmaMax, Math.max(a.sigmaMin, target));
  const moved = !unset && Math.abs(wanted / a.sigma - 1) >= p.cfg.sigmaMoveFraction;
  if (!(unset || age >= p.cfg.sigmaRefreshSec || moved)) return null;
  if (!unset && p.nowSec < a.sigmaUpdatedAt + lim.sigmaMinInterval) return null;
  let next = wanted;
  if (!stale) {
    // stay inside the vault's step limit with a margin for the rounding of floats
    const step = (lim.maxSigmaStepBps / 10_000) * 0.9;
    next = Math.min(a.sigma * (1 + step), Math.max(a.sigma * (1 - step), wanted));
  }
  // strictly inside the owner band
  if (a.sigmaMax > a.sigmaMin) {
    next = Math.min(a.sigmaMax - 1e-9, Math.max(a.sigmaMin + 1e-9, next));
  }
  const sigmaWad = BigInt(Math.round(next * 1e9)) * 1_000_000_000n;
  return {
    type: "setSigma",
    key: `sigma:${a.assetId}`,
    priority: PRIORITY.setSigma,
    assetId: a.assetId,
    sigmaWad,
    sigma: next,
  };
}

/**
 * What to send now, given what the chain says. Pure: nothing here talks to the network, so the
 * diff between the desired state and the vault's state can be tested exhaustively. Each action
 * carries a key; the loop never has two of the same key in flight.
 */
export function plan(p: PlanInput): Action[] {
  const out: Action[] = [];
  const s = p.state;
  const { cfg } = p;

  // ---- orders: execute inside the window, expire what was missed (or skipped while pulled)
  for (const o of p.orders) {
    const lastOk = o.execAt + p.venue.maxLateness;
    if (
      p.nowSec >= o.execAt &&
      p.nowSec <= lastOk &&
      !p.pulling &&
      !s.keeperHalt &&
      !s.quotingPaused
    ) {
      out.push({
        type: "executeOrder",
        key: `exec:${o.id}`,
        priority: PRIORITY.executeOrder,
        order: o,
      });
    } else if (p.nowSec > lastOk) {
      out.push({
        type: "expireOrder",
        key: `expire:${o.id}`,
        priority: PRIORITY.expireOrder,
        order: o,
      });
    }
  }

  // ---- settlement: resolve what ended, then settle (an epoch not settled in time expires)
  for (const e of s.epochs) {
    if (e.settled || !e.plan) continue;
    if (p.nowSec < e.end || p.nowSec > e.end + s.settleWindow - 3) continue;
    if (e.plan.unresolved.length > 0) {
      for (const m of e.plan.unresolved) {
        out.push({ type: "resolve", key: `resolve:${m}`, priority: PRIORITY.resolve, market: m });
      }
    } else {
      out.push({
        type: "settle",
        key: `settle:${e.id}`,
        priority: PRIORITY.settle,
        epochId: e.id,
        end: e.end,
        feeds: e.plan.feeds,
      });
    }
  }

  // ---- sigma
  for (const a of s.assets) {
    const act = sigmaAction(a, p);
    if (act) out.push(act);
  }

  // ---- nav checkpoint
  if (s.totalSupply > 0n && p.nowSec - s.navUpdatedAt >= cfg.checkpointEverySec) {
    const feeds: Hex[] = [];
    for (const m of s.markets) {
      if (!m.registered || !isOpen(m) || m.upBal === m.downBal) continue;
      const a = s.assets.find((x) => x.assetId.toLowerCase() === m.assetId.toLowerCase());
      if (a && !feeds.includes(a.feedId)) feeds.push(a.feedId);
    }
    out.push({ type: "checkpoint", key: "checkpoint", priority: PRIORITY.checkpoint, feeds });
  }

  // ---- registry upkeep: redeem what resolved, free empty slots
  for (const m of s.markets) {
    if (!m.registered) continue;
    const tokens = m.upBal + m.downBal;
    if (isDone(m) && tokens > 0n)
      out.push({
        type: "redeemResolved",
        key: `redeem:${m.address}`,
        priority: PRIORITY.redeemResolved,
        market: m.address,
      });
    else if (tokens === 0n && (isDone(m) || p.nowSec > m.end))
      out.push({
        type: "pruneEmpty",
        key: `prune:${m.address}`,
        priority: PRIORITY.pruneEmpty,
        market: m.address,
      });
  }

  // ---- inventory: merge pairs the final seconds of a round (and to cover a redemption shortfall)
  const navUnits = Number(s.navLower);
  const noQuote = s.params.noQuoteWindowSec;
  let deficit = redemptionDeficit(s);
  const mergeable = s.markets
    .filter((m) => m.registered && isOpen(m) && pairsOf(m) > 0n)
    .sort((a, b) => a.end - b.end);
  for (const m of mergeable) {
    const inFinalWindow = m.end - p.nowSec <= noQuote + 10;
    if (!inFinalWindow && deficit <= 0n) continue;
    const pairs = pairsOf(m);
    const amount = inFinalWindow || pairs <= deficit ? pairs : deficit;
    out.push({
      type: "merge",
      key: `merge:${m.address}`,
      priority: PRIORITY.merge,
      market: m.address,
      amount,
    });
    deficit -= amount;
  }

  // ---- inventory: have pairs in every open round (never while pulling or paused)
  if (!p.pulling && !s.keeperHalt && !s.quotingPaused && navUnits > 0) {
    const target = BigInt(Math.floor(navUnits * cfg.targetPairFraction));
    let totalBasis = 0n;
    for (const m of s.markets) if (m.registered && m.basis > 0n) totalBasis += m.basis;
    const invCap = BigInt(Math.floor(navUnits * s.limits.maxInventoryFraction));
    const pairCap = BigInt(Math.floor(navUnits * s.limits.maxPairFraction));
    let free = s.freeLiquidity - reservedForRedemptions(s);
    let slots = 16 - s.limits.marketCount;
    for (const m of s.markets) {
      const a = s.assets.find((x) => x.assetId.toLowerCase() === m.assetId.toLowerCase());
      if (!a || !a.enabled || !isOpen(m) || m.end - p.nowSec <= cfg.minSecondsLeftToSplit) continue;
      const pairs = m.registered ? pairsOf(m) : 0n;
      if (m.registered && Number(pairs) >= Number(target) * cfg.topUpBelowFraction) continue;
      if (!m.registered && slots <= 0) continue;
      let amount = target - pairs;
      if (m.basis + amount > pairCap) amount = pairCap - m.basis;
      if (totalBasis + amount > invCap) amount = invCap - totalBasis;
      if (amount > free) amount = free;
      if (amount < BigInt(NAV_DEC)) continue; // less than one unit: not worth a transaction
      out.push({
        type: "split",
        key: `split:${m.address}`,
        priority: PRIORITY.split,
        market: m.address,
        amount,
      });
      totalBasis += amount;
      free -= amount;
      if (!m.registered) slots -= 1;
    }
  }

  return out.sort((a, b) => a.priority - b.priority);
}

/** Collateral owed to the redeem requests of the epochs still to be settled (lower NAV per share). */
function reservedForRedemptions(s: VaultState): bigint {
  if (s.totalSupply === 0n) return 0n;
  let owed = 0n;
  for (const e of s.epochs) if (!e.settled) owed += (e.redeemShares * s.navLower) / s.totalSupply;
  return owed;
}

function redemptionDeficit(s: VaultState): bigint {
  const owed = reservedForRedemptions(s);
  return owed > s.freeLiquidity ? owed - s.freeLiquidity : 0n;
}
