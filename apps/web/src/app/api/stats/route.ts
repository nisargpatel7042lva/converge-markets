import { NextResponse } from "next/server";
import { parseAbiItem, type Address } from "viem";
import { convergeVaultAbi, marketAbi, marketFactoryAbi } from "@converge/sdk";
import { deployment } from "@/config/deployment";
import snapshot from "@/config/stats-snapshot.json";
import { multicall, publicClient } from "@/lib/chain";

/**
 * The numbers a judge asks for, derived from the chain with no indexer: money in the vault, share value and the
 * return since launch, rounds settled, how reliably rounds settled, and all-time traded volume (a committed log-scan
 * snapshot, topped up here with the blocks since). Cached for a minute. Every figure says how it was measured.
 */
export const dynamic = "force-dynamic";
const TTL_MS = 60_000;
let cache: { at: number; body: unknown } | null = null;

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
  const addrs: { start: number; a: Address }[] = [];
  for (const part of chunks(starts, 120)) {
    const r = (await multicall({
      allowFailure: false,
      contracts: part.map((s) => ({
        address: deployment.factory,
        abi: marketFactoryAbi,
        functionName: "getMarket" as const,
        args: [asset, BigInt(DURATION), BigInt(s)] as const,
      })),
    })) as Address[];
    part.forEach((s, i) => r[i] !== ZERO && addrs.push({ start: s, a: r[i]! }));
  }
  const states: number[] = [];
  for (const part of chunks(addrs, 120)) {
    const r = (await multicall({
      allowFailure: false,
      contracts: part.map((x) => ({
        address: x.a,
        abi: marketAbi,
        functionName: "state" as const,
      })),
    })) as number[];
    states.push(...r.map(Number));
  }
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

export async function GET() {
  if (cache && Date.now() - cache.at < TTL_MS) return NextResponse.json(cache.body);
  try {
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
    return NextResponse.json(body);
  } catch (e) {
    if (cache) return NextResponse.json(cache.body);
    return NextResponse.json(
      { error: String(e instanceof Error ? e.message : e).slice(0, 200) },
      { status: 503 },
    );
  }
}
