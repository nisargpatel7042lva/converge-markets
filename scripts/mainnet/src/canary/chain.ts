import { convergeVaultAbi, marketAbi, marketFactoryAbi } from "@converge/sdk";
import { parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import type { Deployment } from "../state";
import { expectedStarts, type NavSnapshot, type RoundObs, type SeriesSpec } from "./analysis";

const ZERO = "0x0000000000000000000000000000000000000000";
const openedEvent = parseAbiItem("event Opened(int256 strike)");
const resolvedEvent = parseAbiItem(
  "event Resolved(uint8 indexed outcome, int256 strike, int256 endPrice)",
);
const invalidatedEvent = parseAbiItem("event Invalidated(uint64 indexed boundary)");

/** Reads every round the scheduler was expected to run in [from, to], with its open / resolve times. */
export async function collectRounds(
  pub: PublicClient,
  dep: Deployment,
  series: SeriesSpec[],
  window: { from: number; to: number },
  fromBlock: bigint,
): Promise<RoundObs[]> {
  if (!dep.marketFactory) throw new Error("deployment has no factory");
  const factory = dep.marketFactory;
  const found: { series: string; duration: number; start: number; market: Address | null }[] = [];
  for (const s of series) {
    const assetId = dep.assets?.[s.label]?.assetId;
    if (!assetId) throw new Error(`${s.label} is not in the deployment`);
    for (const d of s.durations) {
      for (const start of expectedStarts(d, window.from, window.to)) {
        const m = (await pub.readContract({
          address: factory,
          abi: marketFactoryAbi,
          functionName: "getMarket",
          args: [assetId, BigInt(d), BigInt(start)],
        })) as Address;
        found.push({ series: s.label, duration: d, start, market: m === ZERO ? null : m });
      }
    }
  }
  const markets = found.flatMap((f) => (f.market ? [f.market] : []));
  const times = new Map<string, { opened?: bigint; resolved?: bigint }>();
  const blockTime = new Map<bigint, number>();
  const ts = async (b: bigint) => {
    if (!blockTime.has(b))
      blockTime.set(b, Number((await pub.getBlock({ blockNumber: b })).timestamp));
    return blockTime.get(b)!;
  };
  const note = (m: string, key: "opened" | "resolved", b: bigint) => {
    const e = times.get(m.toLowerCase()) ?? {};
    e[key] = b;
    times.set(m.toLowerCase(), e);
  };
  if (markets.length) {
    for (const [ev, key] of [
      [openedEvent, "opened"],
      [resolvedEvent, "resolved"],
      [invalidatedEvent, "resolved"],
    ] as const) {
      // 100-block log queries are a CRE limit, not an RPC one; page by 5,000 blocks for public RPCs
      const head = await pub.getBlockNumber();
      for (let from = fromBlock; from <= head; from += 5_000n) {
        const logs = await pub.getLogs({
          address: markets,
          event: ev as never,
          fromBlock: from,
          toBlock: from + 4_999n > head ? head : from + 4_999n,
        });
        for (const l of logs as unknown as { address: string; blockNumber: bigint }[]) {
          note(l.address, key, l.blockNumber);
        }
      }
    }
  }
  const out: RoundObs[] = [];
  for (const f of found) {
    if (!f.market) {
      out.push({
        series: f.series,
        duration: f.duration,
        start: f.start,
        created: false,
        state: null,
        openedAt: null,
        resolvedAt: null,
      });
      continue;
    }
    const state = Number(
      await pub.readContract({ address: f.market, abi: marketAbi, functionName: "state" }),
    );
    const t = times.get(f.market.toLowerCase()) ?? {};
    out.push({
      series: f.series,
      duration: f.duration,
      start: f.start,
      created: true,
      state,
      openedAt: t.opened !== undefined ? await ts(t.opened) : null,
      resolvedAt: t.resolved !== undefined ? await ts(t.resolved) : null,
    });
  }
  return out;
}

export async function readNav(pub: PublicClient, vault: Address): Promise<NavSnapshot> {
  const r = (fn: string) =>
    pub.readContract({
      address: vault,
      abi: convergeVaultAbi,
      functionName: fn as never,
    }) as Promise<bigint>;
  const [navLower, navUpper, pps, supply, block] = await Promise.all([
    r("quoteNavLower"),
    r("lastNavUpper"),
    r("pricePerShareLower"),
    r("totalSupply"),
    pub.getBlock(),
  ]);
  return { at: Number(block.timestamp), navLower, navUpper, pps, supply };
}

export const hexOf = (x: string): Hex => x as Hex;
