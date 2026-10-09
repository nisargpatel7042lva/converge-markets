import { decodeEventLog, type Address, type Hex } from "viem";
import { fairProbUp, SECONDS_PER_YEAR } from "@converge/strategy";
import { convergeVaultAbi, marketAbi, marketFactoryAbi, mockErc20Abi } from "@converge/sdk";
import { read, send, type Ctx } from "./chain";
import {
  buildQuote,
  KURU_TESTNET,
  MARKET_PARAMS,
  marginAbi,
  needsRequote,
  orderBookAbi,
  routerAbi,
  sizeUnits,
  toTicks,
} from "./kuru";
import type { KuruRound, KuruState, TxNote } from "./state";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const MAX = 2n ** 256n - 1n;

export interface Deployment {
  marketFactory: Address;
  assetTEST: Hex;
  collateral_tUSDC: Address;
  vault: { vault: Address };
}

export interface Sizing {
  /** Whole tokens split into UP + DOWN per listed round. */
  splitTokens: number;
  /** Whole tokens quoted on each side. */
  quoteTokens: number;
  /** Dollars deposited as bid margin. */
  quoteMargin: number;
  /** Half the quoted spread, in dollars. */
  half: number;
}

export const DEFAULT_SIZING: Sizing = {
  splitTokens: 12,
  quoteTokens: 5,
  quoteMargin: 8,
  half: 0.04,
};

const note = (step: string, hash: Hex, gasLimit: bigint): TxNote => ({
  step,
  hash,
  gasLimit: gasLimit.toString(),
  at: Math.floor(Date.now() / 1000),
});

export interface LiveRound {
  converge: Address;
  up: Address;
  down: Address;
  start: number;
  end: number;
  strike: number;
  state: number;
}

/** The Converge rounds around now, in two Multicall3 reads. */
export async function readRounds(
  ctx: Ctx,
  dep: Deployment,
  duration = 900,
): Promise<{ now: number; rounds: LiveRound[] }> {
  const now = Number((await ctx.pub.getBlock()).timestamp);
  const cur = Math.floor(now / duration) * duration;
  const starts = [-2, -1, 0, 1].map((k) => cur + k * duration);
  const addrs = (await ctx.pub.multicall({
    allowFailure: false,
    contracts: starts.map((s) => ({
      address: dep.marketFactory,
      abi: marketFactoryAbi,
      functionName: "getMarket" as const,
      args: [dep.assetTEST, BigInt(duration), BigInt(s)] as const,
    })),
  })) as Address[];
  const live = addrs.map((a, i) => ({ a, start: starts[i]! })).filter((x) => x.a !== ZERO);
  if (live.length === 0) return { now, rounds: [] };
  const fields = ["state", "strike", "up", "down"] as const;
  const res = await ctx.pub.multicall({
    allowFailure: false,
    contracts: live.flatMap((x) =>
      fields.map((f) => ({ address: x.a, abi: marketAbi, functionName: f })),
    ),
  });
  return {
    now,
    rounds: live.map((x, i) => ({
      converge: x.a,
      start: x.start,
      end: x.start + duration,
      state: Number(res[i * 4]),
      strike: Number(res[i * 4 + 1] as bigint) / 1e18,
      up: res[i * 4 + 2] as Address,
      down: res[i * 4 + 3] as Address,
    })),
  };
}

/** The fair probability of UP now, from the same formula and the same volatility the vault uses. */
export async function fairNow(
  ctx: Ctx,
  dep: Deployment,
  r: LiveRound,
  now: number,
  spot: number,
): Promise<number | null> {
  if (r.strike <= 0) return null;
  const cfg = await read<readonly unknown[]>(ctx, dep.vault.vault, convergeVaultAbi, "assetCfg", [
    dep.assetTEST,
  ]);
  const sigma = Number(cfg[2] as bigint) / 1e18;
  if (!(sigma > 0)) return null;
  return fairProbUp(spot, r.strike, sigma, Math.max(0, r.end - now) / SECONDS_PER_YEAR);
}

/** The Kuru market of an outcome token, which is a pure function of its parameters (no registry needed). */
export async function kuruAddressOf(ctx: Ctx, base: Address, quote: Address): Promise<Address> {
  const p = MARKET_PARAMS;
  return read<Address>(ctx, KURU_TESTNET.router, routerAbi, "computeAddress", [
    base,
    quote,
    p.sizePrecision,
    Number(p.pricePrecision),
    Number(p.tickSize),
    p.minSize,
    p.maxSize,
    p.takerFeeBps,
    p.makerFeeBps,
    p.ammSpreadBps,
    ZERO,
    false,
  ]);
}

/** Creates the Kuru market for a round's UP token (idempotent: an existing market is reused). */
export async function ensureListed(
  ctx: Ctx,
  dep: Deployment,
  state: KuruState,
  r: LiveRound,
): Promise<KuruRound> {
  const key = r.converge.toLowerCase();
  const have = state.rounds[key];
  if (have) return have;
  const kuru = await kuruAddressOf(ctx, r.up, dep.collateral_tUSDC);
  const code = await ctx.pub.getCode({ address: kuru });
  const txs: TxNote[] = [];
  let market = kuru;
  if (!code || code === "0x") {
    const p = MARKET_PARAMS;
    const s = await send(ctx, {
      address: KURU_TESTNET.router,
      abi: routerAbi,
      functionName: "deployProxy",
      args: [
        0,
        r.up,
        dep.collateral_tUSDC,
        p.sizePrecision,
        Number(p.pricePrecision),
        Number(p.tickSize),
        p.minSize,
        p.maxSize,
        p.takerFeeBps,
        p.makerFeeBps,
        p.ammSpreadBps,
      ],
    });
    txs.push(note("kuru deployProxy (UP/tUSDC)", s.hash, s.gasLimit));
    for (const l of s.receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: routerAbi, data: l.data, topics: l.topics });
        if (ev.eventName === "MarketRegistered")
          market = (ev.args as unknown as { market: Address }).market;
      } catch {
        /* not a router event */
      }
    }
    if (market.toLowerCase() !== kuru.toLowerCase())
      throw new Error(`Kuru market ${market} differs from the computed address ${kuru}`);
  }
  const round: KuruRound = {
    converge: r.converge,
    up: r.up,
    down: r.down,
    kuru: market,
    start: r.start,
    end: r.end,
    strike: r.strike,
    status: "listed",
    seeded: false,
    orderIds: [],
    lastQuote: null,
    quotes: 0,
    txs,
  };
  state.rounds[key] = round;
  ctx.log(`listed ${new Date(r.start * 1000).toISOString().slice(11, 16)} on Kuru: ${market}`);
  return round;
}

/** Turns collateral into UP + DOWN, and puts the UP tokens and the bid margin into Kuru's margin account. */
export async function seed(ctx: Ctx, dep: Deployment, round: KuruRound, sz: Sizing): Promise<void> {
  if (round.seeded) return;
  const tokens = BigInt(sz.splitTokens) * 1_000_000n;
  const margin = BigInt(Math.round(sz.quoteMargin * 1e6));
  const need = tokens + margin;
  const bal = await read<bigint>(ctx, dep.collateral_tUSDC, mockErc20Abi, "balanceOf", [ctx.me]);
  if (bal < need) {
    const s = await send(ctx, {
      address: dep.collateral_tUSDC,
      abi: mockErc20Abi,
      functionName: "mint",
      args: [ctx.me, need * 2n],
    });
    round.txs.push(note("mint test collateral", s.hash, s.gasLimit));
  }
  const allowance = async (token: Address, spender: Address) =>
    read<bigint>(ctx, token, mockErc20Abi, "allowance", [ctx.me, spender]);
  const approve = async (token: Address, spender: Address, step: string) => {
    if ((await allowance(token, spender)) >= tokens + margin) return;
    const s = await send(ctx, {
      address: token,
      abi: mockErc20Abi,
      functionName: "approve",
      args: [spender, MAX],
    });
    round.txs.push(note(step, s.hash, s.gasLimit));
  };
  await approve(dep.collateral_tUSDC, round.converge, "approve collateral to the round");
  const split = await send(ctx, {
    address: round.converge,
    abi: marketAbi,
    functionName: "split",
    args: [tokens],
  });
  round.txs.push(note("split collateral into UP + DOWN", split.hash, split.gasLimit));
  await approve(round.up, KURU_TESTNET.marginAccount, "approve UP to Kuru margin");
  await approve(
    dep.collateral_tUSDC,
    KURU_TESTNET.marginAccount,
    "approve collateral to Kuru margin",
  );
  const d1 = await send(ctx, {
    address: KURU_TESTNET.marginAccount,
    abi: marginAbi,
    functionName: "deposit",
    args: [ctx.me, round.up, tokens],
  });
  round.txs.push(note("margin deposit UP", d1.hash, d1.gasLimit));
  const d2 = await send(ctx, {
    address: KURU_TESTNET.marginAccount,
    abi: marginAbi,
    functionName: "deposit",
    args: [ctx.me, dep.collateral_tUSDC, margin],
  });
  round.txs.push(note("margin deposit collateral", d2.hash, d2.gasLimit));
  round.seeded = true;
  round.status = "quoting";
}

/** Cancels the old quote and posts a new two-sided one in one atomic `batchUpdate`. */
export async function requote(
  ctx: Ctx,
  round: KuruRound,
  fair: number,
  now: number,
  sz: Sizing,
): Promise<boolean> {
  const q = buildQuote(fair, sz.half);
  const cancel = round.orderIds.map((x) => Number(x));
  if (!q) {
    if (cancel.length === 0) return false;
    const s = await send(ctx, {
      address: round.kuru,
      abi: orderBookAbi,
      functionName: "batchCancelOrders",
      args: [cancel],
    });
    round.txs.push(note("pull quotes (round nearly decided)", s.hash, s.gasLimit));
    round.orderIds = [];
    return true;
  }
  const size = sizeUnits(sz.quoteTokens);
  const s = await send(ctx, {
    address: round.kuru,
    abi: orderBookAbi,
    functionName: "batchUpdate",
    args: [[q.bidTicks], [size], [q.askTicks], [size], cancel, true],
  });
  const created: string[] = [];
  for (const l of s.receipt.logs) {
    if (l.address.toLowerCase() !== round.kuru.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: orderBookAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "OrderCreated")
        created.push(String((ev.args as unknown as { orderId: bigint }).orderId));
    } catch {
      /* other event */
    }
  }
  if (created.length !== 2)
    throw new Error(
      `expected 2 new orders, got ${created.length} (a post-only order may have crossed)`,
    );
  round.orderIds = created;
  round.lastQuote = { fair, bid: q.bid, ask: q.ask, at: now };
  round.quotes += 1;
  round.txs.push(
    note(
      `quote ${q.bid.toFixed(3)} / ${q.ask.toFixed(3)} (fair ${fair.toFixed(3)})`,
      s.hash,
      s.gasLimit,
    ),
  );
  return true;
}

export { needsRequote, toTicks };

/** At the end of a round: pull the quotes and take the margin back. */
export async function closeRound(ctx: Ctx, dep: Deployment, round: KuruRound): Promise<void> {
  if (round.status === "closed" || round.status === "redeemed") return;
  if (round.orderIds.length) {
    const s = await send(ctx, {
      address: round.kuru,
      abi: orderBookAbi,
      functionName: "batchCancelOrders",
      args: [round.orderIds.map((x) => Number(x))],
    });
    round.txs.push(note("cancel quotes", s.hash, s.gasLimit));
    round.orderIds = [];
  }
  if (round.seeded) {
    const w = await send(ctx, {
      address: KURU_TESTNET.marginAccount,
      abi: marginAbi,
      functionName: "batchWithdrawMaxTokens",
      args: [[round.up, dep.collateral_tUSDC]],
    });
    round.txs.push(note("withdraw margin", w.hash, w.gasLimit));
  }
  round.status = "closed";
}

/** After the oracle has resolved the round: turn the winning tokens back into collateral. */
export async function redeemRound(ctx: Ctx, round: KuruRound): Promise<boolean> {
  if (round.status !== "closed") return false;
  const state = Number(await read<number>(ctx, round.converge, marketAbi, "state"));
  if (state < 2) return false;
  const [u, d] = await Promise.all([
    read<bigint>(ctx, round.up, mockErc20Abi, "balanceOf", [ctx.me]),
    read<bigint>(ctx, round.down, mockErc20Abi, "balanceOf", [ctx.me]),
  ]);
  if (u === 0n && d === 0n) {
    round.status = "redeemed";
    return true;
  }
  const s = await send(ctx, { address: round.converge, abi: marketAbi, functionName: "redeem" });
  round.txs.push(note("redeem the round's tokens", s.hash, s.gasLimit));
  round.status = "redeemed";
  return true;
}
