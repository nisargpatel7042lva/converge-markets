import { convergeVaultAbi } from "@converge/sdk";
import { NextResponse } from "next/server";
import { deployment } from "@/config/deployment";
import { publicClient } from "@/lib/chain";
import { indexerClient, nowSec, readRounds } from "@/lib/data";
import { computeStatus, type RoundSlot } from "@/lib/status";

export const dynamic = "force-dynamic";

/** Cached for a few seconds so a crowd (or an uptime checker) does not multiply RPC reads. */
let cache: { at: number; body: ReturnType<typeof computeStatus> } | null = null;
const TTL_MS = 5_000;

async function gather() {
  const now = nowSec();
  const [head, vault] = await Promise.all([
    publicClient.getBlock({ blockTag: "latest" }).then(
      (b) => Number(b.timestamp),
      () => null,
    ),
    Promise.all([
      publicClient.readContract({
        address: deployment.vault,
        abi: convergeVaultAbi,
        functionName: "quotingPaused",
      }),
      publicClient.readContract({
        address: deployment.vault,
        abi: convergeVaultAbi,
        functionName: "keeperHalt",
      }),
      publicClient
        .readContract({
          address: deployment.vault,
          abi: convergeVaultAbi,
          functionName: "currentEpoch",
        })
        .then((e) =>
          publicClient.readContract({
            address: deployment.vault,
            abi: convergeVaultAbi,
            functionName: "epochEnd",
            args: [e],
          }),
        ),
    ]).then(
      ([quotingPaused, quotingHalted, epochEnd]) => ({
        quotingPaused,
        quotingHalted,
        epochEnd: Number(epochEnd),
      }),
      () => null,
    ),
  ]);

  const rounds: RoundSlot[] = [];
  if (head !== null) {
    for (const s of deployment.series) {
      for (const duration of s.durations) {
        try {
          const found = await readRounds(s, duration, now, 1, 0);
          const cur = Math.floor(now / duration) * duration;
          rounds.push({
            label: s.name,
            duration,
            currentStart: cur,
            currentState: found.find((r) => r.start === cur)?.state ?? null,
            previousState: found.find((r) => r.start === cur - duration)?.state ?? null,
          });
        } catch {
          // an unreadable series counts as late, not as fine
          rounds.push({
            label: s.name,
            duration,
            currentStart: Math.floor(now / duration) * duration,
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
  return computeStatus({ now, headTimestamp: head, vault, rounds, indexerLagBlocks });
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
