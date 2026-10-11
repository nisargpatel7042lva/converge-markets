import { NextResponse } from "next/server";
import { parseAbiItem, type Address } from "viem";
import { convergeVaultAbi, marketAbi, marketFactoryAbi } from "@converge/sdk";
import { deployment } from "@/config/deployment";
import snapshot from "@/config/stats-snapshot.json";
import { createPublicClient, http } from "viem";
import { chain } from "@/lib/chain";

/**
 * The numbers a judge asks for, derived from the chain with no indexer: money in the vault, share value and the
 * return since launch, rounds settled, how reliably rounds settled, and all-time traded volume (a committed log-scan
 * snapshot, topped up here with the blocks since). Cached for a minute. Every figure says how it was measured.
 */
export const dynamic = "force-dynamic";
const TTL_MS = 60_000;
let cache: { at: number; body: unknown } | null = null;

/**
 * This route's own client: the public testnet RPC allows about 15 requests a second per address and the keeper and the
 * app share that, so the retries wait long enough (about 0.6 s, doubling) for the limit to clear, and the calls below
 * run two at a time.
 */
const publicClient = createPublicClient({
  chain,
  transport: http(deployment.rpcUrl, { retryCount: 6, retryDelay: 600 }),
});
const multicall = (args: { allowFailure: false; contracts: readonly unknown[] }) =>
  deployment.multicall3
    ? publicClient.multicall(args as Parameters<typeof publicClient.multicall>[0])
    : Promise.all(args.contracts.map((c) => publicClient.readContract(c as never)));
async function limited<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const DURATION = 900;
const ORDER_EXECUTED = parseAbiItem(
  "event OrderExecuted(uint256 indexed id, address indexed executor, uint256 filled, uint256 premium, uint256 reportPrice, uint32 reportValidFrom, uint32 reportObservations)",
);
const chunks = <T>(xs: T[], n: number) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

async function compute() {
  const asset = deployment.series[0]!.assetId;
  const head = await publicClient.getBlock();
  const now = Number(head.timestamp);

  // vault: money in, share value, return since launch
  const [nav, supply, cap] = await Promise.all([
    publicClient.readContract({
      address: deployment.vault,
      abi: convergeVaultAbi,
      functionName: "quoteNavLower",
    }),
    publicClient.readContract({
      address: deployment.vault,
      abi: convergeVaultAbi,
      functionName: "totalSupply",
    }),
    publicClient.readContract({
      address: deployment.vault,
      abi: convergeVaultAbi,
      functionName: "tvlCap",
    }),
  ]);
  const launch = await publicClient.getBlock({ blockNumber: BigInt(deployment.deployBlock ?? 0) });
  const launchTs = Number(launch.timestamp);
  const pps = supply > 0n ? Number(nav) / Number(supply) : 1; // both 6 decimals; the vault starts at 1.00 a share
  const days = Math.max((now - launchTs) / 86_400, 1 / 86_400);
  const sinceLaunch = pps - 1;
  const annualised = pps > 0 ? Math.pow(pps, 365 / days) - 1 : null;

  // rounds: every 15-minute slot from the factory's deploy to now
  const fBlock = await publicClient.getBlock({
    blockNumber: BigInt(deployment.factoryDeployBlock ?? deployment.deployBlock ?? 0),
  });
  const first = Math.ceil(Number(fBlock.timestamp) / DURATION) * DURATION;
  const starts: number[] = [];
  for (let s = first; s <= now - DURATION; s += DURATION) starts.push(s);
  // chunks run in parallel: ten calls in a row to the public RPC took twenty seconds on a cold cache
  const found = await limited(chunks(starts, 200), 2, async (part) => {
    const r = (await multicall({
      allowFailure: false,
      contracts: part.map((s) => ({
        address: deployment.factory,
        abi: marketFactoryAbi,
        functionName: "getMarket" as const,
        args: [asset, BigInt(DURATION), BigInt(s)] as const,
      })),
    })) as Address[];
    return part.flatMap((s, i) => (r[i] !== ZERO ? [{ start: s, a: r[i]! }] : []));
  });
  const addrs: { start: number; a: Address }[] = found.flat();
  const states: number[] = (
    await limited(chunks(addrs, 200), 2, async (part) => {
      const r = (await multicall({
        allowFailure: false,
        contracts: part.map((x) => ({
          address: x.a,
          abi: marketAbi,
          functionName: "state" as const,
        })),
      })) as number[];
      return r.map(Number);
    })
  ).flat();
  let resolved = 0,
    invalid = 0,
    stuck = 0,
    open = 0;
  addrs.forEach((x, i) => {
    const s = states[i]!;
    const over = now >= x.start + DURATION + 300; // five minutes of grace to settle
    if (s === 2 || s === 3) resolved += 1;
    else if (s === 4) invalid += 1;
    else if (over) stuck += 1;
    else open += 1;
  });
  const due = resolved + invalid + stuck;

  // volume: the committed scan, plus the blocks since (bounded, so a request stays fast)
  // the snapshot belongs to one venue; on any other deployment (a local chain, a redeploy) start from its own deploy block
  const usable =
    snapshot.venue.toLowerCase() === deployment.venue.toLowerCase() &&
    snapshot.chainId === deployment.chainId;
  let volume = usable ? BigInt(snapshot.volumeUsd6) : 0n;
  let trades = usable ? snapshot.trades : 0;
  let executed = usable ? snapshot.executed : 0;
  const sinceBlock = usable ? snapshot.fromBlock : (deployment.deployBlock ?? 0);
  let upTo = usable ? snapshot.toBlock : sinceBlock - 1;
  const headNum = Number(head.number);
  try {
    let from = upTo + 1;
    let n = 0;
    while (from <= headNum - 2 && n < 6) {
      const to = Math.min(from + 99, headNum - 2);
      const logs = await publicClient.getLogs({
        address: deployment.venue,
        event: ORDER_EXECUTED,
        fromBlock: BigInt(from),
        toBlock: BigInt(to),
      });
      for (const l of logs) {
        executed += 1;
        if (l.args.filled! > 0n) {
          trades += 1;
          volume += l.args.premium!;
        }
      }
      upTo = to;
      from = to + 1;
      n += 1;
    }
  } catch {
    // keep the snapshot figures
  }

  return {
    asOf: new Date().toISOString(),
    block: headNum,
    vault: {
      navUsd: Number(nav) / 1e6,
      capUsd: Number(cap) / 1e6,
      sharePrice: pps,
      launchedAt: new Date(launchTs * 1000).toISOString(),
      days,
      returnSinceLaunch: sinceLaunch,
      annualisedReturn: annualised,
    },
    rounds: {
      total: addrs.length,
      slots: starts.length,
      neverCreated: starts.length - addrs.length,
      resolved,
      invalid,
      stuck,
      open,
      since: new Date(first * 1000).toISOString(),
    },
    uptime: starts.length > 0 ? resolved / starts.length : null,
    reliability: due > 0 ? resolved / due : null,
    volume: {
      usd: Number(volume) / 1e6,
      trades,
      executedOrders: executed,
      scannedToBlock: upTo,
      behindBlocks: headNum - upTo,
      since: sinceBlock,
      scope: "the current venue only (testnet, play money)",
    },
  };
}

let refreshing: Promise<void> | null = null;
async function refresh() {
  let body: Awaited<ReturnType<typeof compute>> | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      body = await compute();
      break;
    } catch (e) {
      // the public testnet RPC answers 429 under bursts: wait and try again before giving up
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  cache = { at: Date.now(), body };
}

/** Stale while revalidate: a request is answered from the last good reading at once; a reading older than the TTL is refreshed behind it. */
export async function GET() {
  if (cache) {
    if (Date.now() - cache.at >= TTL_MS && !refreshing)
      refreshing = refresh()
        .catch(() => undefined)
        .finally(() => (refreshing = null));
    return NextResponse.json(cache.body);
  }
  try {
    refreshing ??= refresh().finally(() => (refreshing = null));
    await refreshing;
    const got = cache as { at: number; body: unknown } | null; // set by refresh(), which TS cannot see from here
    return NextResponse.json(got?.body ?? { error: "no data" });
  } catch (e) {
    return NextResponse.json(
      { error: String(e instanceof Error ? e.message : e).slice(0, 200) },
      { status: 503 },
    );
  }
}
