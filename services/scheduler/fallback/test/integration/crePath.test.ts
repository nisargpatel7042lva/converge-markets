/**
 * CRE path end to end (minus DON signing): the same SDK functions the CRE workflow runs
 * (leader + readSnapshotViaLens -> plan -> buildReceiverActions -> encodeSchedulerReport) build reports that a
 * stand-in KeystoneForwarder delivers to the real SchedulerReceiver while CRE is the onchain
 * leader. 2 hours simulated.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assetIdOf,
  buildReceiverActions,
  encodeSchedulerReport,
  marketAbi,
  marketFactoryAbi,
  mockAggregatorAbi,
  plan,
  readSnapshot,
  readSnapshotViaLens,
  runAsync,
  schedulerReceiverAbi,
  signTestReportSync,
} from "@converge/sdk";
import {
  concat,
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  pad,
  parseAbiItem,
  parseEventLogs,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVNET_FEEDS, deployDevnet, devnetSeriesConfig, type Devnet } from "../../src/devnet";

const here = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = resolve(here, "../../../../../docs/evidence/phase-2");
const PORT = 9000 + Math.floor(Math.random() * 300);
const RPC = `http://127.0.0.1:${PORT}`;
const ADMIN = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const SCHED = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const FWD = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);
const SIGNER_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as Hex;
const STEP = 30n; // CRE cron minimum interval

/** Fixed, hour-aligned start (+60 s) so runs are deterministic (review M-d). */
const FIXED_START = 1_800_000_000n - (1_800_000_000n % 3600n) + 3600n + 60n;
let anvil: ChildProcess;
let pub: PublicClient;
let dev: Devnet;

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await res.json()) as { error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
}

beforeAll(async () => {
  anvil = spawn(
    "anvil",
    ["--port", String(PORT), "--silent", "--timestamp", String(FIXED_START - 3600n)],
    { stdio: "ignore" },
  );
  pub = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 100 });
  for (let i = 0; i < 50; i++) {
    try {
      await pub.getBlockNumber();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  await rpc("evm_setNextBlockTimestamp", [Number(FIXED_START)]);
  await rpc("evm_mine", []);
  const admin = createWalletClient({ account: ADMIN, chain: foundry, transport: http(RPC) });
  dev = await deployDevnet(
    pub,
    admin,
    SCHED.address,
    FWD.address,
    privateKeyToAccount(SIGNER_KEY).address,
  );
  // leader defaults to CRE (0)
}, 120_000);

afterAll(() => anvil?.kill());

describe("CRE path through SchedulerReceiver", () => {
  it("creates, opens and resolves every round from forwarder-delivered reports", async () => {
    const config = devnetSeriesConfig();
    const admin = createWalletClient({ account: ADMIN, chain: foundry, transport: http(RPC) });
    const fwd = createWalletClient({ account: FWD, chain: foundry, transport: http(RPC) });
    // metadata = abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address owner, bytes2 reportId)
    const metadata = concat([
      keccak256(stringToHex("converge-scheduler")),
      pad(stringToHex("scheduler"), { size: 10, dir: "right" }),
      ADMIN.address,
      "0x0001",
    ]);
    const goLive = (await pub.getBlock()).timestamp;
    const end = goLive + 2n * 3600n;
    let monRound = 1n;
    let reports = 0;
    let failedActions = 0;
    let px = 3000n * 10n ** 18n;
    let maxReads = 0;
    let planChecks = 0;
    let skippedEvents = 0;
    // The workflow's cron fires at second :05 and :35 (config schedule "5,35 * * * * *").
    for (let t = goLive + 5n; t <= end; t += STEP) {
      {
        // review L-a: never set a timestamp at or below the latest block
        const latest = (await pub.getBlock()).timestamp;
        if (t <= latest) t = latest + 1n;
      }
      await rpc("evm_setNextBlockTimestamp", [Number(t)]);
      await rpc("evm_mine", []);
      monRound += 1n;
      await admin.writeContract({
        address: dev.monFeed,
        abi: mockAggregatorAbi,
        functionName: "setRound",
        args: [1, monRound, 3_400_000n + monRound, t],
      });
      // Count EVM reads exactly as the workflow makes them (CRE quota: 15 per execution).
      let reads = 0;
      const counting = {
        call: (args: Parameters<PublicClient["call"]>[0]) => ((reads += 1), pub.call(args)),
      };
      const leader = await pub.readContract({
        address: dev.receiver,
        abi: schedulerReceiverAbi,
        functionName: "leader",
      });
      reads += 1;
      expect(Number(leader)).toBe(0);
      const snapshot = await runAsync(
        readSnapshotViaLens({
          lens: dev.lens,
          factory: dev.factory,
          config,
          now: t,
          epoch: goLive,
        }),
        counting as never,
      );
      const p = plan(snapshot);
      // Cross-check: the one-call lens plan equals the independent multi-call reader's plan.
      const ref = plan(
        await runAsync(
          readSnapshot({ factory: dev.factory, config, now: t, epoch: goLive, deep: true }),
          pub,
        ),
      );
      const key = (x: {
        kind: number;
        label: string;
        duration: bigint;
        startTime: bigint;
        needsEvidence: boolean;
      }) => `${x.kind}:${x.label}:${x.duration}:${x.startTime}:${x.needsEvidence}`;
      expect(p.actions.map(key).sort()).toEqual(ref.actions.map(key).sort());
      planChecks += 1;
      const actions = await runAsync(
        buildReceiverActions(
          p,
          snapshot,
          12,
          (_label, feedId, boundary) => {
            px += 10n ** 17n * (boundary % 2n === 0n ? 1n : -1n);
            return signTestReportSync(SIGNER_KEY, feedId!, boundary, px);
          },
          (label) => DEVNET_FEEDS[label as keyof typeof DEVNET_FEEDS] as Hex | undefined,
          () => {},
          config.maxCreatesPerReport,
        ),
        counting as never,
      );
      maxReads = Math.max(maxReads, reads);
      expect(reads).toBeLessThanOrEqual(15);
      if (actions.length === 0) continue;
      const report = encodeSchedulerReport(31337n, t, actions);
      const hash = await fwd.writeContract({
        address: dev.receiver,
        abi: schedulerReceiverAbi,
        functionName: "onReport",
        args: [metadata, report],
        gas: 9_000_000n, // the workflow's configured gasLimit (CRE cap: 10M)
      });
      const r = await pub.waitForTransactionReceipt({ hash });
      expect(r.status).toBe("success");
      reports += 1;
      const logs = parseEventLogs({
        abi: schedulerReceiverAbi,
        logs: r.logs,
        eventName: "ActionExecuted",
      });
      failedActions += logs.filter((l) => !l.args.ok).length;
      skippedEvents += parseEventLogs({
        abi: schedulerReceiverAbi,
        logs: r.logs,
        eventName: "ActionsSkipped",
      }).length;
    }

    let expected = 0;
    let complete = 0;
    const resolveDelays: number[] = [];
    for (const a of config.assets) {
      for (const d of a.durations ?? config.durations) {
        const dur = BigInt(d);
        for (let s = goLive - (goLive % dur) + dur; s + dur + 120n <= end; s += dur) {
          expected += 1;
          const m = (await pub.readContract({
            address: dev.factory,
            abi: marketFactoryAbi,
            functionName: "getMarket",
            args: [assetIdOf(a.label), dur, s],
          })) as Address;
          const state = Number(
            await pub.readContract({ address: m, abi: marketAbi, functionName: "state" }),
          );
          if (state === 2 || state === 3) complete += 1;
          const rl = await pub.getLogs({
            address: m,
            event: parseAbiItem(
              "event Resolved(uint8 indexed outcome, int256 strike, int256 endPrice)",
            ),
            fromBlock: 0n,
          });
          if (rl[0]) {
            const bt = (await pub.getBlock({ blockNumber: rl[0].blockNumber! })).timestamp;
            resolveDelays.push(Number(bt - (s + dur)));
          }
        }
      }
    }
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(
      resolve(EVIDENCE, "cre-path-integration.md"),
      [
        "# Phase 2: CRE path integration (forwarder stand-in)",
        "",
        "Generated by `services/scheduler/fallback/test/integration/crePath.test.ts` (`make check-2`).",
        "",
        "The test uses the same SDK functions the CRE workflow (`services/scheduler/cre/scheduler/main.ts`) runs: the `leader` read, `readSnapshotViaLens` (SchedulerLens, one call), `plan`, `buildReceiverActions` (settlement first, ≤ 4 creates) and `encodeSchedulerReport`.",
        "",
        "- EVM reads are counted per run against the CRE quota (15), and the reports are sent with the workflow's 9M gas limit.",
        "- At every step, the lens plan is cross-checked against the independent multi-call reader.",
        "",
        "- Reports were built every 30 s of chain time (the CRE cron minimum) and delivered to the real `SchedulerReceiver` by a local account standing in for the KeystoneForwarder. CRE was the onchain leader.",
        "- **Not covered:** DON signing, the real forwarder, and the CRE runtime itself. Simulation is BLOCKED without a CRE account (see `cre-simulation.md`).",
        "",
        "```json",
        JSON.stringify(
          {
            hoursSimulated: 2,
            reports,
            expectedRounds: expected,
            resolvedRounds: complete,
            failedActionsInReports: failedActions,
            actionsSkippedEvents: skippedEvents,
            maxEvmReadsPerRun: maxReads,
            creQuotaEvmReads: 15,
            gasLimitPerReport: 9_000_000,
            lensVsMultiCallPlanChecks: planChecks,
            cronSchedule: "5,35 * * * * *",
            streamsFinalizationWindowSeconds: 20,
            maxResolveDelaySeconds: Math.max(...resolveDelays),
          },
          null,
          2,
        ),
        "```",
      ].join("\n") + "\n",
    );
    // 2 h from hh:01: 6 fifteen-minute rounds each for BTC and ETH finish inside the window
    // (MON is 1h-only per ADR-002, and no hourly round finishes inside it)
    expect(expected).toBe(12);
    // Review H3: on the CRE schedule, Data Streams rounds resolve within 60 s of expiry.
    expect(Math.max(...resolveDelays)).toBeLessThanOrEqual(60);
    expect(complete).toBe(expected);
    expect(failedActions).toBe(0);
  }, 900_000);
});
