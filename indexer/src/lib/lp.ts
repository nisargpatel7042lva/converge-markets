/**
 * Pure LP accounting for vault shares (unit-tested in test/lp.test.ts).
 * - shares: exact share-token wallet balance (Transfer events).
 * - escrowedShares: shares sitting in open redeem requests (still the LP's economically).
 * - costBasis: collateral cost of the shares still held, average-cost, removed in proportion
 *   (rounded down) so cost in == cost held + cost removed.
 */
import { proportionalCost } from "./position";

export interface LpState {
  shares: bigint;
  escrowedShares: bigint;
  costBasis: bigint;
  realizedPnl: bigint;
  totalDeposited: bigint;
  totalWithdrawn: bigint;
}

export const emptyLp = (): LpState => ({
  shares: 0n,
  escrowedShares: 0n,
  costBasis: 0n,
  realizedPnl: 0n,
  totalDeposited: 0n,
  totalWithdrawn: 0n,
});

export const lpHeld = (s: LpState): bigint => s.shares + s.escrowedShares;

/** A claimed deposit: `assets` of cost arrives together with the minted shares (the Transfer is a wallet change). */
export function applyDepositClaim(s: LpState, assets: bigint): LpState {
  return { ...s, costBasis: s.costBasis + assets, totalDeposited: s.totalDeposited + assets };
}

/** A claimed redemption: `burned` shares were destroyed at settlement for `assets` of collateral. */
export function applyRedeemClaim(s: LpState, burned: bigint, assets: bigint): LpState {
  const removed = proportionalCost(s.costBasis, lpHeld(s), burned);
  const esc = s.escrowedShares > burned ? s.escrowedShares - burned : 0n;
  return {
    ...s,
    escrowedShares: esc,
    costBasis: s.costBasis - removed,
    realizedPnl: s.realizedPnl + assets - removed,
    totalWithdrawn: s.totalWithdrawn + assets,
  };
}

/** Not clamped: a negative balance is an indexing gap and must stay visible (see reconcile invariants). */
export function addShares(s: LpState, delta: bigint): LpState {
  return { ...s, shares: s.shares + delta };
}

export function addEscrowShares(s: LpState, delta: bigint): LpState {
  return { ...s, escrowedShares: s.escrowedShares + delta };
}

/** Share transfer between two ordinary LP wallets: the cost travels with the shares. */
export function moveLpCost(from: LpState, to: LpState, amount: bigint): [LpState, LpState] {
  const moved = proportionalCost(from.costBasis, lpHeld(from), amount);
  return [
    { ...from, costBasis: from.costBasis - moved },
    { ...to, costBasis: to.costBasis + moved },
  ];
}

/** Unrealized PnL at a lower price per share (WAD). */
export function lpUnrealized(s: LpState, ppsWad: bigint): bigint {
  return (lpHeld(s) * ppsWad) / 10n ** 18n - s.costBasis;
}
