/**
 * Converge scheduler as a Chainlink CRE workflow (primary orchestrator, Phase 2).
 *
 * Every 30 s (CRE cron minimum): read market state, plan idempotent actions with the shared
 * @converge/sdk planner (same code as the TS fallback), attach oracle evidence, and deliver them
 * as one DON-signed report to SchedulerReceiver via the KeystoneForwarder. The receiver creates
 * markets and calls open/resolve/invalidate; the market's resolver verifies all evidence onchain,
 * so the workflow cannot choose outcomes.
 *
 * APIs used, all from https://docs.chain.link/cre (TS SDK, read 2026-10-04): CronCapability,
 * EVMClient.callContract / writeReport, runtime.report, HTTPClient.sendRequest with
 * consensusIdenticalAggregation, runtime.getSecret, getNetwork, encodeCallMsg, hexToBase64.
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
import { parseSeriesConfig, type SeriesConfig } from "../../../../packages/sdk/src/config";
import { dataStreamsAuthHeaders } from "../../../../packages/sdk/src/streams-auth";
import { ActionKind, describe, lateItems, plan } from "../../../../packages/sdk/src/planner";
import { buildReceiverActions, encodeSchedulerReport } from "../../../../packages/sdk/src/report";
import { readSnapshot } from "../../../../packages/sdk/src/snapshot";

type Config = {
  schedule: string;
  chainSelectorName: string;
  chainId: number;
  factory: Address;
  receiver: Address;
  gasLimit: string;
  maxActionsPerReport: number;
  /** Data Streams REST base URL; empty disables streams evidence (BLOCKED until access exists). */
  dataStreamsApiUrl: string;
  series: unknown;
};

const ZERO_FEED = `0x${"00".repeat(32)}`;

/** Node-mode fetch of the Data Streams report containing `ts` (identical across nodes). */
function fetchReport(
  requester: HTTPSendRequester,
  baseUrl: string,
  apiKey: string,
  apiSecret: string,
  feedId: string,
  ts: string,
  nowMs: number,
): string {
  const path = `/api/v1/reports?feedID=${feedId}&timestamp=${ts}`;
  const resp = requester
    .sendRequest({
      url: baseUrl + path,
      method: "GET",
      headers: dataStreamsAuthHeaders("GET", path, apiKey, apiSecret, nowMs),
    })
    .result();
  if (resp.statusCode === 404) return "";
  if (resp.statusCode !== 200) throw new Error(`data streams HTTP ${resp.statusCode}`);
  const body = JSON.parse(new TextDecoder().decode(resp.body)) as {
    report?: { fullReport?: string };
  };
  return body.report?.fullReport ?? "";
}

const onCron = (runtime: Runtime<Config>): string => {
  const cfg = runtime.config;
  const series: SeriesConfig = parseSeriesConfig(cfg.series);
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.chainSelectorName });
  if (!network) throw new Error(`unknown chain ${cfg.chainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);
  const exec = (to: Address, data: Hex): Hex =>
    bytesToHex(
      evm.callContract(runtime, { call: encodeCallMsg({ from: zeroAddress, to, data }) }).result()
        .data,
    );

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
  const snapshot = runSync(readSnapshot({ factory: cfg.factory, config: series, now }), exec);
  const p = plan(snapshot);
  const late = lateItems(p, now, BigInt(series.lateAfterSeconds));
  if (leader !== 0) {
    // FALLBACK leads: stay passive, only surface lateness.
    for (const a of late) runtime.log(`LATE (fallback is leader): ${describe(a)}`);
    return `passive: ${p.actions.length} planned, ${late.length} late`;
  }

  let apiKey = "";
  let apiSecret = "";
  const needsStreams = p.actions.some((a) => a.needsEvidence && a.resolverKind === "streams");
  if (needsStreams && cfg.dataStreamsApiUrl) {
    apiKey = runtime.getSecret({ id: "DATA_STREAMS_API_KEY" }).result().value;
    apiSecret = runtime.getSecret({ id: "DATA_STREAMS_API_SECRET" }).result().value;
  }
  const http = new HTTPClient();
  const streams = (label: string, feedId: Hex | undefined, boundary: bigint): Hex | null => {
    if (!cfg.dataStreamsApiUrl || !feedId || feedId === ZERO_FEED) {
      runtime.log(`BLOCKED ${label} @${boundary}: no Data Streams access/feed id configured`);
      return null;
    }
    const report = http
      .sendRequest(runtime, fetchReport, consensusIdenticalAggregation<string>())(
        cfg.dataStreamsApiUrl,
        apiKey,
        apiSecret,
        feedId,
        boundary.toString(),
        runtime.now().getTime(), // runtime clock (Date.now() is not used inside CRE)
      )
      .result();
    return report ? (report as Hex) : null;
  };
  const actions = runSync(
    buildReceiverActions(
      p,
      snapshot,
      cfg.maxActionsPerReport,
      streams,
      (label) => series.assets.find((x) => x.label === label)?.streamsFeedId as Hex | undefined,
      (m) => runtime.log(m),
    ),
    exec,
  );
  for (const a of late) runtime.log(`LATE: ${describe(a)}`);
  if (actions.length === 0) return "nothing to do";

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
  const hash = bytesToHex(res.txHash ?? new Uint8Array(32));
  runtime.log(`sent ${actions.length} actions in ${hash}: ${summary}`);
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
