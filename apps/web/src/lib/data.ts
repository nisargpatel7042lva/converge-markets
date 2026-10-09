import {
  convergeVaultAbi,
  createIndexerClient,
  forwardVenueAbi,
  marketAbi,
  marketFactoryAbi,
  mockErc20Abi,
  type IndexerClient,
} from "@converge/sdk";
import type { Address } from "viem";
import { deployment, env, type Series } from "@/config/deployment";
import { multicall, publicClient } from "./chain";

/** One round of one series, straight from the chain (no indexer needed). */
export type Round = {
  address: Address;
  series: Series;
  duration: number;
  start: number;
  end: number;
  /** Market.State: 0 CREATED, 1 OPEN, 2 RESOLVED_UP, 3 RESOLVED_DOWN, 4 INVALID. */
  state: number;
  /** Strike in the oracle's 18-decimal units; 0 until the round opens. */
  strike: bigint;
  endPrice: bigint;
  up: Address;
  down: Address;
  redeemFeeBps: number;
};

export { nowSec } from "./clock";

let indexer: IndexerClient | null = null;
export function indexerClient(): IndexerClient | null {
  if (!env.indexerUrl) return null;
  indexer ??= createIndexerClient({
    url: env.indexerUrl,
    ...(env.indexerKey ? { apiKey: env.indexerKey } : {}),
    timeoutMs: 8000,
  });
  return indexer;
}

const ZERO = "0x0000000000000000000000000000000000000000";

/** Round starts on the series' grid around `now`: some behind (to settle), some ahead (to join). */
export function gridStarts(duration: number, now: number, behind: number, ahead: number): number[] {
  const cur = Math.floor(now / duration) * duration;
  const out: number[] = [];
  for (let i = -behind; i <= ahead; i++) out.push(cur + i * duration);
  return out;
}

export async function readRounds(
  series: Series,
  duration: number,
  now: number,
  behind = 3,
  ahead = 2,
) {
  const starts = gridStarts(duration, now, behind, ahead);
  const addrs = await multicall({
    allowFailure: false,
    contracts: starts.map((s) => ({
      address: deployment.factory,
      abi: marketFactoryAbi,
      functionName: "getMarket" as const,
      args: [series.assetId, BigInt(duration), BigInt(s)] as const,
    })),
  });
  const existing = starts
    .map((start, i) => ({ start, address: addrs[i] as Address }))
    .filter((x) => x.address !== ZERO);
  if (existing.length === 0) return [];
  const calls = existing.flatMap((m) =>
    (["state", "strike", "endPrice", "up", "down", "redeemFeeBps"] as const).map((fn) => ({
      address: m.address,
      abi: marketAbi,
      functionName: fn,
    })),
  );
  const res = await multicall({ allowFailure: false, contracts: calls });
  return existing.map((m, i): Round => {
    const r = res.slice(i * 6, i * 6 + 6);
    return {
      address: m.address,
      series,
      duration,
      start: m.start,
      end: m.start + duration,
      state: Number(r[0]),
      strike: r[1] as bigint,
      endPrice: r[2] as bigint,
      up: r[3] as Address,
      down: r[4] as Address,
      redeemFeeBps: Number(r[5]),
    };
  });
}

export async function readAllRounds(now: number) {
  const lists = await Promise.all(
    deployment.series.flatMap((s) => s.durations.map((d) => readRounds(s, d, now))),
  );
  return lists.flat().sort((a, b) => a.start - b.start);
}

export async function readRound(address: Address): Promise<Round | null> {
  const [assetId, startTime, endTime, state, strike, endPrice, up, down, fee] = await multicall({
    allowFailure: false,
    contracts: (
      [
        "assetId",
        "startTime",
        "endTime",
        "state",
        "strike",
        "endPrice",
        "up",
        "down",
        "redeemFeeBps",
      ] as const
    ).map((fn) => ({ address, abi: marketAbi, functionName: fn })),
  });
  const series = deployment.series.find(
    (s) => s.assetId.toLowerCase() === String(assetId).toLowerCase(),
  );
  if (!series) return null;
  const start = Number(startTime);
  const end = Number(endTime);
  return {
    address,
    series,
    duration: end - start,
    start,
    end,
    state: Number(state),
    strike: strike as bigint,
    endPrice: endPrice as bigint,
    up: up as Address,
    down: down as Address,
    redeemFeeBps: Number(fee),
  };
}

export type Ladder = {
  quoting: boolean;
  fair: bigint;
  bids: { price: bigint; size: bigint }[];
  asks: { price: bigint; size: bigint }[];
};

/** The vault's UP ladder at `spot` (a float price), from the venue's own view function. */
export async function readLadder(market: Address, spot: number, at: number): Promise<Ladder> {
  const spot18 = BigInt(Math.round(spot * 1e8)) * 10n ** 10n;
  const q = await publicClient.readContract({
    address: deployment.venue,
    abi: forwardVenueAbi,
    functionName: "quoteAt",
    args: [market, spot18, BigInt(at)],
  });
  return {
    quoting: q.quoting,
    fair: q.fair,
    bids: q.bids.map((l) => ({ price: l.price, size: l.size })),
    asks: q.asks.map((l) => ({ price: l.price, size: l.size })),
  };
}

/** The keeper's volatility input for an asset, as a plain number (annualised); null if never set. */
export async function readSigma(assetId: `0x${string}`): Promise<number | null> {
  const cfg = (await publicClient.readContract({
    address: deployment.vault,
    abi: convergeVaultAbi,
    functionName: "assetCfg",
    args: [assetId],
  })) as readonly unknown[];
  const sigma = cfg[2] as bigint;
  return sigma === 0n ? null : Number(sigma) / 1e18;
}

export async function readBalances(user: Address) {
  const [usdc, native] = await Promise.all([
    publicClient.readContract({
      address: deployment.usdc,
      abi: mockErc20Abi,
      functionName: "balanceOf",
      args: [user],
    }),
    publicClient.getBalance({ address: user }),
  ]);
  return { usdc, native };
}

export type Holding = { round: Round; up: bigint; down: bigint };

export async function readHoldings(user: Address, rounds: Round[]): Promise<Holding[]> {
  if (rounds.length === 0) return [];
  const res = await multicall({
    allowFailure: false,
    contracts: rounds.flatMap((r) => [
      {
        address: r.up,
        abi: mockErc20Abi,
        functionName: "balanceOf" as const,
        args: [user] as const,
      },
      {
        address: r.down,
        abi: mockErc20Abi,
        functionName: "balanceOf" as const,
        args: [user] as const,
      },
    ]),
  });
  return rounds
    .map((round, i) => ({ round, up: res[i * 2] as bigint, down: res[i * 2 + 1] as bigint }))
    .filter((h) => h.up > 0n || h.down > 0n);
}

export type OrderResult = {
  status: "open" | "filled" | "unfilled" | "expired";
  filled?: bigint;
  premium?: bigint;
};

/** Public RPCs cap `eth_getLogs` ranges (Monad testnet: 100 blocks): ask in windows below that. */
const LOG_WINDOW = 90n;
const MAX_WINDOWS = 14; // about 8 minutes of 0.4 s blocks: an order is decided long before

/** Where an order stands: open, executed (and what it filled) or expired. */
export async function readOrderResult(id: bigint, fromBlock: bigint): Promise<OrderResult> {
  const o = await publicClient.readContract({
    address: deployment.venue,
    abi: forwardVenueAbi,
    functionName: "orders",
    args: [id],
  });
  if (Number(o[2]) !== 2) return { status: "open" };
  const head = await publicClient.getBlockNumber();
  // A single query from the placement block to now fails as soon as it spans more than the node's
  // limit (a slow passkey prompt is enough): that is how a decided bet used to look stuck. Windows
  // instead, oldest first (the decision is near the placement block).
  for (let w = 0, from = fromBlock; from <= head && w < MAX_WINDOWS; w++, from += LOG_WINDOW) {
    const to = from + LOG_WINDOW - 1n > head ? head : from + LOG_WINDOW - 1n;
    const logs = await publicClient.getContractEvents({
      address: deployment.venue,
      abi: forwardVenueAbi,
      fromBlock: from,
      toBlock: to,
      args: { id },
    });
    for (const l of logs) {
      if (l.eventName === "OrderExecuted") {
        const filled = l.args.filled ?? 0n;
        return {
          status: filled > 0n ? "filled" : "unfilled",
          filled,
          premium: l.args.premium ?? 0n,
        };
      }
      if (l.eventName === "OrderExpired") return { status: "expired" };
    }
  }
  return { status: "unfilled", filled: 0n, premium: 0n };
}

/** Markets by address (rounds older than the live window, found from this device's records or the indexer). */
export async function readRoundsByAddress(addresses: Address[]): Promise<Round[]> {
  const rounds = await Promise.all(addresses.map((a) => readRound(a).catch(() => null)));
  return rounds.filter((r): r is Round => r !== null);
}

export type OpenOrder = {
  id: bigint;
  market: Address;
  kind: number;
  shares: bigint;
  execAt: number;
  expired: boolean;
};

/** The venue's view of orders this device placed that are still OPEN, and whether they can be refunded. */
export async function readOpenOrders(ids: bigint[], now: number): Promise<OpenOrder[]> {
  if (ids.length === 0) return [];
  const [rows, lateness] = await Promise.all([
    multicall({
      allowFailure: false,
      contracts: ids.map((id) => ({
        address: deployment.venue,
        abi: forwardVenueAbi,
        functionName: "orders" as const,
        args: [id] as const,
      })),
    }),
    publicClient.readContract({
      address: deployment.venue,
      abi: forwardVenueAbi,
      functionName: "maxLateness",
    }),
  ]);
  return ids
    .map((id, i) => {
      const o = rows[i] as unknown as readonly [
        Address,
        number,
        number,
        number | bigint,
        Address,
        bigint,
      ];
      return {
        id,
        market: o[4],
        kind: Number(o[1]),
        shares: o[5],
        execAt: Number(o[3]),
        status: Number(o[2]),
        expired: now > Number(o[3]) + Number(lateness),
      };
    })
    .filter((o) => o.status === 1)
    .map(({ status: _s, ...o }) => {
      void _s;
      return o;
    });
}
