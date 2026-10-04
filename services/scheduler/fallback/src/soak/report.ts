/**
 * Soak analysis from ONCHAIN events only (not scheduler logs): for every round of every series
 * that started after go-live and ended before `--until`, checks it was created ahead of its start,
 * opened and resolved, and measures delays from block timestamps.
 * Usage: npx tsx src/soak/report.ts [outFile]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assetIdOf, marketAbi, marketFactoryAbi } from "@converge/sdk";
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { foundry } from "viem/chains";
import { devnetSeriesConfig } from "../devnet";

const ROOT = resolve(process.cwd(), "../../..");
const dev = JSON.parse(readFileSync(resolve(ROOT, ".soak/devnet.json"), "utf8")) as {
  rpc: string;
  factory: Address;
  streamsResolver: Address;
  epoch: number;
};
const out = process.argv[2] ?? resolve(ROOT, "docs/evidence/phase-2/soak-local.md");
const chainHead = (
  await createPublicClient({ chain: foundry, transport: http(dev.rpc) }).getBlock()
).timestamp;
const pub = createPublicClient({ chain: foundry, transport: http(dev.rpc) });
const config = devnetSeriesConfig();
const head = await pub.getBlock();
// SOAK_UNTIL (unix seconds) restricts the analysis to a continuous window (e.g. before a host
// suspend); default: chain head.
const now = process.env.SOAK_UNTIL ? BigInt(process.env.SOAK_UNTIL) : head.timestamp;
const epoch = BigInt(dev.epoch);
const ts = new Map<bigint, bigint>();
const tsOf = async (bn: bigint) => {
  if (!ts.has(bn)) ts.set(bn, (await pub.getBlock({ blockNumber: bn })).timestamp);
  return ts.get(bn)!;
};
const created = await pub.getLogs({
  address: dev.factory,
  event: parseAbiItem(
    "event MarketCreated(address indexed market, bytes32 indexed assetId, uint64 indexed startTime, uint64 duration, (address factory, bytes32 assetId, address resolver, address collateral, address up, address down, uint64 startTime, uint64 endTime, uint16 redeemFeeBps) params)",
  ),
  fromBlock: 0n,
});
const proposed = await pub.getLogs({
  address: dev.streamsResolver,
  event: parseAbiItem(
    "event ReportProposed(bytes32 indexed assetId, uint64 indexed timestamp, int192 price, uint32 validFromTimestamp, uint32 observationsTimestamp, bytes32 reportHash, bool replaced)",
  ),
  fromBlock: 0n,
});

type Row = {
  asset: string;
  series: string;
  start: bigint;
  createdAhead: number | null;
  openDelay: number | null;
  resolveDelay: number | null;
  proposeDelay: number | null;
  state: number;
};
const rows: Row[] = [];
for (const a of config.assets) {
  for (const d of a.durations ?? config.durations) {
    const dur = BigInt(d);
    for (let s = epoch - (epoch % dur) + dur; s + dur + 120n <= now; s += dur) {
      const m = (await pub.readContract({
        address: dev.factory,
        abi: marketFactoryAbi,
        functionName: "getMarket",
        args: [assetIdOf(a.label), dur, s],
      })) as Address;
      const log = created.find((l) => l.args.market?.toLowerCase() === m.toLowerCase());
      const row: Row = {
        asset: a.label,
        series: `${d / 60}m`,
        start: s,
        createdAhead: null,
        openDelay: null,
        resolveDelay: null,
        proposeDelay: null,
        state: -1,
      };
      if (log) row.createdAhead = Number(s - (await tsOf(log.blockNumber!)));
      if (log) {
        row.state = Number(
          await pub.readContract({ address: m, abi: marketAbi, functionName: "state" }),
        );
        const o = await pub.getLogs({
          address: m,
          event: parseAbiItem("event Opened(int256 strike)"),
          fromBlock: log.blockNumber!,
        });
        const r = await pub.getLogs({
          address: m,
          event: parseAbiItem(
            "event Resolved(uint8 indexed outcome, int256 strike, int256 endPrice)",
          ),
          fromBlock: log.blockNumber!,
        });
        if (o[0]) row.openDelay = Number((await tsOf(o[0].blockNumber!)) - s);
        if (r[0]) row.resolveDelay = Number((await tsOf(r[0].blockNumber!)) - (s + dur));
        if (a.resolver === "streams") {
          const p = proposed.find(
            (x) =>
              x.args.assetId === assetIdOf(a.label) &&
              x.args.timestamp === s + dur &&
              !x.args.replaced,
          );
          if (p) row.proposeDelay = Number((await tsOf(p.blockNumber!)) - (s + dur));
        }
      }
      rows.push(row);
    }
  }
}
const ok = (r: Row) =>
  r.createdAhead !== null &&
  r.createdAhead > 0 &&
  r.openDelay !== null &&
  r.resolveDelay !== null &&
  (r.state === 2 || r.state === 3);
const pick = (f: (r: Row) => number | null) => rows.map(f).filter((x): x is number => x !== null);
const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null);
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const summary = {
  windowStartUtc: new Date(Number(epoch) * 1000).toISOString(),
  windowEndUtc: new Date(Number(now) * 1000).toISOString(),
  hours: Number(now - epoch) / 3600,
  rounds: rows.length,
  complete: rows.filter(ok).length,
  missed: rows.filter((r) => !ok(r)).length,
  minCreatedAheadSeconds: Math.min(...pick((r) => r.createdAhead)),
  maxOpenDelaySeconds: max(pick((r) => r.openDelay)),
  maxResolveDelaySeconds: max(pick((r) => r.resolveDelay)),
  p95ResolveDelaySeconds: pct(
    pick((r) => r.resolveDelay),
    95,
  ),
  maxStreamsProposalDelaySeconds: max(pick((r) => r.proposeDelay)),
};
const md = [
  "# Phase 2 soak (local real-time chain, LABELLED MOCK FEEDS)",
  "",
  "Generated by `services/scheduler/fallback/src/soak/report.ts` from onchain events only.",
  "",
  "**Setup:**",
  "",
  "- anvil with 1 s real-time blocks, chain id 31337, Phase 1 contracts and SchedulerReceiver (`src/soak/up.ts`).",
  "- The fallback scheduler ran in Docker (`docker-compose.yml`) as the onchain leader, with a 10 s loop.",
  "",
  "**Feeds (LABELLED MOCK FEEDS):**",
  "",
  "- MON/USD: the local MockAggregator is fed by `mon-mirror.ts` with every new Chainlink MON/USD round from Monad mainnet (real prices, real ~30 s cadence).",
  "- BTC/ETH: Data Streams-shaped reports signed by the TEST signer (MockStreamsVerifierProxy, 20 s finalization window), priced from Chainlink BTC/USD and ETH/USD on Monad mainnet.",
  "",
  "**Delay definitions:**",
  "",
  "- open = Opened block time − start; resolve = Resolved block time − end.",
  "- Streams proposal = the first ReportProposed block time − end. That is when settlement evidence landed; the round becomes final after the finalization window.",
  "",
  "```json",
  JSON.stringify(summary, null, 2),
  "```",
  "",
  "| asset | series | start (UTC) | created s ahead | open delay s | streams proposal delay s | resolve delay s | state |",
  "|---|---|---|---|---|---|---|---|",
  ...rows.map(
    (r) =>
      `| ${r.asset} | ${r.series} | ${new Date(Number(r.start) * 1000).toISOString().slice(11, 16)} | ${r.createdAhead ?? "MISSING"} | ${r.openDelay ?? "-"} | ${r.proposeDelay ?? "-"} | ${r.resolveDelay ?? "-"} | ${["CREATED", "OPEN", "UP", "DOWN", "INVALID"][r.state] ?? "MISSING"} |`,
  ),
].join("\n");
writeFileSync(out, md + "\n");
console.log(JSON.stringify(summary));
