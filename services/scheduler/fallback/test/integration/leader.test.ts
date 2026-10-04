/**
 * Leader flag: while CRE leads, the fallback must send nothing and alert when actions are late;
 * after an operator switches the flag to FALLBACK, the fallback takes over immediately.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { marketFactoryAbi, schedulerReceiverAbi, assetIdOf } from "@converge/sdk";
import pino from "pino";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Alerter } from "../../src/alerts";
import { deployDevnet, devnetSeriesConfig, type Devnet } from "../../src/devnet";
import { Scheduler } from "../../src/scheduler";

const PORT = 9400 + Math.floor(Math.random() * 300);
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

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await res.json()) as { error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
}

let anvil: ChildProcess;
let pub: PublicClient;
let dev: Devnet;

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
  const admin = createWalletClient({ account: ADMIN, chain: foundry, transport: http(RPC) });
  dev = await deployDevnet(pub, admin, SCHED.address, FWD.address, SIGNER.address);
}, 120_000);

afterAll(() => anvil?.kill());

describe("leader flag", () => {
  it("passive fallback alerts on late actions; acts after the switch", async () => {
    const alerts: string[] = [];
    const alerter: Alerter = { alert: async (_k, m) => void alerts.push(m) };
    const admin = createWalletClient({ account: ADMIN, chain: foundry, transport: http(RPC) });
    const scheduler = new Scheduler({
      publicClient: pub,
      walletClient: createWalletClient({ account: SCHED, chain: foundry, transport: http(RPC) }),
      factory: dev.factory,
      lens: dev.lens,
      receiver: dev.receiver,
      config: devnetSeriesConfig(),
      streams: null,
      alerter,
      log: pino({ level: "silent" }),
      gasMultiplierPct: 120,
      maxRetries: 1,
      epoch: (await pub.getBlock()).timestamp,
    });
    const before = await pub.getTransactionCount({ address: SCHED.address });
    const r1 = await scheduler.tick();
    expect(r1.leader).toBe("cre");
    expect(r1.acting).toBe(false);
    expect(r1.planned).toBeGreaterThan(0); // markets are due but CRE is leading
    expect(await pub.getTransactionCount({ address: SCHED.address })).toBe(before);
    // The nearest creates are due less than one round before start -> late -> alert.
    expect(r1.late.length).toBeGreaterThan(0);
    expect(alerts.some((a) => a.includes("CRE (leader) is late"))).toBe(true);

    const sw = await admin.writeContract({
      address: dev.receiver,
      abi: schedulerReceiverAbi,
      functionName: "setLeader",
      args: [1],
    });
    expect((await pub.waitForTransactionReceipt({ hash: sw })).status).toBe("success");
    const r2 = await scheduler.tick();
    expect(r2.leader).toBe("fallback");
    expect(r2.acting).toBe(true);
    expect(r2.outcomes.every((o) => o.outcome.status === "sent")).toBe(true);
    const cfg = devnetSeriesConfig();
    const first = (r2.now / 900n + 1n) * 900n;
    const m = await pub.readContract({
      address: dev.factory,
      abi: marketFactoryAbi,
      functionName: "getMarket",
      args: [assetIdOf(cfg.assets[0]!.label), 900n, first],
    });
    expect(m).not.toBe("0x0000000000000000000000000000000000000000");
    // Idempotent: the next tick has nothing left to do.
    const r3 = await scheduler.tick();
    expect(r3.planned).toBe(0);
  }, 300_000);

  it("keeps scheduling through the multi-call reader when the lens fails (review iteration 3 M-3)", async () => {
    const alerts: string[] = [];
    const alerter: Alerter = { alert: async (_k, m) => void alerts.push(m) };
    const mk = (lens: Address) =>
      new Scheduler({
        publicClient: pub,
        walletClient: createWalletClient({ account: SCHED, chain: foundry, transport: http(RPC) }),
        factory: dev.factory,
        lens,
        receiver: dev.receiver,
        config: devnetSeriesConfig(),
        streams: null,
        alerter,
        log: pino({ level: "silent" }),
        gasMultiplierPct: 120,
        maxRetries: 0,
      });
    // CRE leads (passive), and a round passes so creates and opens are due. Both readers must
    // plan the same work at the same chain state.
    const sw = await createWalletClient({
      account: ADMIN,
      chain: foundry,
      transport: http(RPC),
    }).writeContract({
      address: dev.receiver,
      abi: schedulerReceiverAbi,
      functionName: "setLeader",
      args: [0],
    });
    await pub.waitForTransactionReceipt({ hash: sw });
    await rpc("evm_increaseTime", [900]);
    await rpc("evm_mine", []);
    const broken = await mk(dev.factory).tick(); // no `snapshot` there: every lens call reverts
    expect(alerts.some((a) => a.includes("SchedulerLens read failed"))).toBe(true);
    expect(broken.consecutiveBad).toBe(1); // a degraded read counts toward /health 503
    const healthy = await mk(dev.lens).tick();
    expect(alerts.filter((a) => a.includes("SchedulerLens read failed"))).toHaveLength(1);
    expect(healthy.now).toBe(broken.now);
    expect(broken.planned).toBeGreaterThan(0);
    expect(broken.planned).toBe(healthy.planned);
    expect([...broken.missed].sort()).toEqual([...healthy.missed].sort());
  }, 300_000);
});
