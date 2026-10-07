import { encodeFunctionData, type Address, type Hex } from "viem";
import { convergeVaultAbi, forwardVenueAbi, marketAbi, mockErc20Abi } from "./abi/generated";
import type { Side } from "./indexer";
import { WAD } from "./indexer-math";

/**
 * Building blocks for the consumer app: everything a trade or an LP action needs, as plain data
 * (to, data, value) so that any signer can send it. Prices are WAD (1e18 = 1 collateral unit per
 * share), amounts are collateral base units (6 decimals) and shares are in the same units.
 *
 * Execution is forward-priced (ADR-004): `placeOrder` escrows the budget, a keeper executes the
 * order two seconds later at the oracle report for that second, and whatever was not spent is
 * refunded. The limit price is the buyer's protection: the order never pays more per share.
 */

/** Collateral base units per 1.00 (USDC and the test token have 6 decimals). */
export const UNIT = 1_000_000n;
/** `ForwardVenue.ESCROW_SLACK` = `QuoteMath.MAX_LEVELS`: the escrow of a buy is rounded up by this. */
export const ESCROW_SLACK = 4n;
/** Prices at or above this are not accepted by the venue (limit < 1). */
export const MAX_LIMIT_WAD = 990_000_000_000_000_000n;
export const MIN_LIMIT_WAD = 10_000_000_000_000_000n;

/** `ForwardVenue.Kind`. */
export const ORDER_KIND = { BUY_UP: 0, SELL_UP: 1, BUY_DOWN: 2, SELL_DOWN: 3 } as const;
export type OrderKindName = keyof typeof ORDER_KIND;

export type Tx = { to: Address; data: Hex; value?: bigint };

export const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** A decimal string or number of collateral units ("12.5") as base units; throws on bad input. */
export function parseUnits6(input: string | number): bigint {
  const s = typeof input === "number" ? input.toFixed(6) : input.trim();
  if (!/^\d+(\.\d{0,6})?$/.test(s)) throw new Error(`not an amount: ${input}`);
  const [whole = "0", frac = ""] = s.split(".");
  return BigInt(whole) * UNIT + BigInt(frac.padEnd(6, "0"));
}

/** Base units as a plain decimal string with up to `dp` decimals, trailing zeros trimmed. */
export function formatUnits6(v: bigint, dp = 2): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const scaled = (a * 10n ** BigInt(dp)) / UNIT;
  const whole = scaled / 10n ** BigInt(dp);
  const frac = (scaled % 10n ** BigInt(dp)).toString().padStart(dp, "0");
  return `${neg ? "-" : ""}${whole}${dp > 0 ? `.${frac}` : ""}`;
}

/** A float price in (0, 1) as WAD, rounded up to the next 1e-6. */
export function priceToWad(price: number): bigint {
  if (!(price > 0 && price < 1)) throw new Error(`price out of range: ${price}`);
  return BigInt(Math.ceil(price * 1e6)) * 10n ** 12n;
}

/**
 * The worst price the buyer accepts: the displayed price plus the slippage, never above 0.99 and
 * never below the displayed price itself. 100 bps is 1 % of the price.
 */
export function limitFor(priceWad: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 5_000) throw new Error("slippage out of range");
  const l = ceilDiv(priceWad * BigInt(10_000 + slippageBps), 10_000n);
  const capped = l > MAX_LIMIT_WAD ? MAX_LIMIT_WAD : l;
  return capped < priceWad ? priceWad : capped;
}

export type BuyPlan = {
  kind: "BUY_UP" | "BUY_DOWN";
  /** Shares the order asks for (collateral base units). */
  shares: bigint;
  limitWad: bigint;
  /** What `placeOrder` pulls into escrow: the most the order can cost. */
  escrow: bigint;
  /** What the trader pays if the order fills at the displayed price. */
  expectedCost: bigint;
  /** Collateral paid out per share if the side wins, before the redeem fee. */
  payoutIfRight: bigint;
  /** Profit if right at the displayed price, after the redeem fee. */
  profitIfRight: bigint;
  /** Loss if wrong at the displayed price (the whole cost). */
  lossIfWrong: bigint;
};

/**
 * Sizes a buy for a budget: as many shares as the budget buys at the limit price, so that the
 * escrow never exceeds the budget. `redeemFeeBps` is the market's fee on winning payouts.
 */
export function planBuy(args: {
  side: Side;
  budget: bigint;
  priceWad: bigint;
  slippageBps: number;
  redeemFeeBps?: number;
}): BuyPlan {
  const { side, budget, priceWad, slippageBps } = args;
  if (budget <= 0n) throw new Error("amount must be positive");
  const limitWad = limitFor(priceWad, slippageBps);
  // escrow = ceil(shares * limit / WAD) + slack <= budget  =>  shares <= (budget - slack) * WAD / limit
  const spendable = budget > ESCROW_SLACK ? budget - ESCROW_SLACK : 0n;
  const shares = (spendable * WAD) / limitWad;
  if (shares === 0n) throw new Error("amount too small");
  const escrow = ceilDiv(shares * limitWad, WAD) + ESCROW_SLACK;
  const expectedCost = ceilDiv(shares * priceWad, WAD);
  const fee = (shares * BigInt(args.redeemFeeBps ?? 0)) / 10_000n;
  const payoutIfRight = shares - fee;
  return {
    kind: side === "UP" ? "BUY_UP" : "BUY_DOWN",
    shares,
    limitWad,
    escrow,
    expectedCost,
    payoutIfRight,
    profitIfRight: payoutIfRight - expectedCost,
    lossIfWrong: expectedCost,
  };
}

/** The price a buyer sees for a side, from the vault's UP ladder (`ForwardVenue.quoteAt`). */
export function askFromLadder(
  side: Side,
  q: {
    quoting: boolean;
    bids: readonly { price: bigint; size: bigint }[];
    asks: readonly { price: bigint; size: bigint }[];
  },
): { priceWad: bigint; sizeShares: bigint } | null {
  if (!q.quoting) return null;
  if (side === "UP") {
    const a = q.asks[0];
    return a && a.size > 0n ? { priceWad: a.price, sizeShares: a.size } : null;
  }
  // buying DOWN = selling UP to the vault's best UP bid: the DOWN price is 1 - that bid
  const b = q.bids[0];
  return b && b.size > 0n ? { priceWad: WAD - b.price, sizeShares: b.size } : null;
}

/** The ladder's mid as the market's implied probability of UP, in [0, 1]. */
export function impliedUp(q: { fair: bigint }): number {
  return Number(q.fair) / 1e18;
}

// ------------------------------------------------------------------ transactions

export function approveTx(token: Address, spender: Address, amount: bigint): Tx {
  return {
    to: token,
    data: encodeFunctionData({
      abi: mockErc20Abi,
      functionName: "approve",
      args: [spender, amount],
    }),
  };
}

export function placeOrderTx(args: {
  venue: Address;
  market: Address;
  plan: Pick<BuyPlan, "kind" | "shares" | "limitWad">;
  /** Native reward for the executor (`ForwardVenue.minReward` or more). */
  reward: bigint;
}): Tx {
  return {
    to: args.venue,
    data: encodeFunctionData({
      abi: forwardVenueAbi,
      functionName: "placeOrder",
      args: [args.market, ORDER_KIND[args.plan.kind], args.plan.shares, args.plan.limitWad],
    }),
    value: args.reward,
  };
}

/** Burns the caller's UP and DOWN of a resolved market and pays the winnings. */
export function redeemTx(market: Address): Tx {
  return { to: market, data: encodeFunctionData({ abi: marketAbi, functionName: "redeem" }) };
}

export function expireOrderTx(venue: Address, id: bigint): Tx {
  return {
    to: venue,
    data: encodeFunctionData({ abi: forwardVenueAbi, functionName: "expireOrder", args: [id] }),
  };
}

export function requestDepositTx(vault: Address, assets: bigint): Tx {
  return {
    to: vault,
    data: encodeFunctionData({
      abi: convergeVaultAbi,
      functionName: "requestDeposit",
      args: [assets],
    }),
  };
}

export function requestRedeemTx(vault: Address, shares: bigint): Tx {
  return {
    to: vault,
    data: encodeFunctionData({
      abi: convergeVaultAbi,
      functionName: "requestRedeem",
      args: [shares],
    }),
  };
}

export function claimDepositTx(vault: Address, epoch: bigint, receiver: Address): Tx {
  return {
    to: vault,
    data: encodeFunctionData({
      abi: convergeVaultAbi,
      functionName: "claimDeposit",
      args: [epoch, receiver],
    }),
  };
}

export function claimRedeemTx(vault: Address, epoch: bigint, receiver: Address): Tx {
  return {
    to: vault,
    data: encodeFunctionData({
      abi: convergeVaultAbi,
      functionName: "claimRedeem",
      args: [epoch, receiver],
    }),
  };
}

// ------------------------------------------------------------------ market phases

/** What a user should see for a round, from its on-chain state and the clock (seconds). */
export type RoundPhase =
  | { phase: "UPCOMING"; startsIn: number }
  | { phase: "LIVE"; endsIn: number; closing: boolean }
  | { phase: "RESOLVING" }
  | { phase: "SETTLED"; outcome: "UP" | "DOWN" | "INVALID" };

/** `Market.State` numbering: 0 CREATED, 1 OPEN, 2 RESOLVED_UP, 3 RESOLVED_DOWN, 4 INVALID. */
export function roundPhase(args: {
  state: number;
  start: number;
  end: number;
  now: number;
  /** The no-quote window at the end of a round (seconds). */
  closingSeconds?: number;
}): RoundPhase {
  const { state, start, end, now } = args;
  if (state === 2) return { phase: "SETTLED", outcome: "UP" };
  if (state === 3) return { phase: "SETTLED", outcome: "DOWN" };
  if (state === 4) return { phase: "SETTLED", outcome: "INVALID" };
  if (state === 1 && now < end)
    return { phase: "LIVE", endsIn: end - now, closing: end - now <= (args.closingSeconds ?? 60) };
  if (state === 1) return { phase: "RESOLVING" };
  if (now < start) return { phase: "UPCOMING", startsIn: start - now };
  return now >= end ? { phase: "RESOLVING" } : { phase: "UPCOMING", startsIn: 0 };
}
