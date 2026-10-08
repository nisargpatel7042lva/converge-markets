import { convergeVaultAbi } from "@converge/sdk";
import { NextResponse } from "next/server";
import { deployment } from "@/config/deployment";
import { publicClient } from "@/lib/chain";
import { indexerClient, nowSec, readRounds } from "@/lib/data";
import { computeStatus, type RoundSlot, type StatusInput } from "@/lib/status";

export const dynamic = "force-dynamic";

/** Cached for a few seconds so a crowd (or an uptime checker) does not multiply RPC reads. */
let cache: { at: number; body: ReturnType<typeof computeStatus> } | null = null;
const TTL_MS = 5_000;
/** Rounds this far back are checked for being stuck unresolved (one that is blocks every settlement). */
const LOOKBACK_SLOTS = 4;

type VaultRead = NonNullable<StatusInput["vault"]>;

async function readVault(): Promise<VaultRead | null> {
  const v = deployment.vault;
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    publicClient.readContract({
      address: v,
      abi: convergeVaultAbi,
      functionName,
      args,
    } as never) as Promise<T>;
  try {
    const [quotingPaused, quotingHalted, epoch, navUpdatedAt] = await Promise.all([
      read<boolean>("quotingPaused"),
      read<boolean>("keeperHalt"),
      read<bigint>("currentEpoch"),
      read<bigint>("navUpdatedAt"),
    ]);
    let previousEpoch: VaultRead["previousEpoch"] = null;
    if (epoch > 0n) {
      const [end, e] = await Promise.all([
        read<bigint>("epochEnd", [epoch - 1n]),
        read<readonly unknown[]>("epochs", [epoch - 1n]),
      ]);
      // Epoch: depositAssets, redeemShares, settled, depositRejected, ...
      previousEpoch = {
        end: Number(end),
        hadRequests: BigInt(e[0] as bigint) > 0n || BigInt(e[1] as bigint) > 0n,
        settled: Boolean(e[2]),
      };
    }
    const sigmaUpdatedAt: number[] = [];
    const n = deployment.series.length;
    for (const s of deployment.series.slice(0, n)) {
      const cfg = await read<readonly unknown[]>("assetCfg", [s.assetId]);
      // AssetCfg: enabled, feedId, sigma, sigmaUpdatedAt, ...
      sigmaUpdatedAt.push(cfg[2] === 0n ? 0 : Number(cfg[3]));
    }
    return {
      quotingPaused,
      quotingHalted,
      previousEpoch,
      navUpdatedAt: Number(navUpdatedAt),
      sigmaUpdatedAt,
    };
  } catch {
    return null;
  }
}

async function gather() {
  const wall = nowSec();
  const [head, vault] = await Promise.all([
    publicClient.getBlock({ blockTag: "latest" }).then(
      (b) => Number(b.timestamp),
      () => null,
    ),
    readVault(),
  ]);
  // On a real chain the head trails the clock, so the clock wins; on a local demo chain whose clock
  // was moved ahead, the chain's own time is the one the rounds follow.
  const now = head !== null && head > wall ? head : wall;

  const rounds: RoundSlot[] = [];
  let staleOpenRounds = 0;
  if (head !== null) {
    for (const s of deployment.series) {
      for (const duration of s.durations) {
        const cur = Math.floor(now / duration) * duration;
        try {
          const found = await readRounds(s, duration, now, LOOKBACK_SLOTS, 0);
          rounds.push({
            label: s.name,
            duration,
            currentStart: cur,
            currentState: found.find((r) => r.start === cur)?.state ?? null,
            previousState: found.find((r) => r.start === cur - duration)?.state ?? null,
          });
          // an old round still CREATED or OPEN long after its end is stuck
          staleOpenRounds += found.filter(
            (r) => r.start + duration + 300 < now && (r.state === 0 || r.state === 1),
          ).length;
        } catch {
          // an unreadable series counts as late, not as fine
          rounds.push({
            label: s.name,
            duration,
            currentStart: cur,
            currentState: null,
            previousState: null,
          });
        }
      }
    }
  }

  let indexerLagBlocks: number | null | undefined;
  const ix = indexerClient();
  if (ix) {
    indexerLagBlocks = await ix.status().then(
      (st) => (st[0] ? st[0].sourceBlock - st[0].progressBlock : null),
      () => null,
    );
  }
  return computeStatus({
    now,
    headTimestamp: head,
    vault,
    rounds,
    staleOpenRounds,
    indexerLagBlocks,
  });
}

export async function GET() {
  const t = Date.now();
  if (!cache || t - cache.at > TTL_MS) {
    const body = await gather().catch(() =>
      computeStatus({
        now: nowSec(),
        headTimestamp: null,
        vault: null,
        rounds: [],
        staleOpenRounds: 0,
        indexerLagBlocks: undefined,
      }),
    );
    cache = { at: t, body };
  }
  // 503 when down so an uptime checker can use the status code; the body is the same either way
  return NextResponse.json(cache.body, {
    status: cache.body.level === "down" ? 503 : 200,
    headers: { "cache-control": "public, max-age=5" },
  });
}
