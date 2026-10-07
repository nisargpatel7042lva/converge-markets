/**
 * GraphQL latency harness for the app's main queries (the SDK's INDEXER_QUERIES documents, the same
 * strings the app runs). Measures the client-side round trip (fetch -> parsed JSON), sequentially
 * (one client) and concurrently (C clients), and reports p50/p95/p99/max per query.
 * Acceptance criterion 4: p95 < 300 ms for every main query.
 *
 * Usage: tsx latency.ts --indexer <graphql url> [--label local|hosted] [--n 200] [--concurrency 10]
 *                       [--headers name=value,...] [--api-key KEY] [--out docs/evidence/phase-6]
 * Env fallbacks: INDEXER_URL, INDEXER_HEADERS, INDEXER_API_KEY.
 * LOCAL runs (Hasura on this machine, tiny dataset) are labelled local and are NOT a hosted
 * measurement; run it against the hosted endpoint with --label hosted when one exists.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { INDEXER_QUERIES, indexerQuery, type GqlVariables } from "@converge/sdk";
import { opt, parseArgs, parseHeaders, summarize } from "./lib/common";
import { ROOT } from "./lib/chain";

const args = parseArgs(process.argv.slice(2));
const url = opt(args, "indexer", "INDEXER_URL", "http://localhost:8080/v1/graphql")!;
const headers = parseHeaders(opt(args, "headers", "INDEXER_HEADERS"));
const apiKey = opt(args, "api-key", "INDEXER_API_KEY");
const label = opt(args, "label", "LABEL", "local")!;
const N = Number(opt(args, "n", "N", "200"));
const C = Number(opt(args, "concurrency", "CONCURRENCY", "10"));
const WARM = Number(opt(args, "warmup", "WARMUP", "10"));
const outDir = resolve(opt(args, "out", "OUT_DIR", resolve(ROOT, "docs/evidence/phase-6"))!);
const THRESHOLD_MS = 300;

const o = { url, headers, apiKey, timeoutMs: 20_000 };
const q = <T>(query: string, v?: GqlVariables) => indexerQuery<T>(o, query, v);

interface Case {
  name: string;
  query: string;
  variables?: GqlVariables;
  /** Different variables per request (cycling through real ids) so caching of one document cannot flatter the result. */
  rotate?: (i: number) => GqlVariables;
}

async function discover(): Promise<Case[]> {
  const d = await q<{
    Market: { id: string }[];
    UserPosition: { user: string }[];
    LPPosition: { user: string }[];
    NavSnapshot: { timestamp: number }[];
    Order: { taker: string }[];
  }>(`{
    Market(where: {tradeCount: {_gt: 0}}, order_by: {tradeCount: desc}, limit: 100) { id }
    UserPosition(order_by: {tradeCount: desc}, limit: 200) { user }
    LPPosition(order_by: {totalDeposited: desc}, limit: 50) { user }
    NavSnapshot(order_by: {block: desc}, limit: 1) { timestamp }
    Order(limit: 1) { taker }
  }`);
  const none = "0x0000000000000000000000000000000000000000";
  const markets = d.Market.map((m) => m.id);
  const users = [...new Set(d.UserPosition.map((p) => p.user))];
  if (users.length === 0 && d.Order[0]) users.push(d.Order[0].taker);
  const lps = d.LPPosition.map((l) => l.user);
  const pickOf = (xs: string[]) => (i: number) => xs[i % Math.max(1, xs.length)] ?? none;
  const market = pickOf(markets);
  const user = pickOf(users);
  const lp = lps.length ? pickOf(lps) : user;
  const latest = d.NavSnapshot[0]?.timestamp ?? Math.floor(Date.now() / 1000);
  const Q = INDEXER_QUERIES;
  return [
    { name: "status (_meta)", query: Q.status },
    {
      name: "marketList open+created",
      query: Q.marketList,
      variables: { statuses: ["CREATED", "OPEN"], limit: 50, offset: 0 },
    },
    {
      name: "marketList by asset (BTC)",
      query: Q.marketListByAsset,
      variables: { statuses: ["CREATED", "OPEN"], asset: "BTC", limit: 50, offset: 0 },
    },
    {
      name: "marketList resolved (page of 50)",
      query: Q.marketList,
      variables: { statuses: ["RESOLVED_UP", "RESOLVED_DOWN", "INVALID"], limit: 50, offset: 0 },
    },
    {
      name: "marketDetail + 50 trades",
      query: Q.marketDetail,
      rotate: (i) => ({ id: market(i), trades: 50 }),
    },
    { name: "recentTrades 50", query: Q.recentTrades, variables: { limit: 50 } },
    { name: "userPositions", query: Q.userPositions, rotate: (i) => ({ user: user(i) }) },
    {
      name: "userTrades 50",
      query: Q.userTrades,
      rotate: (i) => ({ user: user(i), limit: 50, offset: 0 }),
    },
    { name: "userOrders 50", query: Q.userOrders, rotate: (i) => ({ user: user(i), limit: 50 }) },
    { name: "vaultOverview", query: Q.vaultOverview },
    {
      name: "navHistory 7d",
      query: Q.navHistory,
      variables: { since: latest - 7 * 86_400, limit: 1000 },
    },
    { name: "epochs 20", query: Q.epochs, variables: { limit: 20 } },
    { name: "lpOverview", query: Q.lpOverview, rotate: (i) => ({ user: lp(i) }) },
    { name: "dailyStats 30", query: Q.dailyStats, variables: { days: 30 } },
    { name: "protocolStats", query: Q.protocolStats },
  ];
}

let counter = 0;
async function timeOnce(c: Case): Promise<number> {
  const vars = c.rotate ? c.rotate(counter++) : c.variables;
  const t = performance.now();
  await q(c.query, vars);
  return performance.now() - t;
}

async function main() {
  console.log(`latency harness -> ${url} (label ${label}, n=${N}, concurrency=${C})`);
  const cases = await discover();
  const results: {
    name: string;
    sequential: ReturnType<typeof summarize>;
    concurrent: ReturnType<typeof summarize>;
  }[] = [];
  for (const c of cases) {
    for (let i = 0; i < WARM; i++) await timeOnce(c); // also fails fast if the query is rejected
    const seq: number[] = [];
    for (let i = 0; i < N; i++) seq.push(await timeOnce(c));
    const conc: number[] = [];
    let issued = 0;
    await Promise.all(
      Array.from({ length: C }, async () => {
        while (issued < N) {
          issued++;
          conc.push(await timeOnce(c));
        }
      }),
    );
    results.push({ name: c.name, sequential: summarize(seq), concurrent: summarize(conc) });
    console.log(
      `${c.name.padEnd(36)} seq p50 ${results.at(-1)!.sequential.p50.toFixed(1)} p95 ${results.at(-1)!.sequential.p95.toFixed(1)}  conc p95 ${results.at(-1)!.concurrent.p95.toFixed(1)} ms`,
    );
  }
  const worstSeq = Math.max(...results.map((r) => r.sequential.p95));
  const worstConc = Math.max(...results.map((r) => r.concurrent.p95));
  const pass = worstSeq < THRESHOLD_MS && worstConc < THRESHOLD_MS;

  const counts = await q<Record<string, { aggregate: { count: number } }>>(`{
    Market_aggregate { aggregate { count } } Trade_aggregate { aggregate { count } }
    UserPosition_aggregate { aggregate { count } } NavSnapshot_aggregate { aggregate { count } }
  }`).catch(() => undefined);

  mkdirSync(outDir, { recursive: true });
  const meta = {
    label,
    endpoint: url.replace(/\/\/[^/@]*@/, "//"),
    when: new Date().toISOString(),
    n: N,
    warmup: WARM,
    concurrency: C,
    thresholdMs: THRESHOLD_MS,
    worstSequentialP95: worstSeq,
    worstConcurrentP95: worstConc,
    pass,
    dataset: counts
      ? Object.fromEntries(
          Object.entries(counts).map(([k, v]) => [k.replace("_aggregate", ""), v.aggregate.count]),
        )
      : undefined,
  };
  writeFileSync(
    resolve(outDir, `latency-${label}.json`),
    JSON.stringify({ ...meta, results }, null, 2),
  );
  const f = (x: number) => x.toFixed(1);
  const md = [
    `# Indexer GraphQL latency (${label})`,
    "",
    `- Endpoint: \`${meta.endpoint}\`, run at ${meta.when}`,
    `- ${N} timed requests per query after ${WARM} warm-up requests; sequential = one client, concurrent = ${C} clients. Client-side round trip (fetch to parsed JSON).`,
    `- Dataset: ${meta.dataset ? JSON.stringify(meta.dataset) : "n/a"}`,
    label === "local"
      ? "- **LOCAL measurement**: Hasura + Postgres in Docker on the development machine, tiny dataset, no network. NOT a hosted measurement."
      : "- Hosted measurement (network round trip included).",
    `- Threshold: p95 < ${THRESHOLD_MS} ms for every query. Worst sequential p95 **${f(worstSeq)} ms**, worst concurrent p95 **${f(worstConc)} ms**: **${pass ? "PASS" : "FAIL"}**`,
    "",
    "| query | seq p50 | seq p95 | seq p99 | seq max | conc p50 | conc p95 | conc p99 |",
    "|---|---|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.name} | ${f(r.sequential.p50)} | ${f(r.sequential.p95)} | ${f(r.sequential.p99)} | ${f(r.sequential.max)} | ${f(r.concurrent.p50)} | ${f(r.concurrent.p95)} | ${f(r.concurrent.p99)} |`,
    ),
    "",
  ].join("\n");
  writeFileSync(resolve(outDir, `latency-${label}.md`), md);
  console.log(
    `${pass ? "PASS" : "FAIL"}: worst p95 sequential ${f(worstSeq)} ms, concurrent ${f(worstConc)} ms`,
  );
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
