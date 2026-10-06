/**
 * ConvergeVault handlers: ERC-7540-style requests and epochs, NAV snapshots (APY source), share
 * balances, fills (the trade source) and state flags.
 */
import {
  BigDecimal,
  indexer,
  type DepositRequest,
  type RedeemRequest,
  type Vault,
  type VaultEpoch,
} from "envio";
import { dayOf, performance, type Obs } from "../lib/apy";
import {
  addEscrowShares,
  addShares,
  applyDepositClaim,
  applyRedeemClaim,
  moveLpCost,
} from "../lib/lp";
import { applyBuyFill, applySellFill, type SideKey } from "../lib/position";
import {
  type Ctx,
  isSystem,
  lc,
  loadLp,
  loadPosition,
  lpState,
  positionState,
  saveLp,
  savePosition,
  touchUser,
  updateDaily,
  updateProtocol,
  ZERO,
} from "../lib/store";

const WINDOWS = [
  { key: "7d", days: 7 },
  { key: "30d", days: 30 },
] as const;
/** How many empty days the baseline search may skip before it gives up (quiet vault). */
const BASELINE_WALK_DAYS = 21;

const zeroVault = (id: string): Vault => ({
  id,
  navLower: 0n,
  navUpper: 0n,
  ppsLower: 0n,
  supply: 0n,
  totalSupply: 0n,
  lastNavTimestamp: 0,
  tvlCap: 0n,
  performanceFeeBps: 0,
  keeper: undefined,
  venue: undefined,
  quotingPaused: false,
  quotingHalted: false,
  breakerTrips: 0,
  lastSettledEpoch: undefined,
  settledEpochs: 0,
  expiredEpochs: 0,
  totalDeposited: 0n,
  totalRedeemed: 0n,
  totalPerformanceFees: 0n,
  totalFillVolume: 0n,
  fillCount: 0,
  pendingFeeShares: 0n,
  pendingFeeAssets: 0n,
  apy7d: undefined,
  apy30d: undefined,
  return7d: undefined,
  return30d: undefined,
  apySinceInception: undefined,
  firstSnapshotPps: undefined,
  firstSnapshotTimestamp: undefined,
});

async function updateVault(
  context: Ctx,
  address: string,
  fn: (v: Vault) => Partial<Vault>,
): Promise<Vault> {
  const id = lc(address);
  const v = (await context.Vault.get(id)) ?? zeroVault(id);
  const next = { ...v, ...fn(v) };
  context.Vault.set(next);
  return next;
}

const zeroEpoch = (id: number): VaultEpoch => ({
  id: String(id),
  epochId: id,
  status: undefined,
  navLower: undefined,
  navUpper: undefined,
  ppsLower: undefined,
  supplyBefore: undefined,
  sharesMinted: undefined,
  sharesBurned: undefined,
  assetsPaid: undefined,
  depositsAccepted: undefined,
  depositRejected: undefined,
  feeShares: 0n,
  feeAssets: 0n,
  depositRequested: 0n,
  redeemRequested: 0n,
  settledTimestamp: undefined,
  settledBlock: undefined,
});

async function updateEpoch(
  context: Ctx,
  id: number,
  fn: (e: VaultEpoch) => Partial<VaultEpoch>,
): Promise<VaultEpoch> {
  const e = (await context.VaultEpoch.get(String(id))) ?? zeroEpoch(id);
  const next = { ...e, ...fn(e) };
  context.VaultEpoch.set(next);
  return next;
}

// ------------------------------------------------------------------ requests

indexer.onEvent(
  { contract: "ConvergeVault", event: "DepositRequested" },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const id = Number(event.params.epochId);
    const owner = lc(event.params.owner);
    const rid = `${id}_${owner}`;
    const prev = await context.DepositRequest.get(rid);
    const req: DepositRequest = prev
      ? { ...prev, assets: prev.assets + event.params.assets }
      : {
          id: rid,
          epochId: id,
          owner,
          assets: event.params.assets,
          status: "REQUESTED",
          shares: undefined,
          refunded: undefined,
          requestedTimestamp: ts,
          claimedTimestamp: undefined,
          receiver: undefined,
        };
    context.DepositRequest.set(req);
    await updateEpoch(context, id, (e) => ({
      depositRequested: e.depositRequested + event.params.assets,
    }));
    await touchUser(context, event.chainId, owner, ts, event.block.number);
    await loadLp(context, owner, ts); // creates the (empty) LP row so it is queryable at once
  },
);

indexer.onEvent(
  { contract: "ConvergeVault", event: "RedeemRequested" },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const id = Number(event.params.epochId);
    const owner = lc(event.params.owner);
    const rid = `${id}_${owner}`;
    const prev = await context.RedeemRequest.get(rid);
    const req: RedeemRequest = prev
      ? {
          ...prev,
          shares: prev.shares + event.params.shares,
          requeued: prev.requeued || event.params.requeued,
        }
      : {
          id: rid,
          epochId: id,
          owner,
          shares: event.params.shares,
          requeued: event.params.requeued,
          status: "REQUESTED",
          assets: undefined,
          requeuedShares: undefined,
          requestedTimestamp: ts,
          claimedTimestamp: undefined,
          receiver: undefined,
        };
    context.RedeemRequest.set(req);
    await updateEpoch(context, id, (e) => ({
      redeemRequested: e.redeemRequested + event.params.shares,
    }));
    if (!event.params.requeued) {
      // New request: the shares moved from the wallet into the vault's custody (Transfer) and are
      // still the LP's economically. A requeue keeps the shares in custody: nothing changes.
      await touchUser(context, event.chainId, owner, ts, event.block.number);
      const lp = await loadLp(context, owner, ts);
      saveLp(context, lp, addEscrowShares(lpState(lp), event.params.shares), ts);
    }
  },
);

indexer.onEvent(
  { contract: "ConvergeVault", event: "DepositClaimed" },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const id = Number(event.params.epochId);
    const owner = lc(event.params.owner);
    const rid = `${id}_${owner}`;
    const req = await context.DepositRequest.get(rid);
    if (!req) {
      context.log.error(`DepositClaimed without a DepositRequest ${rid}`);
      return;
    }
    const refunded = event.params.refunded > 0n;
    context.DepositRequest.set({
      ...req,
      status: refunded ? "REFUNDED" : "CLAIMED",
      shares: event.params.shares,
      refunded: event.params.refunded,
      claimedTimestamp: ts,
      receiver: lc(event.params.receiver),
    });
    if (!refunded && !isSystem(event.chainId, event.params.receiver)) {
      // The shares (Transfer vault -> receiver) and their cost land with the receiver.
      const lp = await loadLp(context, event.params.receiver, ts);
      saveLp(context, lp, applyDepositClaim(lpState(lp), req.assets), ts);
      await touchUser(context, event.chainId, event.params.receiver, ts, event.block.number);
    }
  },
);

indexer.onEvent(
  { contract: "ConvergeVault", event: "RedeemClaimed" },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const id = Number(event.params.epochId);
    const owner = lc(event.params.owner);
    const rid = `${id}_${owner}`;
    const req = await context.RedeemRequest.get(rid);
    if (!req) {
      context.log.error(`RedeemClaimed without a RedeemRequest ${rid}`);
      return;
    }
    const rest = event.params.requeuedShares;
    const burned = req.shares > rest ? req.shares - rest : 0n;
    context.RedeemRequest.set({
      ...req,
      status: "CLAIMED",
      assets: event.params.assets,
      requeuedShares: rest,
      claimedTimestamp: ts,
      receiver: lc(event.params.receiver),
    });
    const lp = await loadLp(context, owner, ts);
    const before = lpState(lp);
    const after = applyRedeemClaim(before, burned, event.params.assets);
    saveLp(context, lp, after, ts);
  },
);

// ------------------------------------------------------------------ epochs

indexer.onEvent(
  { contract: "ConvergeVault", event: "PerformanceFee" },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    await updateVault(context, event.srcAddress, (v) => ({
      pendingFeeShares: event.params.feeShares,
      pendingFeeAssets: event.params.feeAssets,
      totalPerformanceFees: v.totalPerformanceFees + event.params.feeAssets,
    }));
    await updateProtocol(context, event.block.number, (s) => ({
      totalFeesPerformance: s.totalFeesPerformance + event.params.feeAssets,
    }));
    await updateDaily(context, ts, (d) => ({
      feesPerformance: d.feesPerformance + event.params.feeAssets,
    }));
  },
);

async function setRequestStatuses(
  context: Ctx,
  id: number,
  deposits: "CLAIMABLE" | "REFUNDABLE",
): Promise<void> {
  for (const r of await context.DepositRequest.getWhere({ epochId: { _eq: id } })) {
    if (r.status === "REQUESTED") context.DepositRequest.set({ ...r, status: deposits });
  }
  for (const r of await context.RedeemRequest.getWhere({ epochId: { _eq: id } })) {
    if (r.status === "REQUESTED") context.RedeemRequest.set({ ...r, status: "CLAIMABLE" });
  }
}

indexer.onEvent(
  { contract: "ConvergeVault", event: "EpochSettled" },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const id = Number(event.params.epochId);
    const vault = await context.Vault.get(lc(event.srcAddress));
    const feeShares = vault?.pendingFeeShares ?? 0n;
    const feeAssets = vault?.pendingFeeAssets ?? 0n;
    await updateEpoch(context, id, () => ({
      status: "SETTLED" as const,
      navLower: event.params.navLower,
      navUpper: event.params.navUpper,
      supplyBefore: event.params.supplyBefore,
      sharesMinted: event.params.sharesMinted,
      sharesBurned: event.params.sharesBurned,
      assetsPaid: event.params.assetsPaid,
      depositsAccepted: event.params.depositsAccepted,
      depositRejected: event.params.depositRejected,
      feeShares,
      feeAssets,
      settledTimestamp: ts,
      settledBlock: event.block.number,
    }));
    await updateVault(context, event.srcAddress, (v) => ({
      lastSettledEpoch: id,
      settledEpochs: v.settledEpochs + 1,
      totalDeposited: v.totalDeposited + event.params.depositsAccepted,
      totalRedeemed: v.totalRedeemed + event.params.assetsPaid,
      pendingFeeShares: 0n,
      pendingFeeAssets: 0n,
    }));
    await updateProtocol(context, event.block.number, (s) => ({
      totalDeposited: s.totalDeposited + event.params.depositsAccepted,
      totalRedeemed: s.totalRedeemed + event.params.assetsPaid,
    }));
    await updateDaily(context, ts, (d) => ({
      depositsAssets: d.depositsAssets + event.params.depositsAccepted,
      redeemedAssets: d.redeemedAssets + event.params.assetsPaid,
    }));
    await setRequestStatuses(
      context,
      id,
      event.params.depositRejected ? "REFUNDABLE" : "CLAIMABLE",
    );
  },
);

indexer.onEvent(
  { contract: "ConvergeVault", event: "EpochExpired" },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const id = Number(event.params.epochId);
    await updateEpoch(context, id, () => ({
      status: "EXPIRED" as const,
      depositRejected: event.params.depositsRefunded > 0n,
      settledTimestamp: ts,
      settledBlock: event.block.number,
    }));
    await updateVault(context, event.srcAddress, (v) => ({ expiredEpochs: v.expiredEpochs + 1 }));
    await setRequestStatuses(context, id, "REFUNDABLE");
  },
);

// ------------------------------------------------------------------ NAV, APY

indexer.onEvent({ contract: "ConvergeVault", event: "NavSnapshot" }, async ({ event, context }) => {
  const ts = event.block.timestamp;
  const p = event.params;
  context.NavSnapshot.set({
    id: `${event.block.number}_${event.logIndex}`,
    navLower: p.navLower,
    navUpper: p.navUpper,
    ppsLower: p.ppsLower,
    supply: p.supply,
    settlement: p.settlement,
    block: event.block.number,
    timestamp: ts,
  });

  const day = dayOf(ts);
  const cur: Obs = { ppsWad: p.ppsLower, timestamp: ts };

  // Day bucket (internal): the last observation of each day, the APY baseline source.
  context.NavDay.set({ id: String(day), day, ppsClose: p.ppsLower, timestamp: ts });

  const prev = await context.Vault.get(lc(event.srcAddress));
  const first: Obs | undefined =
    prev?.firstSnapshotPps !== undefined && prev.firstSnapshotTimestamp !== undefined
      ? { ppsWad: prev.firstSnapshotPps, timestamp: prev.firstSnapshotTimestamp }
      : undefined;

  const metrics: { -readonly [K in keyof Vault]?: Vault[K] } = {};
  for (const w of WINDOWS) {
    // Baseline = the last observation of the last day that ENDS before now - window.
    const targetDay = dayOf(ts - w.days * 86_400) - 1;
    let base: Obs | undefined;
    for (let d = targetDay; d >= targetDay - BASELINE_WALK_DAYS; d--) {
      const nd = await context.NavDay.get(String(d));
      if (nd) {
        base = { ppsWad: nd.ppsClose, timestamp: nd.timestamp };
        break;
      }
    }
    const perf = base ? performance(cur, base) : undefined;
    if (w.key === "7d") {
      metrics.apy7d = perf?.apy;
      metrics.return7d = perf?.periodReturn;
    } else {
      metrics.apy30d = perf?.apy;
      metrics.return30d = perf?.periodReturn;
    }
  }
  const sinceFirst = first ? performance(cur, first) : undefined;
  metrics.apySinceInception = sinceFirst?.apy;

  await updateVault(context, event.srcAddress, () => ({
    navLower: p.navLower,
    navUpper: p.navUpper,
    ppsLower: p.ppsLower,
    supply: p.supply,
    lastNavTimestamp: ts,
    firstSnapshotPps: first ? first.ppsWad : p.ppsLower,
    firstSnapshotTimestamp: first ? first.timestamp : ts,
    ...metrics,
  }));

  await updateProtocol(context, event.block.number, () => ({ tvl: p.navLower }));
  await updateDaily(context, ts, (d) => ({
    tvlClose: p.navLower,
    ppsClose: p.ppsLower,
    ppsOpen: d.ppsOpen ?? p.ppsLower,
  }));

  if (p.settlement) {
    const v = await context.Vault.get(lc(event.srcAddress));
    if (v?.lastSettledEpoch !== undefined) {
      await updateEpoch(context, v.lastSettledEpoch, () => ({ ppsLower: p.ppsLower }));
    }
  }
});

// ------------------------------------------------------------------ fills (trades)

indexer.onEvent({ contract: "ConvergeVault", event: "Fill" }, async ({ event, context }) => {
  const ts = event.block.timestamp;
  const p = event.params;
  const marketId = lc(p.market);
  const k: SideKey = p.upToken ? "up" : "down";
  const action = p.vaultSells ? ("BUY" as const) : ("SELL" as const);
  const price = new BigDecimal(p.premium.toString()).div(new BigDecimal(p.units.toString())).dp(12);
  context.Trade.set({
    id: `${event.block.number}_${event.logIndex}`,
    market_id: marketId,
    side: p.upToken ? "UP" : "DOWN",
    action,
    size: p.units,
    premium: p.premium,
    price,
    taker: lc(p.taker),
    maker: lc(event.srcAddress),
    txHash: event.transaction.hash,
    block: event.block.number,
    timestamp: ts,
    logIndex: event.logIndex,
    vaultBasis: p.basis,
    vaultCash: p.cash,
  });

  const m = await context.Market.get(marketId);
  if (m) {
    const upPrice = p.upToken ? price : new BigDecimal(1).minus(price);
    context.Market.set({
      ...m,
      volume: m.volume + p.premium,
      tradeCount: m.tradeCount + 1,
      lastUpPrice: upPrice,
      vaultBasis: p.basis,
      vaultCash: p.cash,
    });
  } else {
    context.log.error(`Fill for unknown market ${marketId}`);
  }

  await updateVault(context, event.srcAddress, (v) => ({
    totalFillVolume: v.totalFillVolume + p.premium,
    fillCount: v.fillCount + 1,
  }));
  await updateProtocol(context, event.block.number, (s) => ({
    totalVolume: s.totalVolume + p.premium,
    totalTrades: s.totalTrades + 1,
  }));
  await updateDaily(context, ts, (d) => ({ volume: d.volume + p.premium, trades: d.trades + 1 }));

  const taker = lc(p.taker);
  const user = await touchUser(context, event.chainId, taker, ts, event.block.number);
  if (user) {
    const pos = await loadPosition(context, taker, marketId, ts);
    const before = positionState(pos);
    const after = p.vaultSells
      ? applyBuyFill(before, k, p.premium)
      : applySellFill(before, k, p.units, p.premium);
    savePosition(context, pos, after, ts);
    const u = (await context.User.get(taker)) ?? user;
    context.User.set({
      ...u,
      tradeCount: u.tradeCount + 1,
      volume: u.volume + p.premium,
      realizedPnl: u.realizedPnl + (after.realizedPnl - before.realizedPnl),
    });
  }
});

// ------------------------------------------------------------------ registry and inventory

indexer.onEvent(
  { contract: "ConvergeVault", event: "MarketRegistered" },
  async ({ event, context }) => {
    const m = await context.Market.get(lc(event.params.market));
    if (m) context.Market.set({ ...m, vaultRegistered: true });
  },
);

indexer.onEvent(
  { contract: "ConvergeVault", event: "MarketUnregistered" },
  async ({ event, context }) => {
    const m = await context.Market.get(lc(event.params.market));
    if (m) context.Market.set({ ...m, vaultRegistered: false });
  },
);

// ------------------------------------------------------------------ flags and configuration

indexer.onEvent(
  { contract: "ConvergeVault", event: "QuotingPaused" },
  async ({ event, context }) => {
    await updateVault(context, event.srcAddress, () => ({ quotingPaused: true }));
  },
);
indexer.onEvent(
  { contract: "ConvergeVault", event: "QuotingResumed" },
  async ({ event, context }) => {
    await updateVault(context, event.srcAddress, () => ({ quotingPaused: false }));
  },
);
indexer.onEvent(
  { contract: "ConvergeVault", event: "QuotingHalted" },
  async ({ event, context }) => {
    await updateVault(context, event.srcAddress, () => ({ quotingHalted: true }));
  },
);
indexer.onEvent(
  { contract: "ConvergeVault", event: "QuotingUnhalted" },
  async ({ event, context }) => {
    await updateVault(context, event.srcAddress, () => ({ quotingHalted: false }));
  },
);
indexer.onEvent(
  { contract: "ConvergeVault", event: "BreakerTripped" },
  async ({ event, context }) => {
    await updateVault(context, event.srcAddress, (v) => ({ breakerTrips: v.breakerTrips + 1 }));
  },
);
indexer.onEvent({ contract: "ConvergeVault", event: "TvlCapSet" }, async ({ event, context }) => {
  await updateVault(context, event.srcAddress, () => ({ tvlCap: event.params.cap }));
});
indexer.onEvent({ contract: "ConvergeVault", event: "FeeSet" }, async ({ event, context }) => {
  await updateVault(context, event.srcAddress, () => ({
    performanceFeeBps: Number(event.params.bps),
  }));
});
indexer.onEvent({ contract: "ConvergeVault", event: "KeeperSet" }, async ({ event, context }) => {
  await updateVault(context, event.srcAddress, () => ({ keeper: lc(event.params.keeper) }));
});
indexer.onEvent({ contract: "ConvergeVault", event: "VenueSet" }, async ({ event, context }) => {
  await updateVault(context, event.srcAddress, () => ({ venue: lc(event.params.venue) }));
});

// ------------------------------------------------------------------ share token (ERC-20)

indexer.onEvent({ contract: "ConvergeVault", event: "Transfer" }, async ({ event, context }) => {
  const { from, to, value } = event.params;
  const ts = event.block.timestamp;
  const mint = lc(from) === ZERO;
  const burn = lc(to) === ZERO;
  if (mint || burn) {
    await updateVault(context, event.srcAddress, (v) => ({
      totalSupply: v.totalSupply + (mint ? value : -value),
    }));
  }
  if (lc(from) === lc(to)) return;

  const fromReal = !mint && !isSystem(event.chainId, from);
  const toReal = !burn && !isSystem(event.chainId, to);
  const fromLp = fromReal ? await loadLp(context, from, ts) : undefined;
  const toLp = toReal ? await loadLp(context, to, ts) : undefined;
  let fromS = fromLp ? lpState(fromLp) : undefined;
  let toS = toLp ? lpState(toLp) : undefined;
  if (fromS && toS) [fromS, toS] = moveLpCost(fromS, toS, value);
  if (fromS) fromS = addShares(fromS, -value);
  if (toS) toS = addShares(toS, value);
  if (fromLp && fromS) saveLp(context, fromLp, fromS, ts);
  if (toLp && toS) saveLp(context, toLp, toS, ts);
});
