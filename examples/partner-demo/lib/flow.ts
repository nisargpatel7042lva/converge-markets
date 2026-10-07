/**
 * The whole partner journey as one function, built only with `@converge/sdk`: create a market,
 * wait for the vault's quotes, trade against them, resolve and redeem. The testnet CLI
 * (scripts/run-demo.ts) and the anvil end-to-end test run this exact code, and what it returns is
 * the evidence saved under docs/evidence/phase-8/.
 */
import {
  createConvergeClient,
  mockErc20Abi,
  type ConvergeAddresses,
  type MarketView,
  type StreamsReportSource,
} from "@converge/sdk";
import type { Address, Hex, PublicClient, WalletClient } from "viem";

export interface FlowInput {
  publicClient: PublicClient;
  partnerWallet: WalletClient;
  takerWallet: WalletClient;
  addresses: ConvergeAddresses;
  /** The oracle asset label, e.g. "TEST/USD" on testnet. */
  asset: string;
  /** The threshold, as a decimal string. */
  strike: string;
  /** The asset's current price, for the indication shown to the trader. */
  spot: number;
  /** Seconds from now to the end of the market (900 to 604800). */
  durationSec: number;
  /** What the trader spends, in collateral units ("3" = 3 USDC). */
  buyUsd: string;
  /** Where the end price comes from (a test signer on testnet; Data Streams on mainnet). */
  reports: StreamsReportSource;
  /** Chain time in seconds. */
  chainNow: () => Promise<number>;
  /** Gets the chain to `endTime` (sleep on a live network, warp on a local one). */
  waitUntil: (endTime: number) => Promise<void>;
  /** Gives the trader test money and gas if it has none (testnet / local only). */
  fundTaker?: () => Promise<void>;
  /** Called after each step with what happened (progress output). */
  onStep?: (step: string, data: Record<string, unknown>) => void;
  /** How long to wait for the vault's quotes. */
  quoteTimeoutMs?: number;
}

export interface FlowEvidence {
  asset: string;
  strike: string;
  spot: number;
  market: Address;
  partner: Address;
  taker: Address;
  createTx: Hex;
  createdAtBlock: string;
  /** Blocks between the block that created the market and the first block at which it was quoted. */
  blocksToQuote: number;
  msToQuote: number;
  quotes: {
    fair: number;
    upAsk: number | null;
    upBid: number | null;
    downAsk: number | null;
    downBid: number | null;
    upDepthShares: string | null;
  };
  buyTx: Hex;
  order: { id: string; executesAt: number };
  fill: { status: string; filled: string; premium: string; avgPrice: number | null; txHash: Hex };
  /** Seconds from placing the order to its execution (chain time of the blocks). */
  fillLatencyMs: number;
  fillsSeenBySubscription: number;
  resolution: { status: string; endPrice: string | null; endTime: number };
  redeemTx: Hex | null;
  takerPayout: string;
  takerNetUsd: number;
  /** Final market view. */
  final: Pick<MarketView, "status" | "strikeNumber" | "endTime" | "partner" | "redeemFeeBps">;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runDemoFlow(i: FlowInput): Promise<FlowEvidence> {
  const step = (s: string, d: Record<string, unknown> = {}) => i.onStep?.(s, d);
  const partner = createConvergeClient({
    publicClient: i.publicClient,
    walletClient: i.partnerWallet,
    addresses: i.addresses,
  });
  const taker = createConvergeClient({
    publicClient: i.publicClient,
    walletClient: i.takerWallet,
    addresses: i.addresses,
  });

  // 0. the partner is approved and bonded
  const standing = await partner.getPartner();
  if (!standing.approved) throw new Error("this account is not an approved partner");
  step("partner", { cap: standing.exposureCap.toString(), bond: standing.bond.toString() });

  // 1. create the market
  const t0 = Date.now();
  const end = (await i.chainNow()) + i.durationSec;
  const created = await partner.createPartnerMarket({ asset: i.asset, strike: i.strike, end });
  step("created", { market: created.market, block: created.blockNumber.toString() });

  // 2. wait for the vault's quotes
  const timeout = i.quoteTimeoutMs ?? 60_000;
  let view = await partner.getMarket(created.market);
  let detectedBlock = await i.publicClient.getBlockNumber();
  while (!view.quoting) {
    if (Date.now() - t0 > timeout) throw new Error("the vault did not quote the market in time");
    await sleep(100);
    view = await partner.getMarket(created.market);
    detectedBlock = await i.publicClient.getBlockNumber();
  }
  const msToQuote = Date.now() - t0;
  const blocksToQuote = Number(detectedBlock - created.blockNumber);
  step("quoted", { blocksToQuote, msToQuote });

  // 3. read the quotes
  const q = await taker.getQuotes(created.market, { spot: i.spot });
  if (!q.quoting) throw new Error("quotes disappeared right after the vault started quoting");

  // 4. the trader buys UP
  await i.fundTaker?.();
  const fillsSeen: number[] = [];
  const stop = taker.subscribeFills({ market: created.market, pollMs: 250 }, () =>
    fillsSeen.push(Date.now()),
  );
  await sleep(600); // let the subscription take its first look before the trade
  const balanceOf = async (who: Address) =>
    (await i.publicClient.readContract({
      address: i.addresses.collateral,
      abi: mockErc20Abi,
      functionName: "balanceOf",
      args: [who],
    })) as bigint;
  const takerAddr = taker.account as Address;
  const before = await balanceOf(takerAddr);
  const placedAt = Date.now();
  const order = await taker.buy({
    market: created.market,
    side: "UP",
    amount: i.buyUsd,
    spot: i.spot,
  });
  step("order", { id: order.orderId.toString(), executesAt: order.executesAt });
  const fill = await taker.waitForFill(order.orderId, { timeoutMs: 60_000 });
  const fillLatencyMs = Date.now() - placedAt;
  step("fill", { status: fill.status, filled: fill.filled.toString() });
  for (let n = 0; n < 40 && fillsSeen.length === 0; n++) await sleep(250);
  stop();

  // 5. the end: resolve with the oracle price, then redeem
  await i.waitUntil(end);
  const status = await taker.resolve(created.market, { reports: i.reports, timeoutMs: 180_000 });
  const resolved = await taker.getMarket(created.market);
  step("resolved", { status });
  const pos = await taker.getPosition(created.market);
  let redeemTx: Hex | null = null;
  if (pos.claimable > 0n) redeemTx = await taker.redeem(created.market);
  const after = await balanceOf(takerAddr);
  const net = Number(after - before) / 1e6;
  step("redeemed", { net });

  return {
    asset: i.asset,
    strike: i.strike,
    spot: i.spot,
    market: created.market,
    partner: partner.account as Address,
    taker: takerAddr,
    createTx: created.txHash,
    createdAtBlock: created.blockNumber.toString(),
    blocksToQuote,
    msToQuote,
    quotes: {
      fair: q.fair,
      upAsk: q.up.ask?.price ?? null,
      upBid: q.up.bid?.price ?? null,
      downAsk: q.down.ask?.price ?? null,
      downBid: q.down.bid?.price ?? null,
      upDepthShares: q.up.ask?.size.toString() ?? null,
    },
    buyTx: order.txHash,
    order: { id: order.orderId.toString(), executesAt: order.executesAt },
    fill: {
      status: fill.status,
      filled: fill.filled.toString(),
      premium: fill.premium.toString(),
      avgPrice: fill.filled > 0n ? Number(fill.premium) / Number(fill.filled) : null,
      txHash: fill.txHash,
    },
    fillLatencyMs,
    fillsSeenBySubscription: fillsSeen.length,
    resolution: {
      status,
      endPrice: resolved.endPrice === null ? null : resolved.endPrice.toString(),
      endTime: end,
    },
    redeemTx,
    takerPayout: pos.claimable.toString(),
    takerNetUsd: net,
    final: {
      status: resolved.status,
      strikeNumber: resolved.strikeNumber,
      endTime: resolved.endTime,
      partner: resolved.partner,
      redeemFeeBps: resolved.redeemFeeBps,
    },
  };
}
