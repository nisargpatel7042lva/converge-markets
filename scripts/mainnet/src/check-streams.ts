/**
 * Live Data Streams acceptance check: the one part of the system no test could exercise without a
 * Chainlink account (docs/security/internal-audit.md, F9-02). With API credentials it fetches the
 * reports for a run of consecutive seconds and checks everything the contracts assume:
 *   - the report decodes as v3 for the configured stream id,
 *   - its window contains the requested second (validFrom <= T <= observations),
 *   - consecutive windows are contiguous (no second without a canonical report, no overlap),
 *   - price/bid/ask are 18-decimal and near the exchange price (catches an 8-decimal stream),
 *   - the real VerifierProxy accepts the payload when called AS the vault, the venue and the
 *     resolver (no access controller, no fee required), via eth_call.
 * Decoding and judging are pure and unit-tested with synthetic reports; only the fetching is live.
 */
import { decodeAbiParameters, type Address, type Hex, type PublicClient, parseAbi } from "viem";
import { dataStreamsAuthHeaders } from "@converge/sdk";

export interface DecodedReport {
  feedId: Hex;
  validFrom: number;
  observations: number;
  expiresAt: number;
  nativeFee: bigint;
  linkFee: bigint;
  price: bigint;
  bid: bigint;
  ask: bigint;
}

const REPORT_V3 = [
  { type: "bytes32" },
  { type: "uint32" },
  { type: "uint32" },
  { type: "uint192" },
  { type: "uint192" },
  { type: "uint32" },
  { type: "int192" },
  { type: "int192" },
  { type: "int192" },
] as const;

/** Decodes a `fullReport` payload (the verifier's input) without verifying it. */
export function decodeFullReport(full: Hex): DecodedReport {
  const [, reportData] = decodeAbiParameters(
    [
      { type: "bytes32[3]" },
      { type: "bytes" },
      { type: "bytes32[]" },
      { type: "bytes32[]" },
      { type: "bytes32" },
    ],
    full,
  );
  const [feedId, validFrom, observations, nativeFee, linkFee, expiresAt, price, bid, ask] =
    decodeAbiParameters(REPORT_V3, reportData);
  return { feedId, validFrom, observations, expiresAt, nativeFee, linkFee, price, bid, ask };
}

export type Level = "PASS" | "WARN" | "FAIL";
export interface StreamCheck {
  level: Level;
  what: string;
}

export interface Sample {
  /** The second that was asked for. */
  at: number;
  report: DecodedReport;
}

export interface JudgeOptions {
  feedId: Hex;
  /** Exchange price in USD, to catch a wrong decimal scale. */
  expectedUsd?: number;
  /** Allowed distance from `expectedUsd` (fraction). */
  tolerance?: number;
}

const WAD = 10n ** 18n;

export function judgeSamples(samples: Sample[], o: JudgeOptions): StreamCheck[] {
  const out: StreamCheck[] = [];
  const add = (level: Level, what: string) => out.push({ level, what });
  if (samples.length < 2) {
    add("FAIL", `only ${samples.length} sample(s): at least 2 consecutive seconds are needed`);
    return out;
  }
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const consecutive = sorted.every((s, i) => i === 0 || s.at === sorted[i - 1]!.at + 1);
  add(consecutive ? "PASS" : "FAIL", "samples are consecutive seconds");

  const version = (id: Hex) => parseInt(id.slice(2, 6), 16);
  add(
    sorted.every((s) => s.report.feedId.toLowerCase() === o.feedId.toLowerCase()) ? "PASS" : "FAIL",
    "every report is for the configured stream id",
  );
  add(
    sorted.every((s) => version(s.report.feedId) === 3) ? "PASS" : "FAIL",
    "every report is schema v3 (id starts 0x0003)",
  );

  const contains = sorted.filter(
    (s) => !(s.report.validFrom <= s.at && s.at <= s.report.observations),
  );
  add(
    contains.length === 0 ? "PASS" : "FAIL",
    contains.length === 0
      ? "every report's window [validFrom, observations] contains the second asked for"
      : `${contains.length} report(s) do not contain the second asked for (first: ${contains[0]!.at}): the vault cannot use them as the canonical report`,
  );

  // distinct reports in order of time: neighbouring windows must touch exactly
  const distinct: DecodedReport[] = [];
  for (const s of sorted) {
    const last = distinct[distinct.length - 1];
    if (
      !last ||
      last.observations !== s.report.observations ||
      last.validFrom !== s.report.validFrom
    )
      distinct.push(s.report);
  }
  const gaps: string[] = [];
  const overlaps: string[] = [];
  for (let i = 1; i < distinct.length; i++) {
    const prev = distinct[i - 1]!;
    const cur = distinct[i]!;
    if (cur.validFrom > prev.observations + 1) gaps.push(`${prev.observations}→${cur.validFrom}`);
    else if (cur.validFrom <= prev.observations)
      overlaps.push(`${prev.observations}/${cur.validFrom}`);
  }
  if (distinct.length < 2)
    add(
      "WARN",
      "all samples fell into one report: contiguity across reports was not exercised, sample a longer run",
    );
  else
    add(
      gaps.length === 0 ? "PASS" : "FAIL",
      gaps.length === 0
        ? `${distinct.length} reports, no gaps between windows`
        : `GAP between windows (${gaps.join(", ")}): seconds without a canonical report would make executeOrder and settleEpoch revert`,
    );
  if (overlaps.length)
    add(
      "WARN",
      `windows overlap (${overlaps.join(", ")}): two reports could be canonical for one second; the contracts accept the first verified, check the rule`,
    );

  const px = sorted.map((s) => s.report);
  add(
    px.every((r) => r.price > 0n && r.bid <= r.price && r.price <= r.ask) ? "PASS" : "FAIL",
    "price > 0 and bid <= price <= ask",
  );
  add(
    px.every((r) => r.expiresAt > r.observations) ? "PASS" : "FAIL",
    "expiresAt is after the observation time",
  );
  add(
    px.every((r) => r.nativeFee === 0n && r.linkFee === 0n) ? "PASS" : "WARN",
    px.every((r) => r.nativeFee === 0n && r.linkFee === 0n)
      ? "reports carry no fee"
      : "reports carry a non-zero fee: the vault forwards no value (finding F9-05); check the verifier's fee mode before launch",
  );

  if (o.expectedUsd !== undefined) {
    const tol = o.tolerance ?? 0.02;
    const usd18 = Number(px[0]!.price) / Number(WAD);
    const usd8 = Number(px[0]!.price) / 1e8;
    const near = (x: number) => Math.abs(x - o.expectedUsd!) / o.expectedUsd! <= tol;
    if (near(usd18))
      add(
        "PASS",
        `price scale is 18 decimals (${usd18.toFixed(4)} USD vs exchange ${o.expectedUsd})`,
      );
    else if (near(usd8))
      add(
        "FAIL",
        `price looks like 8 decimals (${usd8.toFixed(4)} USD): the contracts assume 18, this stream cannot be used as is`,
      );
    else
      add(
        "FAIL",
        `price ${usd18} (18 dp) / ${usd8} (8 dp) is not within ${tol * 100}% of the exchange price ${o.expectedUsd}`,
      );
  } else add("WARN", "no exchange price given: the decimal scale was not checked");
  return out;
}

const verifierAbi = parseAbi([
  "function verify(bytes payload, bytes parameterPayload) payable returns (bytes)",
]);

/** eth_call of the real verifier AS each contract that will call it. Returns one check per caller. */
export async function verifyAsCallers(
  pub: PublicClient,
  verifier: Address,
  payload: Hex,
  parameterPayload: Hex,
  callers: Record<string, Address>,
): Promise<StreamCheck[]> {
  const out: StreamCheck[] = [];
  for (const [name, from] of Object.entries(callers)) {
    try {
      await pub.simulateContract({
        address: verifier,
        abi: verifierAbi,
        functionName: "verify",
        args: [payload, parameterPayload],
        account: from,
      });
      out.push({
        level: "PASS",
        what: `VerifierProxy.verify succeeds when called as the ${name} (no access controller, no fee)`,
      });
    } catch (e) {
      out.push({
        level: "FAIL",
        what: `VerifierProxy.verify REVERTS when called as the ${name}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`,
      });
    }
  }
  return out;
}

export interface FetchedReport {
  validFrom: number;
  observations: number;
  fullReport: Hex;
}

/** GET /api/v1/reports?feedID=&timestamp= (docs/EXTERNAL.md: Data Streams REST). */
export async function fetchReportAt(
  baseUrl: string,
  key: string,
  secret: string,
  feedId: Hex,
  at: number,
  fetchImpl: typeof fetch = fetch,
  nowMs: () => number = Date.now,
): Promise<FetchedReport> {
  const path = `/api/v1/reports?feedID=${feedId}&timestamp=${at}`;
  const res = await fetchImpl(`${baseUrl}${path}`, {
    headers: dataStreamsAuthHeaders("GET", path, key, secret, nowMs()),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Data Streams answered ${res.status} for ${at}`);
  const j = (await res.json()) as {
    report?: { validFromTimestamp: number; observationsTimestamp: number; fullReport: Hex };
  };
  if (!j.report) throw new Error(`no report in the answer for ${at}`);
  return {
    validFrom: j.report.validFromTimestamp,
    observations: j.report.observationsTimestamp,
    fullReport: j.report.fullReport,
  };
}

export const render = (checks: StreamCheck[]): string =>
  checks.map((c) => `${c.level}  ${c.what}`).join("\n");

async function main() {
  const { createPublicClient, http, defineChain } = await import("viem");
  const { readFileSync, mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const { repoRoot } = await import("./params");
  const { VERIFIER_PROXY } = await import("./constants");
  const { EXCHANGE_SYMBOLS } = await import("./gen");
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  const rpc = need("RPC_URL");
  const key = need("STREAMS_API_KEY");
  const secret = need("STREAMS_API_SECRET");
  const base = process.env.STREAMS_API_URL ?? "https://api.dataengine.chain.link";
  const network = process.env.NETWORK ?? "mainnet";
  // After the deployment the record has the ids and the contracts; BEFORE it (the ids are written to
  // an immutable resolver, so test them first) the ids come from config/series.json and the
  // verifier is not called as the contracts.
  const depFile = resolve(repoRoot, "deployments", `${network}.json`);
  let dep: import("./state").Deployment;
  if (existsSync(depFile)) {
    dep = JSON.parse(readFileSync(depFile, "utf8")) as import("./state").Deployment;
  } else {
    const series = JSON.parse(readFileSync(resolve(repoRoot, "config/series.json"), "utf8")) as {
      assets: { label: string; resolver: string; streamsFeedId?: string }[];
    };
    dep = {
      chainId: 143,
      network,
      transactions: [],
      assets: Object.fromEntries(
        series.assets
          .filter((a) => a.resolver === "streams")
          .map((a) => [
            a.label,
            { assetId: "0x" as Hex, kind: "streams" as const, feedId: a.streamsFeedId as Hex },
          ]),
      ),
    };
    console.log(
      "no deployment record: checking the ids in config/series.json (pre-deployment mode)",
    );
  }
  const pub = createPublicClient({
    chain: defineChain({
      id: dep.chainId,
      name: "monad",
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    }),
    transport: http(rpc),
  });
  const seconds = Number(process.env.SAMPLE_SECONDS ?? 45);
  const all: StreamCheck[] = [];
  const record: Record<string, unknown> = {
    network,
    at: new Date().toISOString(),
    samples: seconds,
  };
  for (const [label, a] of Object.entries(dep.assets ?? {})) {
    if (a.kind !== "streams" || !a.feedId) continue;
    all.push({ level: "PASS", what: `--- ${label} (${a.feedId})` });
    const end = Math.floor(Date.now() / 1000) - 30; // reports for recent seconds are available after a short delay
    const samples: Sample[] = [];
    let first: FetchedReport | undefined;
    for (let t = end - seconds + 1; t <= end; t++) {
      const f = await fetchReportAt(base, key, secret, a.feedId, t);
      first ??= f;
      samples.push({ at: t, report: decodeFullReport(f.fullReport) });
    }
    const ex = EXCHANGE_SYMBOLS[label];
    let expectedUsd: number | undefined;
    if (ex) {
      const r = await fetch(`https://api.exchange.coinbase.com/products/${ex.coinbase}/ticker`);
      expectedUsd = Number(((await r.json()) as { price: string }).price);
    }
    all.push(
      ...judgeSamples(samples, {
        feedId: a.feedId,
        ...(expectedUsd !== undefined ? { expectedUsd } : {}),
      }),
    );
    const callers: Record<string, Address> = {};
    if (dep.vault) {
      callers.vault = dep.vault.vault;
      callers.venue = dep.vault.forwardVenue;
    }
    if (dep.dataStreamsResolver) callers.resolver = dep.dataStreamsResolver;
    if (!dep.vault && !dep.dataStreamsResolver) {
      record[label] = {
        feedId: a.feedId,
        firstWindow: first && { validFrom: first.validFrom, observations: first.observations },
      };
      continue;
    }
    const pp = dep.dataStreamsResolver
      ? ((await pub.readContract({
          address: dep.dataStreamsResolver,
          abi: parseAbi(["function parameterPayload() view returns (bytes)"]),
          functionName: "parameterPayload",
        })) as Hex)
      : ("0x" as Hex);
    const mid = samples[Math.floor(samples.length / 2)]!;
    const fetchedMid = await fetchReportAt(base, key, secret, a.feedId, mid.at);
    all.push(...(await verifyAsCallers(pub, VERIFIER_PROXY, fetchedMid.fullReport, pp, callers)));
    record[label] = {
      feedId: a.feedId,
      firstWindow: first && { validFrom: first.validFrom, observations: first.observations },
    };
  }
  console.log(render(all));
  record.checks = all;
  mkdirSync(resolve(repoRoot, "docs/evidence/phase-9"), { recursive: true });
  writeFileSync(
    resolve(repoRoot, "docs/evidence/phase-9/streams-live-check.json"),
    JSON.stringify(record, null, 2) + "\n",
  );
  if (all.some((c) => c.level === "FAIL")) process.exit(1);
}

if (process.argv[1]?.endsWith("check-streams.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
