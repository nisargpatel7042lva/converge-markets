/**
 * MarketFactory (discovery), Market (lifecycle, split / merge / redeem) and OutcomeToken
 * (balances) handlers. Markets and their two tokens are registered dynamically on MarketCreated.
 */
import { indexer, type Market } from "envio";
import {
  addBalance,
  applyMerge,
  applyRedeem,
  applySplit,
  moveCost,
  type SideKey,
} from "../lib/position";
import {
  addUserPnl,
  type Ctx,
  isSystem,
  lc,
  loadPosition,
  positionState,
  savePosition,
  touchUser,
  updateDaily,
  updateProtocol,
  ZERO,
} from "../lib/store";

// ------------------------------------------------------------------ factory

/** The part of a MarketCreated event both factories (MarketFactory, PartnerRegistry) share. */
type Hex = `0x${string}`;
interface MarketCreatedLike {
  params: {
    market: Hex;
    assetId: string;
    duration: bigint;
    params: {
      resolver: Hex;
      collateral: Hex;
      up: Hex;
      down: Hex;
      startTime: bigint;
      endTime: bigint;
      redeemFeeBps: bigint;
    };
  };
  block: { number: number; timestamp: number };
}

const registerMarket = async ({
  event,
  context,
}: {
  event: MarketCreatedLike;
  context: {
    chain: {
      Market: { add: (a: Hex) => void };
      OutcomeToken: { add: (a: Hex) => void };
    };
  };
}) => {
  context.chain.Market.add(event.params.market);
  context.chain.OutcomeToken.add(event.params.params.up);
  context.chain.OutcomeToken.add(event.params.params.down);
};

indexer.contractRegister({ contract: "MarketFactory", event: "MarketCreated" }, registerMarket);
// The PartnerRegistry is a second market factory with the same event (ADR-008).
indexer.contractRegister({ contract: "PartnerRegistry", event: "MarketCreated" }, registerMarket);

indexer.onEvent({ contract: "MarketFactory", event: "AssetSet" }, async ({ event, context }) => {
  context.Asset.set({
    id: event.params.assetId,
    label: event.params.label,
    resolver: lc(event.params.resolver),
    enabled: event.params.enabled,
  });
});

async function indexMarketCreated({
  event,
  context,
}: {
  event: MarketCreatedLike;
  context: Ctx;
}): Promise<void> {
  {
    const p = event.params.params;
    const assetId = event.params.assetId;
    const asset = await context.Asset.get(assetId);
    const id = lc(event.params.market);
    const ts = event.block.timestamp;
    context.Market.set({
      id,
      assetId,
      asset: asset?.label ?? assetId,
      duration: Number(event.params.duration),
      startTime: Number(p.startTime),
      endTime: Number(p.endTime),
      strike: undefined,
      endPrice: undefined,
      status: "CREATED",
      outcome: undefined,
      upToken: lc(p.up),
      downToken: lc(p.down),
      collateral: lc(p.collateral),
      resolver: lc(p.resolver),
      redeemFeeBps: Number(p.redeemFeeBps),
      createdBlock: event.block.number,
      createdTimestamp: ts,
      openedTimestamp: undefined,
      resolvedTimestamp: undefined,
      resolvedBlock: undefined,
      volume: 0n,
      tradeCount: 0,
      lastUpPrice: undefined,
      vaultRegistered: false,
      vaultBasis: 0n,
      vaultCash: 0n,
      upSupply: 0n,
      downSupply: 0n,
      redeemFeesTotal: 0n,
      partner: undefined,
      voided: false,
    });
    context.OutcomeToken.set({ id: lc(p.up), market_id: id, side: "UP", totalSupply: 0n });
    context.OutcomeToken.set({ id: lc(p.down), market_id: id, side: "DOWN", totalSupply: 0n });
    await updateProtocol(context, event.block.number, (s) => ({
      totalMarkets: s.totalMarkets + 1,
    }));
    await updateDaily(context, ts, (d) => ({ marketsCreated: d.marketsCreated + 1 }));
  }
}

indexer.onEvent({ contract: "MarketFactory", event: "MarketCreated" }, indexMarketCreated);
indexer.onEvent({ contract: "PartnerRegistry", event: "MarketCreated" }, indexMarketCreated);

// ------------------------------------------------------------------ market lifecycle

async function mustMarket(context: Ctx, address: string): Promise<Market | undefined> {
  const m = await context.Market.get(lc(address));
  if (!m) context.log.error(`Market ${address} is not known (MarketCreated not indexed)`);
  return m;
}

indexer.onEvent({ contract: "Market", event: "Opened" }, async ({ event, context }) => {
  const m = await mustMarket(context, event.srcAddress);
  if (!m) return;
  context.Market.set({
    ...m,
    status: "OPEN",
    strike: event.params.strike,
    openedTimestamp: event.block.timestamp,
  });
});

// Market.State: 0 CREATED, 1 OPEN, 2 RESOLVED_UP, 3 RESOLVED_DOWN, 4 INVALID.
indexer.onEvent({ contract: "Market", event: "Resolved" }, async ({ event, context }) => {
  const m = await mustMarket(context, event.srcAddress);
  if (!m) return;
  const up = Number(event.params.outcome) === 2;
  context.Market.set({
    ...m,
    status: up ? "RESOLVED_UP" : "RESOLVED_DOWN",
    outcome: up ? "UP" : "DOWN",
    strike: event.params.strike,
    endPrice: event.params.endPrice,
    resolvedTimestamp: event.block.timestamp,
    resolvedBlock: event.block.number,
  });
  await updateProtocol(context, event.block.number, (s) => ({
    totalMarketsResolved: s.totalMarketsResolved + 1,
  }));
  await updateDaily(context, event.block.timestamp, (d) => ({
    marketsResolved: d.marketsResolved + 1,
  }));
});

indexer.onEvent({ contract: "Market", event: "Invalidated" }, async ({ event, context }) => {
  const m = await mustMarket(context, event.srcAddress);
  if (!m) return;
  context.Market.set({
    ...m,
    status: "INVALID",
    outcome: "INVALID",
    resolvedTimestamp: event.block.timestamp,
    resolvedBlock: event.block.number,
  });
  await updateProtocol(context, event.block.number, (s) => ({
    totalMarketsResolved: s.totalMarketsResolved + 1,
  }));
  await updateDaily(context, event.block.timestamp, (d) => ({
    marketsResolved: d.marketsResolved + 1,
  }));
});

// The contract emits Split / Merged / Redeemed BEFORE it mints or burns: the economic
// event runs first, the Transfer events (below) update the wallet balances afterwards.

indexer.onEvent({ contract: "Market", event: "Split" }, async ({ event, context }) => {
  const who = event.params.account;
  if (await isSystem(context, event.chainId, who)) return;
  const ts = event.block.timestamp;
  await touchUser(context, event.chainId, who, ts, event.block.number);
  const pos = await loadPosition(context, who, event.srcAddress, ts);
  savePosition(context, pos, applySplit(positionState(pos), event.params.amount), ts);
});

indexer.onEvent({ contract: "Market", event: "Merged" }, async ({ event, context }) => {
  const who = event.params.account;
  if (await isSystem(context, event.chainId, who)) return;
  const ts = event.block.timestamp;
  await touchUser(context, event.chainId, who, ts, event.block.number);
  const pos = await loadPosition(context, who, event.srcAddress, ts);
  const before = positionState(pos);
  const after = applyMerge(before, event.params.amount);
  savePosition(context, pos, after, ts);
  await addUserPnl(context, who, after.realizedPnl - before.realizedPnl);
});

indexer.onEvent({ contract: "Market", event: "Redeemed" }, async ({ event, context }) => {
  const ts = event.block.timestamp;
  const fee = event.params.fee;
  if (fee !== 0n) {
    const m = await mustMarket(context, event.srcAddress);
    if (m) context.Market.set({ ...m, redeemFeesTotal: m.redeemFeesTotal + fee });
    await updateProtocol(context, event.block.number, (s) => ({
      totalFeesRedeem: s.totalFeesRedeem + fee,
    }));
    await updateDaily(context, ts, (d) => ({ feesRedeem: d.feesRedeem + fee }));
  }
  const who = event.params.account;
  if (await isSystem(context, event.chainId, who)) return;
  await touchUser(context, event.chainId, who, ts, event.block.number);
  const pos = await loadPosition(context, who, event.srcAddress, ts);
  const before = positionState(pos);
  const after = applyRedeem(
    before,
    event.params.upBurned,
    event.params.downBurned,
    event.params.payout,
  );
  savePosition(context, pos, after, ts);
  await addUserPnl(context, who, after.realizedPnl - before.realizedPnl);
});

// ------------------------------------------------------------------ outcome token balances

indexer.onEvent({ contract: "OutcomeToken", event: "Transfer" }, async ({ event, context }) => {
  const token = await context.OutcomeToken.get(lc(event.srcAddress));
  if (!token) {
    context.log.error(`OutcomeToken ${event.srcAddress} is not known (MarketCreated not indexed)`);
    return;
  }
  const k: SideKey = token.side === "UP" ? "up" : "down";
  const { from, to, value } = event.params;
  const ts = event.block.timestamp;
  const mint = lc(from) === ZERO;
  const burn = lc(to) === ZERO;

  if (mint || burn) {
    const delta = mint ? value : -value;
    context.OutcomeToken.set({ ...token, totalSupply: token.totalSupply + delta });
    const m = await context.Market.get(token.market_id);
    if (m) {
      context.Market.set(
        k === "up"
          ? { ...m, upSupply: m.upSupply + delta }
          : { ...m, downSupply: m.downSupply + delta },
      );
    }
  }

  // A transfer to oneself changes nothing (and must not load the same entity twice).
  if (lc(from) === lc(to)) return;
  const market = token.market_id;
  const fromPos = mint ? undefined : await loadPosition(context, from, market, ts);
  const toPos = burn ? undefined : await loadPosition(context, to, market, ts);
  let fromState = fromPos ? positionState(fromPos) : undefined;
  let toState = toPos ? positionState(toPos) : undefined;

  // Cost travels only between two ordinary holders; vault / venue / mint / burn legs are
  // accounted for by the economic events (Fill, Split, Merged, Redeemed, order escrow).
  if (
    fromState &&
    toState &&
    !(await isSystem(context, event.chainId, from)) &&
    !(await isSystem(context, event.chainId, to))
  ) {
    [fromState, toState] = moveCost(fromState, toState, k, value);
  }
  if (fromState) fromState = addBalance(fromState, k, -value);
  if (toState) toState = addBalance(toState, k, value);
  if (fromPos && fromState) savePosition(context, fromPos, fromState, ts);
  if (toPos && toState) savePosition(context, toPos, toState, ts);
});
