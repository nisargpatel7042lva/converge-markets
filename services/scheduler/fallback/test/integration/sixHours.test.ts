/**
 * Phase 2 AC2: 6 hours of simulated time on anvil. Every configured round (BTC/ETH/MON x 15m/1h)
 * must be created ahead of its start, opened and resolved, with 0 missed actions.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assetIdOf,
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
import { WebhookAlerter } from "../../src/alerts";
import { deployDevnet, devnetSeriesConfig, type Devnet } from "../../src/devnet";
import { Scheduler } from "../../src/scheduler";

const here = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = resolve(here, "../../../../../docs/evidence/phase-2");
const PORT = 8600 + Math.floor(Math.random() * 300);
const RPC = `http://127.0.0.1:${PORT}`;
// anvil's default dev keys (public, local only)
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

const HOURS = 6;
const STEP = 10n; // scheduler loop interval (seconds of chain time)

let anvil: ChildProcess;
let pub: PublicClient;
let dev: Devnet;

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function setTime(t: bigint): Promise<void> {
  await rpc("evm_setNextBlockTimestamp", [Number(t)]);
  await rpc("evm_mine", []);
}

beforeAll(async () => {
  anvil = spawn("anvil", ["--port", String(PORT), "--silent", "--chain-id", "31337"], {
    stdio: "ignore",
  });
  pub = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 100 });
  for (let i = 0; i < 50; i++) {
    try {
      await pub.getBlockNumber();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  // Start 1 minute after an hour boundary so both series start cleanly.
  const now = (await pub.getBlock()).timestamp;
  await setTime(now - (now % 3600n) + 3600n + 60n);
  const admin = createWalletClient({ account: ADMIN, chain: foundry, transport: http(RPC) });
  dev = await deployDevnet(pub, admin, SCHED.address, FWD.address, SIGNER.address);
  await admin.writeContract({
    address: dev.receiver,
    abi: schedulerReceiverAbi,
    functionName: "setLeader",
    args: [1], // FALLBACK leads in this test
  });
}, 60_000);

afterAll(() => {
  anvil?.kill();
});

describe("scheduler: 6 hours simulated on anvil", () => {
  it("creates every round ahead, opens and resolves all of them (0 missed)", async () => {
    const config = devnetSeriesConfig();
    const log = pino({ level: "silent" });
    const admin = createWalletClient({ account: ADMIN, chain: foundry, transport: http(RPC) });
    const wallet = createWalletClient({ account: SCHED, chain: foundry, transport: http(RPC) });
    // Deterministic random-walk prices for the TEST signer.
    let px = 3000n * 10n ** 18n;
    const streams = new TestSignerStreamsSource(SIGNER, async (ts) => {
      px += (BigInt((Number(ts) * 2654435761) % 7) - 3n) * 10n ** 17n;
      return px;
    });
    const goLive = (await pub.getBlock()).timestamp;
    const scheduler = new Scheduler({
      publicClient: pub,
      walletClient: wallet,
      factory: dev.factory,
      receiver: dev.receiver,
      config,
      streams,
      alerter: new WebhookAlerter("none", undefined, undefined, log),
      log,
      gasMultiplierPct: 120,
      maxRetries: 2,
      epoch: goLive, // rounds before go-live are not "missed"
    });

    const start = goLive;
    const end = start + BigInt(HOURS * 3600);
    let monRound = 1n;
    let lastMon = 0n;
    let lateTotal = 0;
    let missedTotal = 0;
    let failed = 0;
    let ticks = 0;
    for (let t = start; t <= end; t += STEP) {
      await setTime(t);
      if (t - lastMon >= 30n) {
        // healthy MON push feed (~30 s cadence, as observed on Monad mainnet)
        monRound += 1n;
        lastMon = t;
        await admin.writeContract({
          address: dev.monFeed,
          abi: mockAggregatorAbi,
          functionName: "setRound",
          args: [1, monRound, 3_400_000n + (monRound % 50n) * 1_000n, t],
        });
      }
      const r = await scheduler.tick({ deep: ticks % 60 === 0 });
      ticks += 1;
      lateTotal += r.late.length;
      missedTotal += r.missed.length;
      failed += r.outcomes.filter((o) => o.outcome.status === "failed").length;
    }

    // ---- verify onchain: every expected round exists, was created ahead, opened and resolved.
    const created = await pub.getLogs({
      address: dev.factory,
      event: parseAbiItem(
        "event MarketCreated(address indexed market, bytes32 indexed assetId, uint64 indexed startTime, uint64 duration, (address factory, bytes32 assetId, address resolver, address collateral, address up, address down, uint64 startTime, uint64 endTime, uint16 redeemFeeBps) params)",
      ),
      fromBlock: 0n,
    });
    const blockTs = new Map<bigint, bigint>();
    const tsOf = async (bn: bigint) => {
      if (!blockTs.has(bn)) blockTs.set(bn, (await pub.getBlock({ blockNumber: bn })).timestamp);
      return blockTs.get(bn)!;
    };
    const rows: string[] = [];
    let expected = 0;
    let createdAhead = 0;
    let opened = 0;
    let resolved = 0;
    const openDelays: number[] = [];
    const resolveDelays: number[] = [];
    for (const a of config.assets) {
      for (const d of config.durations) {
        const dur = BigInt(d);
        // rounds that both started after go-live and ended before the simulation end
        for (let s = goLive - (goLive % dur) + dur; s + dur + 120n <= end; s += dur) {
          expected += 1;
          const m = (await pub.readContract({
            address: dev.factory,
            abi: marketFactoryAbi,
            functionName: "getMarket",
            args: [assetIdOf(a.label), dur, s],
          })) as Address;
          const log = created.find((l) => l.args.market?.toLowerCase() === m.toLowerCase());
          const createdAt = log ? await tsOf(log.blockNumber!) : null;
          if (createdAt !== null && createdAt < s) createdAhead += 1;
          const state = Number(
            await pub.readContract({ address: m, abi: marketAbi, functionName: "state" }),
          );
          const openedLogs = await pub.getLogs({
            address: m,
            event: parseAbiItem("event Opened(int256 strike)"),
            fromBlock: 0n,
          });
          const resolvedLogs = await pub.getLogs({
            address: m,
            event: parseAbiItem(
              "event Resolved(uint8 indexed outcome, int256 strike, int256 endPrice)",
            ),
            fromBlock: 0n,
          });
          if (openedLogs[0]) {
            opened += 1;
            openDelays.push(Number((await tsOf(openedLogs[0].blockNumber!)) - s));
          }
          if (resolvedLogs[0] && (state === 2 || state === 3)) {
            resolved += 1;
            resolveDelays.push(Number((await tsOf(resolvedLogs[0].blockNumber!)) - (s + dur)));
          }
          rows.push(
            `| ${a.label} | ${d / 60}m | ${s} | ${createdAt !== null ? Number(s - createdAt) : "MISSING"} | ${state} |`,
          );
        }
      }
    }
    const max = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);
    const summary = {
      hoursSimulated: HOURS,
      ticks,
      expectedRounds: expected,
      createdAhead,
      opened,
      resolved,
      lateActions: lateTotal,
      missedRounds: missedTotal,
      failedActions: failed,
      maxOpenDelaySeconds: max(openDelays),
      maxResolveDelaySeconds: max(resolveDelays),
    };
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(
      resolve(EVIDENCE, "anvil-6h-simulation.md"),
      [
        "# Phase 2: 6-hour anvil simulation",
        "",
        "Generated by `services/scheduler/fallback/test/integration/sixHours.test.ts` (`make check-2`).",
        `Chain time advanced in ${STEP}s steps (the production loop interval); the fallback scheduler`,
        "ran one tick per step as leader. MON resolves via round proofs over a mock aggregator updated",
        "every 30 s; BTC/ETH resolve via Data Streams-shaped reports from the TEST signer",
        "(MockStreamsVerifierProxy, 30 s finalization window).",
        "",
        "```json",
        JSON.stringify(summary, null, 2),
        "```",
        "",
        "Delays are measured from onchain event block timestamps: open = Opened - start, resolve =",
        "Resolved - end. For Data Streams markets this includes the 30 s finalization window.",
        "",
        "| asset | series | start | created seconds ahead | final state (2=UP,3=DOWN) |",
        "|---|---|---|---|---|",
        ...rows,
      ].join("\n") + "\n",
    );
    // 3 assets x (>= 22 fifteen-minute + >= 4 hourly rounds fully inside the 6 h window)
    expect(expected).toBeGreaterThanOrEqual(78);
    expect(createdAhead).toBe(expected);
    expect(opened).toBe(expected);
    expect(resolved).toBe(expected);
    expect(missedTotal).toBe(0);
    expect(lateTotal).toBe(0);
    expect(failed).toBe(0);
    expect(summary.maxResolveDelaySeconds).toBeLessThanOrEqual(60);
  }, 1_800_000);
});
