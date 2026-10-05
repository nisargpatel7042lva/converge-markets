/**
 * Chainlink push-feed history on Monad mainnet, compared with the Binance series.
 *
 * Why: the backtest prices with Binance. This measures (a) the basis between the two at feed update
 * times and (b) how far the push feed's answer lags Binance, which bears on the information lead
 * of a trader who watches Binance against anything priced from a push feed. BTC/ETH are resolved
 * and priced from Data Streams in production, whose history needs an API key we do not have, so
 * this is a lower bound on the staleness question, not a measurement of Data Streams.
 *
 * `pnpm --filter @converge/backtest backtest:chainlink` fetches (needs an archive-capable Monad
 * RPC in MONAD_MAINNET_RPC_URL) and writes data/chainlink-basis.json, which is committed so that
 * `pnpm backtest` stays offline and deterministic.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { DATA_ROOT, WINDOW, epochSec, addDays } from "./binance";
import { loadSeriesCached } from "./cache";
import type { PriceSeries } from "./series";

export const FEEDS: Record<string, { address: Address; symbol: string }> = {
  "BTC/USD": { address: "0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546", symbol: "BTC/USD" },
  "ETH/USD": { address: "0x1B1414782B859871781bA3E4B0979b9ca57A0A04", symbol: "ETH/USD" },
};
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function getRoundData(uint80) view returns (uint80,int256,uint256,uint256,uint80)",
]);
const mcAbi = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

let nextId = 1;
async function rpcCall(rpc: string, to: Address, data: Hex): Promise<Hex> {
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: nextId++,
          method: "eth_call",
          params: [{ to, data }, "latest"],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const j = (await res.json()) as { result?: Hex; error?: { message: string } };
      if (j.result) return j.result;
      throw new Error(j.error?.message ?? "no result");
    } catch (e) {
      if (i === 5) throw e;
      await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
  }
  throw new Error("unreachable");
}

type Round = { n: number; updatedAt: number; answer: number };

async function roundAt(
  rpc: string,
  feed: Address,
  phase: bigint,
  n: number,
): Promise<Round | null> {
  try {
    const out = await rpcCall(
      rpc,
      feed,
      encodeFunctionData({
        abi: feedAbi,
        functionName: "getRoundData",
        args: [(phase << 64n) | BigInt(n)],
      }),
    );
    const [, answer, , updatedAt] = decodeFunctionResult({
      abi: feedAbi,
      functionName: "getRoundData",
      data: out,
    }) as readonly [bigint, bigint, bigint, bigint, bigint];
    return { n, updatedAt: Number(updatedAt), answer: Number(answer) / 1e8 };
  } catch {
    return null;
  }
}

async function fetchBatch(
  rpc: string,
  feed: Address,
  phase: bigint,
  from: number,
  to: number,
): Promise<Round[]> {
  const calls = [];
  for (let n = from; n <= to; n++) {
    calls.push({
      target: feed,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: feedAbi,
        functionName: "getRoundData",
        args: [(phase << 64n) | BigInt(n)],
      }),
    });
  }
  const out = await rpcCall(
    rpc,
    MULTICALL3,
    encodeFunctionData({ abi: mcAbi, functionName: "aggregate3", args: [calls] }),
  );
  const [results] = decodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { type: "bool", name: "success" },
          { type: "bytes", name: "returnData" },
        ],
      },
    ],
    out,
  ) as unknown as [{ success: boolean; returnData: Hex }[]];
  const rounds: Round[] = [];
  results.forEach((r, i) => {
    if (!r.success) return;
    const [, answer, , updatedAt] = decodeAbiParameters(
      [
        { type: "uint80" },
        { type: "int256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint80" },
      ],
      r.returnData,
    );
    rounds.push({ n: from + i, updatedAt: Number(updatedAt), answer: Number(answer) / 1e8 });
  });
  return rounds;
}

async function fetchWindow(
  rpc: string,
  feed: Address,
  fromTs: number,
  toTs: number,
  log: (m: string) => void,
): Promise<{ rounds: Round[]; phase: number }> {
  const latest = decodeFunctionResult({
    abi: feedAbi,
    functionName: "latestRoundData",
    data: await rpcCall(
      rpc,
      feed,
      encodeFunctionData({ abi: feedAbi, functionName: "latestRoundData" }),
    ),
  }) as readonly [bigint, bigint, bigint, bigint, bigint];
  const phase = latest[0] >> 64n;
  const lastN = Number(latest[0] & ((1n << 64n) - 1n));
  // First round with updatedAt >= fromTs (rounds are time-ordered within a phase).
  let lo = 1;
  let hi = lastN;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await roundAt(rpc, feed, phase, mid);
    if (!r || r.updatedAt < fromTs) lo = mid + 1;
    else hi = mid;
  }
  const rounds: Round[] = [];
  const BATCH = 250;
  for (let n = lo; n <= lastN; n += BATCH) {
    const b = await fetchBatch(rpc, feed, phase, n, Math.min(lastN, n + BATCH - 1));
    rounds.push(...b);
    if (b.length > 0 && b[b.length - 1]!.updatedAt > toTs) break;
    if ((n - lo) % (BATCH * 40) === 0) log(`  ${feed}: round ${n} of ${lastN}`);
  }
  return {
    rounds: rounds.filter((r) => r.updatedAt >= fromTs && r.updatedAt < toTs),
    phase: Number(phase),
  };
}

export type BasisStats = {
  lagSec: number;
  n: number;
  meanBps: number;
  stdBps: number;
  rmsBps: number;
  absP50Bps: number;
  absP99Bps: number;
};

function basisAt(rounds: Round[], s: PriceSeries, lagSec: number): BasisStats {
  const xs: number[] = [];
  for (const r of rounds) {
    // Chainlink's answer is compared with the Binance price `lagSec` BEFORE the on-chain timestamp.
    const k = Math.floor(r.updatedAt - lagSec - s.t0);
    if (k < 0 || k >= s.px.length) continue;
    xs.push((r.answer / s.px[k]! - 1) * 1e4);
  }
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const abs = xs.map(Math.abs).sort((a, b) => a - b);
  return {
    lagSec,
    n,
    meanBps: mean,
    stdBps: Math.sqrt(variance),
    rmsBps: Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / n),
    absP50Bps: abs[Math.floor(n * 0.5)]!,
    absP99Bps: abs[Math.floor(n * 0.99)]!,
  };
}

export async function fetchBasis(
  rpc: string,
  log: (m: string) => void = console.log,
): Promise<void> {
  const from = epochSec(WINDOW.start);
  const to = epochSec(addDays(WINDOW.end, 1));
  const out: Record<string, unknown> = {};
  for (const [label, f] of Object.entries(FEEDS)) {
    log(`${label}: fetching push-feed rounds ${WINDOW.start}..${WINDOW.end}`);
    const { rounds, phase } = await fetchWindow(rpc, f.address, from, to, log);
    const s = loadSeriesCached(label);
    const perLag: BasisStats[] = [];
    for (let lag = -2; lag <= 20; lag++) perLag.push(basisAt(rounds, s, lag));
    const best = perLag.reduce((a, b) => (b.rmsBps < a.rmsBps ? b : a));
    const gaps = rounds
      .slice(1)
      .map((r, i) => r.updatedAt - rounds[i]!.updatedAt)
      .sort((a, b) => a - b);
    out[label] = {
      feed: f.address,
      phase,
      rounds: rounds.length,
      firstUpdatedAt: rounds[0]!.updatedAt,
      lastUpdatedAt: rounds[rounds.length - 1]!.updatedAt,
      dataSha256: createHash("sha256").update(JSON.stringify(rounds)).digest("hex"),
      updateGapSec: {
        p50: gaps[Math.floor(gaps.length * 0.5)],
        p95: gaps[Math.floor(gaps.length * 0.95)],
        max: gaps[gaps.length - 1],
      },
      atLagZero: perLag.find((p) => p.lagSec === 0)!,
      bestLag: best,
      perLag: perLag.map((p) => ({ lagSec: p.lagSec, rmsBps: p.rmsBps })),
    };
  }
  writeFileSync(
    join(DATA_ROOT, "chainlink-basis.json"),
    JSON.stringify(
      {
        window: { start: WINDOW.start, end: WINDOW.end },
        source: "Chainlink push feeds on Monad mainnet (docs/EXTERNAL.md), read via Multicall3",
        feeds: out,
      },
      null,
      1,
    ) + "\n",
  );
  log("wrote data/chainlink-basis.json");
}

export { encodeAbiParameters };
