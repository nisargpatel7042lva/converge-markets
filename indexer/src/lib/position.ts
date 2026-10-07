/**
 * Pure position accounting (no Envio imports, unit-tested in test/position.test.ts).
 *
 * Model (docs/phases/PHASE-6-plan.md, assumption 4):
 * - balance: the exact ERC-20 wallet balance (driven by Transfer events only).
 * - escrow: tokens locked in an open ForwardVenue sell order; economically still the holder's.
 * - cost: average-cost basis of the HELD tokens (wallet + escrow), in collateral units.
 * - Cost leaves in proportion to the share of the holding that leaves, rounded DOWN, so
 *   cost_in == cost_held + cost_removed exactly (nothing is created or lost by rounding).
 * - Realized PnL = proceeds - removed cost.
 */

export type SideKey = "up" | "down";

export interface PositionState {
  upBalance: bigint;
  downBalance: bigint;
  upEscrowed: bigint;
  downEscrowed: bigint;
  upCost: bigint;
  downCost: bigint;
  realizedPnl: bigint;
  totalIn: bigint;
  totalOut: bigint;
  tradeCount: number;
}

export const emptyState = (): PositionState => ({
  upBalance: 0n,
  downBalance: 0n,
  upEscrowed: 0n,
  downEscrowed: 0n,
  upCost: 0n,
  downCost: 0n,
  realizedPnl: 0n,
  totalIn: 0n,
  totalOut: 0n,
  tradeCount: 0,
});

const bal = (s: PositionState, k: SideKey) => (k === "up" ? s.upBalance : s.downBalance);
const esc = (s: PositionState, k: SideKey) => (k === "up" ? s.upEscrowed : s.downEscrowed);
const cost = (s: PositionState, k: SideKey) => (k === "up" ? s.upCost : s.downCost);

/** Tokens the holder owns economically: wallet plus open sell-order escrow. */
export const held = (s: PositionState, k: SideKey): bigint => bal(s, k) + esc(s, k);

export const costBasis = (s: PositionState): bigint => s.upCost + s.downCost;

/** Cost attached to `amount` of a holding of `heldAmount` with total cost `c` (rounded down). */
export function proportionalCost(c: bigint, heldAmount: bigint, amount: bigint): bigint {
  if (amount <= 0n || heldAmount <= 0n || c <= 0n) return 0n;
  if (amount >= heldAmount) return c;
  return (c * amount) / heldAmount;
}

function withCost(s: PositionState, k: SideKey, c: bigint): PositionState {
  return k === "up" ? { ...s, upCost: c } : { ...s, downCost: c };
}

/** `split`: `amount` collateral buys one UP and one DOWN; the cost is allocated 50/50 (UP takes the odd unit). */
export function applySplit(s: PositionState, amount: bigint): PositionState {
  const half = amount / 2n;
  return {
    ...s,
    upCost: s.upCost + (amount - half),
    downCost: s.downCost + half,
    totalIn: s.totalIn + amount,
  };
}

/** Removes `amount` of one side (held), returns the new state and the removed cost. */
function remove(s: PositionState, k: SideKey, amount: bigint): [PositionState, bigint] {
  const removed = proportionalCost(cost(s, k), held(s, k), amount);
  return [withCost(s, k, cost(s, k) - removed), removed];
}

/** `merge`: `amount` of each side burned for `amount` collateral. Call BEFORE the burn Transfers (the contract emits first). */
export function applyMerge(s: PositionState, amount: bigint): PositionState {
  const [a, r1] = remove(s, "up", amount);
  const [b, r2] = remove(a, "down", amount);
  return { ...b, realizedPnl: b.realizedPnl + amount - r1 - r2, totalOut: b.totalOut + amount };
}

/** `redeem`: all burned tokens settle for `payout` (net of the redeem fee). */
export function applyRedeem(
  s: PositionState,
  upBurned: bigint,
  downBurned: bigint,
  payout: bigint,
): PositionState {
  const [a, r1] = remove(s, "up", upBurned);
  const [b, r2] = remove(a, "down", downBurned);
  return { ...b, realizedPnl: b.realizedPnl + payout - r1 - r2, totalOut: b.totalOut + payout };
}

/** A fill in which the taker bought `side` for `premium`. The wallet balance rises through the Transfer event. */
export function applyBuyFill(s: PositionState, k: SideKey, premium: bigint): PositionState {
  const c = cost(s, k) + premium;
  return { ...withCost(s, k, c), totalIn: s.totalIn + premium, tradeCount: s.tradeCount + 1 };
}

/**
 * A fill in which the taker sold `size` of `side` for `premium`. The tokens left the wallet when the
 * order was placed and sit in escrow: the escrow shrinks here.
 */
export function applySellFill(
  s: PositionState,
  k: SideKey,
  size: bigint,
  premium: bigint,
): PositionState {
  const [a, removed] = remove(s, k, size);
  const e = esc(a, k);
  const newEsc = e > size ? e - size : 0n;
  const b = k === "up" ? { ...a, upEscrowed: newEsc } : { ...a, downEscrowed: newEsc };
  return {
    ...b,
    realizedPnl: b.realizedPnl + premium - removed,
    totalOut: b.totalOut + premium,
    tradeCount: b.tradeCount + 1,
  };
}

/** Escrow bookkeeping for ForwardVenue sell orders. */
export function addEscrow(s: PositionState, k: SideKey, amount: bigint): PositionState {
  return k === "up"
    ? { ...s, upEscrowed: s.upEscrowed + amount }
    : { ...s, downEscrowed: s.downEscrowed + amount };
}

export function releaseEscrow(s: PositionState, k: SideKey, amount: bigint): PositionState {
  const e = esc(s, k);
  const n = e > amount ? e - amount : 0n;
  return k === "up" ? { ...s, upEscrowed: n } : { ...s, downEscrowed: n };
}

/**
 * Wallet balance change (Transfer). Not clamped: a negative balance can only come from an indexing
 * gap and must stay visible (the reconciliation's invariants report it).
 */
export function addBalance(s: PositionState, k: SideKey, delta: bigint): PositionState {
  const b = bal(s, k) + delta;
  return k === "up" ? { ...s, upBalance: b } : { ...s, downBalance: b };
}

/**
 * Wallet-to-wallet transfer between two ordinary holders: the cost travels with the tokens.
 * Returns [sender, receiver]. Balances are NOT changed here (addBalance does that).
 */
export function moveCost(
  from: PositionState,
  to: PositionState,
  k: SideKey,
  amount: bigint,
): [PositionState, PositionState] {
  const moved = proportionalCost(cost(from, k), held(from, k), amount);
  return [withCost(from, k, cost(from, k) - moved), withCost(to, k, cost(to, k) + moved)];
}

/**
 * Value of a position in collateral units at the given UP price (WAD, 1e18 = 1.0) for an
 * unresolved market, or exact settlement values for a resolved one. Pure helper shared with the SDK.
 */
export type MarketValuation =
  | { kind: "live"; upPriceWad: bigint }
  | { kind: "resolved"; outcome: "UP" | "DOWN" | "INVALID"; redeemFeeBps?: number };

export function positionValue(s: PositionState, v: MarketValuation): bigint {
  const up = held(s, "up");
  const down = held(s, "down");
  if (v.kind === "resolved") {
    const gross = v.outcome === "UP" ? up : v.outcome === "DOWN" ? down : (up + down) / 2n;
    return gross - (gross * BigInt(v.redeemFeeBps ?? 0)) / 10_000n;
  }
  const WAD = 10n ** 18n;
  return (up * v.upPriceWad) / WAD + (down * (WAD - v.upPriceWad)) / WAD;
}

export const unrealizedPnl = (s: PositionState, v: MarketValuation): bigint =>
  positionValue(s, v) - costBasis(s);
