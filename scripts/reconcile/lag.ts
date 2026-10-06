/**
 * Indexer lag monitor. Polls the indexer's `_meta` (sourceBlock = chain head seen by the data source,
 * progressBlock = last block written) and, optionally, the chain head from an RPC, for a fixed
 * duration, then reports the lag distribution. Acceptance criterion 5: lag stays < 5 blocks while the
 * keeper runs.
 *
 * Usage: tsx lag.ts --indexer <graphql url> [--rpc <url>] [--duration 600] [--interval 1000]
 *                   [--label local|hosted] [--max-lag 5] [--headers name=value,...]
 * The RPC option is OFF by default: on the shared public Monad RPC (15 rps budget) leave it off and
 * use `sourceBlock` (the indexer's own view of the head, from HyperSync).
 * Writes docs/evidence/phase-6/lag-<label>.{json,md}.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http } from "viem";
import { IndexerError, indexerQuery, INDEXER_QUERIES, type IndexerMeta } from "@converge/sdk";
import { ROOT } from "./lib/chain";
import { opt, parseArgs, parseHeaders, sleep, summarize } from "./lib/common";

const args = parseArgs(process.argv.slice(2));
const url = opt(args, "indexer", "INDEXER_URL", "http://localhost:8080/v1/graphql")!;
const headers = parseHeaders(opt(args, "headers", "INDEXER_HEADERS"));
const apiKey = opt(args, "api-key", "INDEXER_API_KEY");
const rpc = opt(args, "rpc", "RPC_URL");
const label = opt(args, "label", "LABEL", "local")!;
const durationS = Number(opt(args, "duration", "DURATION", "120"));
const intervalMs = Number(opt(args, "interval", "INTERVAL", "1000"));
const maxLag = Number(opt(args, "max-lag", "MAX_LAG", "5"));
const chainFilter = opt(args, "chain", "CHAIN_ID");
// The first samples can straddle the moment the monitor (and the load) starts: the indexer may
// still be catching up with blocks produced before the first poll. They are recorded and
// reported, but only the steady state decides the verdict.
const warmup = Number(opt(args, "warmup-samples", "WARMUP_SAMPLES", "4"));
const outDir = resolve(opt(args, "out", "OUT_DIR", resolve(ROOT, "docs/evidence/phase-6"))!);

const o = { url, headers, apiKey, timeoutMs: 10_000 };
const pub = rpc ? createPublicClient({ transport: http(rpc) }) : undefined;

interface Sample {
  t: number;
  progress: number;
  source: number;
  lagSource: number;
  lagRpc?: number;
  ready: boolean;
}

async function main() {
  const samples: Sample[] = [];
  let errors = 0;
  const end = Date.now() + durationS * 1000;
  console.log(`lag monitor -> ${url} for ${durationS}s every ${intervalMs}ms (label ${label})`);
  while (Date.now() < end) {
    try {
      const d = await indexerQuery<{ _meta: IndexerMeta[] }>(o, INDEXER_QUERIES.status);
      const m = chainFilter ? d._meta.find((x) => String(x.chainId) === chainFilter) : d._meta[0];
      if (m) {
        const s: Sample = {
          t: Date.now(),
          progress: m.progressBlock,
          source: m.sourceBlock,
          lagSource: Math.max(0, m.sourceBlock - m.progressBlock),
          ready: m.isReady,
        };
        if (pub) s.lagRpc = Math.max(0, Number(await pub.getBlockNumber()) - m.progressBlock);
        samples.push(s);
      }
    } catch (e) {
      errors++;
      if (!(e instanceof IndexerError)) console.error(e);
    }
    await sleep(intervalMs);
  }
  const steady = samples.slice(warmup);
  const lagS = steady.map((s) => s.lagSource);
  const lagR = steady.flatMap((s) => (s.lagRpc === undefined ? [] : [s.lagRpc]));
  const warmMax = Math.max(0, ...samples.slice(0, warmup).map((s) => s.lagRpc ?? s.lagSource));
  const sum = summarize(lagS);
  const sumR = lagR.length ? summarize(lagR) : undefined;
  const notReady = steady.filter((s) => !s.ready).length;
  const advanced = samples.length ? samples.at(-1)!.progress - samples[0]!.progress : 0;
  const worst = Math.max(sum.max, sumR?.max ?? 0);
  const pass = steady.length > 0 && worst < maxLag && notReady === 0 && errors === 0;
  const meta = {
    label,
    endpoint: url,
    when: new Date().toISOString(),
    durationS,
    intervalMs,
    maxLagThreshold: maxLag,
    samples: samples.length,
    warmupSamplesExcluded: warmup,
    warmupMaxLag: warmMax,
    errors,
    notReadySamples: notReady,
    blocksAdvancedWhileMonitoring: advanced,
    lagVsIndexerSourceBlock: sum,
    lagVsRpcHead: sumR,
    pass,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    resolve(outDir, `lag-${label}.json`),
    JSON.stringify({ ...meta, samples: samples }, null, 2),
  );
  writeFileSync(
    resolve(outDir, `lag-${label}.md`),
    [
      `# Indexer lag (${label})`,
      "",
      `- Endpoint \`${url}\`, ${samples.length} samples over ${durationS}s (every ${intervalMs} ms), run at ${meta.when}`,
      label === "local"
        ? "- **LOCAL**: indexer on this machine reading a local anvil chain through RPC (not HyperSync, not hosted)."
        : "- Hosted indexer.",
      `- Blocks advanced while monitoring: ${advanced}; not-ready samples: ${notReady}; query errors: ${errors}`,
      `- The first ${warmup} samples are excluded from the verdict (monitor/load start-up transient); their worst lag was ${warmMax} blocks (all samples are in the JSON).`,
      `- Lag = sourceBlock - progressBlock (the indexer's own view of the head, not independent): max ${sum.max}, p95 ${sum.p95}, mean ${sum.mean.toFixed(2)}`,
      sumR
        ? `- Lag vs the chain head read from RPC (independent): max **${sumR.max}**, p95 ${sumR.p95}, p50 ${sumR.p50}`
        : "- RPC head comparison: not used (the verdict then rests on the indexer's own `sourceBlock`)",
      `- Threshold: max lag < ${maxLag} blocks: **${pass ? "PASS" : "FAIL"}**`,
      "",
    ].join("\n"),
  );
  console.log(
    `${pass ? "PASS" : "FAIL"}: max lag ${worst} blocks over ${samples.length} samples (${advanced} blocks advanced)`,
  );
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
