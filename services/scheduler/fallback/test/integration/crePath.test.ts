/**
 * CRE path end to end (minus DON signing): the same SDK functions the CRE workflow runs
 * (readSnapshot -> plan -> buildReceiverActions -> encodeSchedulerReport) build reports that a
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
  anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  pub = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 100 });
  for (let i = 0; i < 50; i++) {
    try {
      await pub.getBlockNumber();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const now = (await pub.getBlock()).timestamp;
  await rpc("evm_setNextBlockTimestamp", [Number(now - (now % 3600n) + 3600n + 60n)]);
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
    for (let t = goLive; t <= end; t += STEP) {
      await rpc("evm_setNextBlockTimestamp", [Number(t)]);
      await rpc("evm_mine", []);
      monRound += 1n;
      await admin.writeContract({
        address: dev.monFeed,
        abi: mockAggregatorAbi,
        functionName: "setRound",
        args: [1, monRound, 3_400_000n + monRound, t],
      });
      const snapshot = await runAsync(
        readSnapshot({ factory: dev.factory, config, now: t, epoch: goLive }),
        pub,
      );
      const p = plan(snapshot);
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
        ),
        pub,
      );
      if (actions.length === 0) continue;
      const report = encodeSchedulerReport(31337n, t, actions);
      const hash = await fwd.writeContract({
        address: dev.receiver,
        abi: schedulerReceiverAbi,
        functionName: "onReport",
        args: [metadata, report],
        gas: 15_000_000n,
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
    }

    let expected = 0;
    let complete = 0;
    for (const a of config.assets) {
      for (const d of config.durations) {
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
        "The test uses the same SDK functions the CRE workflow (`services/scheduler/cre/scheduler/main.ts`) runs: `readSnapshot` → `plan` → `buildReceiverActions` → `encodeSchedulerReport`.",
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
          },
          null,
          2,
        ),
        "```",
      ].join("\n") + "\n",
    );
    // 2 h from hh:01: 6 fifteen-minute rounds per asset finish inside the window (no hourly one does)
    expect(expected).toBe(18);
    expect(complete).toBe(expected);
    expect(failedActions).toBe(0);
  }, 900_000);
});
