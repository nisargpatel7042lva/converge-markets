/**
 * Canary report. Two steps:
 *   canary:report --start     records the vault's state and the start time (run it when the canary begins,
 *                             after the seed deposit has settled)
 *   canary:report [--min-hours 12]
 *                             reads the chain and the trader's log, judges the run and writes
 *                             docs/evidence/phase-9/canary/report.{json,md}
 * The verdict is computed (analysis.ts), never typed by hand: it fails when the run is shorter than
 * the minimum, when a round was missed, a claim failed or an order was stuck.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createPublicClient, defineChain, http } from "viem";
import { repoRoot } from "../params";
import type { Deployment } from "../state";
import {
  judgeRounds,
  judgeTrades,
  overall,
  pnl,
  type NavSnapshot,
  type SeriesSpec,
} from "./analysis";
import { collectRounds, readNav } from "./chain";
import { LOG, readLog } from "./trader";

const DIR = resolve(repoRoot, "docs/evidence/phase-9/canary");
const START = resolve(DIR, "start.json");

const ser = (n: NavSnapshot) => ({
  ...n,
  navLower: n.navLower.toString(),
  navUpper: n.navUpper.toString(),
  pps: n.pps.toString(),
  supply: n.supply.toString(),
});
const de = (j: Record<string, string | number>): NavSnapshot => ({
  at: Number(j.at),
  navLower: BigInt(j.navLower!),
  navUpper: BigInt(j.navUpper!),
  pps: BigInt(j.pps!),
  supply: BigInt(j.supply!),
});

async function main() {
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error("RPC_URL is required");
  const network = process.env.NETWORK ?? "mainnet";
  const dep = JSON.parse(
    readFileSync(resolve(repoRoot, "deployments", `${network}.json`), "utf8"),
  ) as Deployment;
  const chain = defineChain({
    id: dep.chainId,
    name: "monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const pub = createPublicClient({ chain, transport: http(rpc) });
  mkdirSync(DIR, { recursive: true });

  if (process.argv.includes("--start")) {
    const nav = await readNav(pub, dep.vault!.vault);
    const block = await pub.getBlockNumber();
    writeFileSync(
      START,
      JSON.stringify({ nav: ser(nav), block: block.toString() }, null, 2) + "\n",
    );
    console.log(
      `canary start recorded: pps ${Number(nav.pps) / 1e18}, NAV ${Number(nav.navLower) / 1e6} USDC, block ${block}`,
    );
    return;
  }
  if (!existsSync(START)) throw new Error("run with --start first");
  const start = JSON.parse(readFileSync(START, "utf8")) as {
    nav: Record<string, string | number>;
    block: string;
  };
  const navStart = de(start.nav);
  const navEnd = await readNav(pub, dep.vault!.vault);
  const mi = process.argv.indexOf("--min-hours");
  const minHours = mi > 0 ? Number(process.argv[mi + 1]) : 12;

  const cfg = JSON.parse(readFileSync(resolve(repoRoot, "config/series.json"), "utf8")) as {
    durations: number[];
  };
  const series: SeriesSpec[] = Object.entries(dep.assets ?? {})
    .filter(([, a]) => a.kind === "streams")
    .map(([label]) => ({ label, durations: cfg.durations }));
  const window = { from: navStart.at + 120, to: navEnd.at - 1800 }; // let the first round settle in and the last ones resolve
  const rounds = judgeRounds(
    await collectRounds(pub, dep, series, window, BigInt(start.block)),
    series,
    window,
  );
  const trades = judgeTrades(readLog(), navEnd.at);
  const hours = (navEnd.at - navStart.at) / 3600;
  const verdict = overall(hours, minHours, rounds, trades);
  const p = pnl(navStart, navEnd);

  const out = {
    network,
    generatedAt: new Date().toISOString(),
    hours,
    window,
    verdict,
    rounds,
    trades: {
      ...trades,
      stuckOrders: trades.stuckOrders.length,
      failedClaims: trades.failedClaims.length,
      pendingClaims: trades.pendingClaims.length,
    },
    pnl: p,
    log: LOG,
  };
  mkdirSync(dirname(START), { recursive: true });
  writeFileSync(resolve(DIR, "report.json"), JSON.stringify(out, null, 2) + "\n");
  const md = [
    `# Canary report (${network})`,
    ``,
    `Verdict: **${verdict.pass ? "PASS" : "FAIL"}**${verdict.reasons.length ? ` (${verdict.reasons.join("; ")})` : ""}`,
    ``,
    `| Measure | Value |`,
    `| --- | --- |`,
    `| Duration | ${hours.toFixed(2)} h (minimum ${minHours} h) |`,
    `| Rounds expected | ${rounds.expected} |`,
    `| Rounds resolved on time | ${rounds.resolved} |`,
    `| Rounds missed | ${rounds.missed.length} (invalid: ${rounds.invalid}) |`,
    `| Orders placed / executed / expired | ${trades.placed} / ${trades.executed} / ${trades.expired} |`,
    `| Stuck orders (keeper missed) | ${trades.stuckOrders.length} |`,
    `| Failed claims | ${trades.failedClaims.length} |`,
    `| Claims still pending | ${trades.pendingClaims.length} |`,
    `| Share price (lower) start -> end | ${p.ppsStart.toFixed(6)} -> ${p.ppsEnd.toFixed(6)} (${(p.ppsChange * 100).toFixed(3)} %) |`,
    `| Vault NAV (lower) start -> end | ${p.navLowerStartUsdc.toFixed(2)} -> ${p.navLowerEndUsdc.toFixed(2)} USDC |`,
    ``,
    p.note,
    ``,
    ...(rounds.missed.length
      ? [
          `## Missed rounds`,
          ...rounds.missed.map((m) => `- ${m.series} ${m.duration}s start ${m.start}: ${m.reason}`),
        ]
      : []),
  ].join("\n");
  writeFileSync(resolve(DIR, "report.md"), md + "\n");
  console.log(md);
  if (!verdict.pass) process.exit(1);
}

if (process.argv[1]?.endsWith("report.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
