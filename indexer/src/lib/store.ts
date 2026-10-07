/**
 * Entity helpers shared by the handlers: system-address checks, positions, users, daily and
 * all-time stats. Everything here is deterministic given the event stream (the handlers run twice:
 * preload, then for real).
 */
import {
  indexer,
  type DailyStats,
  type EvmOnEventContext,
  type LPPosition,
  type ProtocolStats,
  type User,
  type UserPosition,
} from "envio";
import { dayOf } from "./apy";
import { SYSTEM_ADDRESSES } from "./deployment-defaults";
import { costBasis, type PositionState } from "./position";
import type { LpState } from "./lp";

export type Ctx = EvmOnEventContext;

export const ZERO = "0x0000000000000000000000000000000000000000";
export const DEAD = "0x000000000000000000000000000000000000dead";
export const GLOBAL_ID = "global";

export const lc = (a: string): string => a.toLowerCase();

/**
 * Vault, venues, zero and the dead address: never users (no cost basis, no stats). The configured
 * vault and venue come from `indexer.chains`; a venue added later by a timelocked replacement
 * (VenueSet) is recorded in the SystemAddress entity.
 */
export async function isSystem(context: Ctx, chainId: number, address: string): Promise<boolean> {
  const a = lc(address);
  if (a === ZERO || a === DEAD) return true;
  if (SYSTEM_ADDRESSES[chainId]?.some((x) => x === a)) return true;
  const chain = indexer.chains[chainId as keyof typeof indexer.chains] as unknown as
    | {
        ConvergeVault?: { addresses: readonly string[] };
        ForwardVenue?: { addresses: readonly string[] };
      }
    | undefined;
  if (chain) {
    for (const c of [chain.ConvergeVault, chain.ForwardVenue]) {
      if (c?.addresses.some((x) => lc(x) === a)) return true;
    }
  }
  return (await context.SystemAddress.get(a)) !== undefined;
}

// ------------------------------------------------------------------ positions

export const positionId = (user: string, market: string): string => `${lc(user)}_${lc(market)}`;

export async function loadPosition(
  context: Ctx,
  user: string,
  market: string,
  ts: number,
): Promise<UserPosition> {
  return context.UserPosition.getOrCreate({
    id: positionId(user, market),
    user: lc(user),
    market_id: lc(market),
    upBalance: 0n,
    downBalance: 0n,
    upEscrowed: 0n,
    downEscrowed: 0n,
    upCost: 0n,
    downCost: 0n,
    costBasis: 0n,
    realizedPnl: 0n,
    totalIn: 0n,
    totalOut: 0n,
    tradeCount: 0,
    lastUpdated: ts,
  });
}

export const positionState = (p: UserPosition): PositionState => ({
  upBalance: p.upBalance,
  downBalance: p.downBalance,
  upEscrowed: p.upEscrowed,
  downEscrowed: p.downEscrowed,
  upCost: p.upCost,
  downCost: p.downCost,
  realizedPnl: p.realizedPnl,
  totalIn: p.totalIn,
  totalOut: p.totalOut,
  tradeCount: p.tradeCount,
});

export function savePosition(context: Ctx, p: UserPosition, s: PositionState, ts: number): void {
  context.UserPosition.set({ ...p, ...s, costBasis: costBasis(s), lastUpdated: ts });
}

// ------------------------------------------------------------------ LP positions

export async function loadLp(context: Ctx, user: string, ts: number): Promise<LPPosition> {
  return context.LPPosition.getOrCreate({
    id: lc(user),
    user: lc(user),
    shares: 0n,
    escrowedShares: 0n,
    costBasis: 0n,
    realizedPnl: 0n,
    totalDeposited: 0n,
    totalWithdrawn: 0n,
    lastUpdated: ts,
  });
}

export const lpState = (p: LPPosition): LpState => ({
  shares: p.shares,
  escrowedShares: p.escrowedShares,
  costBasis: p.costBasis,
  realizedPnl: p.realizedPnl,
  totalDeposited: p.totalDeposited,
  totalWithdrawn: p.totalWithdrawn,
});

export function saveLp(context: Ctx, p: LPPosition, s: LpState, ts: number): void {
  context.LPPosition.set({ ...p, ...s, lastUpdated: ts });
}

// ------------------------------------------------------------------ stats

export const zeroProtocol = (): ProtocolStats => ({
  id: GLOBAL_ID,
  totalVolume: 0n,
  totalTrades: 0,
  totalFeesPerformance: 0n,
  totalFeesRedeem: 0n,
  totalMarkets: 0,
  totalMarketsResolved: 0,
  totalUsers: 0,
  totalDeposited: 0n,
  totalRedeemed: 0n,
  tvl: 0n,
  vaultPps: 0n,
  lastUpdatedBlock: 0,
});

export async function updateProtocol(
  context: Ctx,
  block: number,
  fn: (p: ProtocolStats) => Partial<ProtocolStats>,
): Promise<void> {
  const p = (await context.ProtocolStats.get(GLOBAL_ID)) ?? zeroProtocol();
  context.ProtocolStats.set({ ...p, ...fn(p), lastUpdatedBlock: block });
}

export const zeroDaily = (day: number): DailyStats => ({
  id: String(day),
  day,
  date: new Date(day * 86_400_000).toISOString().slice(0, 10),
  volume: 0n,
  trades: 0,
  feesPerformance: 0n,
  feesRedeem: 0n,
  depositsAssets: 0n,
  redeemedAssets: 0n,
  tvlClose: 0n,
  ppsOpen: undefined,
  ppsClose: undefined,
  activeUsers: 0,
  newUsers: 0,
  marketsCreated: 0,
  marketsResolved: 0,
});

export async function updateDaily(
  context: Ctx,
  ts: number,
  fn: (d: DailyStats) => Partial<DailyStats>,
): Promise<void> {
  const day = dayOf(ts);
  let d = await context.DailyStats.get(String(day));
  if (!d) {
    // A day without a NAV snapshot carries the previous close forward (no false zero in charts).
    const p = await context.ProtocolStats.get(GLOBAL_ID);
    d = {
      ...zeroDaily(day),
      tvlClose: p?.tvl ?? 0n,
      ppsOpen: p && p.vaultPps > 0n ? p.vaultPps : undefined,
      ppsClose: p && p.vaultPps > 0n ? p.vaultPps : undefined,
    };
  }
  context.DailyStats.set({ ...d, ...fn(d) });
}

/** Creates the user on first sight (counts toward totals) and marks them active for the day. */
export async function touchUser(
  context: Ctx,
  chainId: number,
  address: string,
  ts: number,
  block: number,
): Promise<User | undefined> {
  if (await isSystem(context, chainId, address)) return undefined;
  const id = lc(address);
  let user = await context.User.get(id);
  let isNew = false;
  if (!user) {
    user = { id, firstSeen: ts, tradeCount: 0, volume: 0n, realizedPnl: 0n };
    context.User.set(user);
    isNew = true;
    await updateProtocol(context, block, (p) => ({ totalUsers: p.totalUsers + 1 }));
  }
  const markerId = `${dayOf(ts)}_${id}`;
  const seen = await context.DailyActiveUser.get(markerId);
  if (!seen) {
    context.DailyActiveUser.set({ id: markerId });
    await updateDaily(context, ts, (d) => ({
      activeUsers: d.activeUsers + 1,
      newUsers: d.newUsers + (isNew ? 1 : 0),
    }));
  } else if (isNew) {
    await updateDaily(context, ts, (d) => ({ newUsers: d.newUsers + 1 }));
  }
  return user;
}

export async function addUserPnl(context: Ctx, address: string, delta: bigint): Promise<void> {
  if (delta === 0n) return;
  const u = await context.User.get(lc(address));
  if (u) context.User.set({ ...u, realizedPnl: u.realizedPnl + delta });
}
