/**
 * Fault case (Phase 2 review M2/M7): the scheduler is down for 3 hours -- longer than the 2 h
 * "recent" lookback -- while feeds keep publishing. After it comes back, no market may stay stuck:
 * every market whose boundary has passed must reach a terminal state (UP/DOWN/INVALID), rounds
 * that started during the outage are reported as missed, and normal operation resumes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  marketAbi,
  marketFactoryAbi,
  mockAggregatorAbi,
  schedulerReceiverAbi,
  TestSignerStreamsSource,
} from "@converge/sdk";
import pino from "pino";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbiItem,
  type Address,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Alerter } from "../../src/alerts";
import { deployDevnet, devnetSeriesConfig, type Devnet } from "../../src/devnet";
import { Scheduler } from "../../src/scheduler";

const PORT = 9700 + Math.floor(Math.random() * 200);
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
const SIGNER = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
);
const STEP = 10n;

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
  dev = await deployDevnet(pub, admin, SCHED.address, FWD.address, SIGNER.address);
  const h = await admin.writeContract({
    address: dev.receiver,
    abi: schedulerReceiverAbi,
    functionName: "setLeader",
    args: [1],
  });
  await pub.waitForTransactionReceipt({ hash: h });
}, 120_000);

afterAll(() => anvil?.kill());

describe("scheduler outage longer than the recent lookback", () => {
  it("recovers: no market stuck, missed rounds reported, operation resumes", async () => {
    const config = devnetSeriesConfig();
    const admin = createWalletClient({ account: ADMIN, chain: foundry, transport: http(RPC) });
    const alerts: string[] = [];
    const alerter: Alerter = { alert: async (_k, m) => void alerts.push(m) };
    const goLive = (await pub.getBlock()).timestamp;
    let px = 3000n * 10n ** 18n;
    const scheduler = new Scheduler({
      publicClient: pub,
      walletClient: createWalletClient({ account: SCHED, chain: foundry, transport: http(RPC) }),
      factory: dev.factory,
      lens: dev.lens,
      receiver: dev.receiver,
      config,
      streams: new TestSignerStreamsSource(SIGNER, async () => (px += 10n ** 17n)),
      alerter,
      log: pino({ level: "silent" }),
      gasMultiplierPct: 120,
      maxRetries: 1,
      epoch: goLive,
    });
    let monRound = 1n;
    let failed = 0;
    let missedSeen = 0;
    const outageStart = goLive + 30n * 60n;
    const outageEnd = outageStart + 3n * 3600n;
    const end = outageEnd + 60n * 60n;
    for (let t = goLive; t <= end; t += STEP) {
      await rpc("evm_setNextBlockTimestamp", [Number(t)]);
      await rpc("evm_mine", []);
      if (t % 30n === 0n) {
        monRound += 1n;
        const h = await admin.writeContract({
          address: dev.monFeed,
          abi: mockAggregatorAbi,
          functionName: "setRound",
          args: [1, monRound, 3_400_000n + monRound, t],
        });
        await pub.waitForTransactionReceipt({ hash: h });
      }
      if (t > outageStart && t < outageEnd) continue; // scheduler down; feeds keep running
      const r = await scheduler.tick();
      failed += r.outcomes.filter(
        (o) => o.outcome.status === "failed" || o.outcome.status === "pending",
      ).length;
      missedSeen = Math.max(missedSeen, r.missed.length);
    }

    const created = await pub.getLogs({
      address: dev.factory,
      event: parseAbiItem(
        "event MarketCreated(address indexed market, bytes32 indexed assetId, uint64 indexed startTime, uint64 duration, (address factory, bytes32 assetId, address resolver, address collateral, address up, address down, uint64 startTime, uint64 endTime, uint16 redeemFeeBps) params)",
      ),
      fromBlock: 0n,
    });
    let stuck = 0;
    let invalid = 0;
    let resolved = 0;
    for (const l of created) {
      const m = l.args.market as Address;
      const st = Number(
        await pub.readContract({ address: m, abi: marketAbi, functionName: "state" }),
      );
      const start = l.args.startTime!;
      const dur = l.args.duration!;
      const boundaryPassed =
        st === 0 ? start + 2_000n < end : st === 1 ? start + dur + 2_000n < end : false;
      if (boundaryPassed) stuck += 1; // CREATED/OPEN long past its boundary
      if (st === 4) invalid += 1;
      if (st === 2 || st === 3) resolved += 1;
    }
    // Rounds after recovery were created ahead again.
    const nextStart = (end / 900n + 1n) * 900n;
    const next = await pub.readContract({
      address: dev.factory,
      abi: marketFactoryAbi,
      functionName: "getMarket",
      args: [created[0]!.args.assetId!, 900n, nextStart],
    });
    expect(stuck).toBe(0);
    expect(failed).toBe(0);
    expect(invalid).toBeGreaterThan(0); // streams boundaries during the outage voided (no report by grace)
    expect(resolved).toBeGreaterThan(0);
    expect(missedSeen).toBeGreaterThan(0); // rounds that started during the outage are reported
    expect(alerts.some((a) => a.includes("round started without a market"))).toBe(true);
    expect(next).not.toBe("0x0000000000000000000000000000000000000000");
  }, 1_800_000);
});
