/**
 * Converge scheduler as a Chainlink CRE workflow (primary orchestrator, Phase 2).
 *
 * Runs at second :05 and :35 of every minute (CRE cron minimum is 30 s; the 5 s offset puts each
 * run just after a 15m/1h boundary, when the Data Streams report for the boundary exists).
 * Each run:
 *   1. reads the leader flag and the whole planning snapshot with TWO EVM reads (SchedulerLens;
 *      CRE allows 15 EVM reads per execution, docs.chain.link/cre/service-quotas);
 *   2. plans idempotent actions with the shared @converge/sdk planner (same code as the fallback);
 *   3. attaches oracle evidence (round proofs come from the lens; Data Streams reports via the
 *      HTTP capability with identical-consensus, at most one request per boundary);
 *   4. delivers one DON-signed report to SchedulerReceiver through the KeystoneForwarder.
 * The market's resolver verifies all evidence onchain, so the workflow cannot choose outcomes.
 *
 * APIs used (TS SDK, docs.chain.link/cre, read 2026-10-04): CronCapability, EVMClient.callContract
 * and writeReport (+ receiverContractExecutionStatus), runtime.report, HTTPClient.sendRequest with
 * consensusIdenticalAggregation, runtime.getSecret, runtime.now, getNetwork, encodeCallMsg.
 */
import {
  bytesToHex,
  consensusIdenticalAggregation,
  CronCapability,
  encodeCallMsg,
  EVMClient,
  getNetwork,
  handler,
  hexToBase64,
  HTTPClient,
  Runner,
  TxStatus,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk";
import { zeroAddress, type Address, type Hex } from "viem";
import { schedulerReceiverAbi } from "../../../../packages/sdk/src/abi/generated";
import { runSync, value } from "../../../../packages/sdk/src/calls";
import {
  lateAfterFor,
  liveFeedId,
  parseSeriesConfig,
  type SeriesConfig,
} from "../../../../packages/sdk/src/config";
import { readSnapshotViaLens } from "../../../../packages/sdk/src/lens";
import { ActionKind, describe, lateItems, plan } from "../../../../packages/sdk/src/planner";
import { buildReceiverActions, encodeSchedulerReport } from "../../../../packages/sdk/src/report";
import { dataStreamsAuthHeaders } from "../../../../packages/sdk/src/streams-auth";

type Config = {
  schedule: string;
  chainSelectorName: string;
  chainId: number;
  factory: Address;
  receiver: Address;
  lens: Address;
  /** Scheduler go-live (unix seconds): rounds before it are ignored (bounds the lens response). */
  epoch: number;
  gasLimit: string;
  maxActionsPerReport: number;
  /** Data Streams REST base URL; empty disables streams evidence (BLOCKED until access exists). */
  dataStreamsApiUrl: string;
  series: unknown;
};

/** CRE quota: EVM read calls per workflow execution (docs.chain.link/cre/service-quotas). */
const CRE_MAX_EVM_READS = 15;
/** WriteReportReply.receiverContractExecutionStatus REVERTED (SDK enum value 1). */
const RECEIVER_REVERTED = 1;

/** Node-mode fetch of the Data Streams report containing `ts`. Never throws: "" = unavailable. */
function fetchReport(
  requester: HTTPSendRequester,
  baseUrl: string,
  apiKey: string,
  apiSecret: string,
  feedId: string,
  ts: string,
  nowMs: number,
): string {
  try {
    const path = `/api/v1/reports?feedID=${feedId}&timestamp=${ts}`;
    const resp = requester
      .sendRequest({
        url: baseUrl + path,
        method: "GET",
        headers: dataStreamsAuthHeaders("GET", path, apiKey, apiSecret, nowMs),
      })
      .result();
    if (resp.statusCode !== 200) return "";
    const body = JSON.parse(new TextDecoder().decode(resp.body)) as {
      report?: { fullReport?: string };
    };
    return body.report?.fullReport ?? "";
  } catch {
    return "";
  }
}

const onCron = (runtime: Runtime<Config>): string => {
  const cfg = runtime.config;
  const series: SeriesConfig = parseSeriesConfig(cfg.series);
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.chainSelectorName });
  if (!network) throw new Error(`unknown chain ${cfg.chainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);
  let reads = 0;
  const exec = (to: Address, data: Hex): Hex => {
    if (++reads > CRE_MAX_EVM_READS) throw new Error("EVM read quota exceeded");
    return bytesToHex(
      evm.callContract(runtime, { call: encodeCallMsg({ from: zeroAddress, to, data }) }).result()
        .data,
    );
  };

  const now = BigInt(Math.floor(runtime.now().getTime() / 1000));
  const leader = runSync(
    (function* () {
      return Number(
        value<number>(
          yield { to: cfg.receiver, abi: schedulerReceiverAbi, functionName: "leader" },
        ),
      );
    })(),
    exec,
  );
  // One read: every actionable slot over the deep lookback (settled slots are omitted onchain).
  const snapshot = runSync(
    readSnapshotViaLens({
      lens: cfg.lens,
      factory: cfg.factory,
      config: series,
      now,
      epoch: BigInt(cfg.epoch),
    }),
    exec,
  );
  const p = plan(snapshot);
  const late = lateItems(p, now, (label) => lateAfterFor(series, label));
  for (const e of p.oracleErrors)
    runtime.log(`ORACLE ERROR ${e.label} ${e.duration}s @${e.startTime}`);
  if (p.truncated) runtime.log("WARNING: SchedulerLens snapshot truncated");
  if (leader !== 0) {
    // FALLBACK leads: stay passive, only surface lateness.
    for (const a of late) runtime.log(`LATE (fallback is leader): ${describe(a)}`);
    return `passive: ${p.actions.length} planned, ${late.length} late`;
  }

  const needsStreams = p.actions.some((a) => a.needsEvidence && a.resolverKind === "streams");
  let apiKey = "";
  let apiSecret = "";
  if (needsStreams && cfg.dataStreamsApiUrl) {
    apiKey = runtime.getSecret({ id: "DATA_STREAMS_API_KEY" }).result().value;
    apiSecret = runtime.getSecret({ id: "DATA_STREAMS_API_SECRET" }).result().value;
  }
  const http = new HTTPClient();
  const fetched = new Map<string, Hex | null>(); // one request per (feed, boundary) per run
  const streams = (label: string, feedId: Hex | undefined, boundary: bigint): Hex | null => {
    if (!cfg.dataStreamsApiUrl || !feedId) {
      runtime.log(`BLOCKED ${label} @${boundary}: no Data Streams access/feed id configured`);
      return null;
    }
    const key = `${feedId}:${boundary}`;
    if (fetched.has(key)) return fetched.get(key) ?? null;
    let report = "";
    try {
      report = http
        .sendRequest(runtime, fetchReport, consensusIdenticalAggregation<string>())(
          cfg.dataStreamsApiUrl,
          apiKey,
          apiSecret,
          feedId,
          boundary.toString(),
          runtime.now().getTime(), // same input on every node; the server allows +-5 s
        )
        .result();
    } catch (e) {
      // Nodes disagreed (e.g. some saw the report, some not yet): retry next run.
      runtime.log(`streams consensus failed for ${label} @${boundary}: ${String(e).slice(0, 120)}`);
    }
    const r = report ? (report as Hex) : null;
    fetched.set(key, r);
    return r;
  };
  const actions = runSync(
    buildReceiverActions(
      p,
      snapshot,
      cfg.maxActionsPerReport,
      streams,
      (label) => liveFeedId(series, label),
      (m) => runtime.log(m),
      series.maxCreatesPerReport,
    ),
    exec,
  );
  for (const a of late) runtime.log(`LATE: ${describe(a)}`);
  if (actions.length === 0) return `nothing to do (${reads} reads)`;

  const payload = encodeSchedulerReport(BigInt(cfg.chainId), now, actions);
  const report = runtime
    .report({
      encodedPayload: hexToBase64(payload),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();
  const res = evm
    .writeReport(runtime, { receiver: cfg.receiver, report, gasConfig: { gasLimit: cfg.gasLimit } })
    .result();
  const summary = actions.map((x) => `${ActionKind[x.kind]}@${x.startTime}`).join(",");
  if (res.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`writeReport failed: status ${res.txStatus} (${summary})`);
  }
  if (Number(res.receiverContractExecutionStatus ?? 0) === RECEIVER_REVERTED) {
    throw new Error(`receiver reverted (${summary})`);
  }
  const hash = bytesToHex(res.txHash ?? new Uint8Array(32));
  runtime.log(`sent ${actions.length} actions in ${hash} (${reads} EVM reads): ${summary}`);
  return hash;
};

const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCron)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
