/**
 * A complete local Converge: anvil (0.4 s blocks), the real contracts, a funded vault, the real
 * keeper (market making + order execution + halts), a scheduler that creates / opens / resolves
 * 15-minute rounds on the chain clock, and the real app (production build) with a test-money
 * faucet. Prices are a gentle synthetic walk: this is a DEMO of the product's whole loop, not a
 * deployment (docs/ops/mainnet-deploy.md is the real one). Everything is test money on a local chain.
 *
 *   pnpm --filter @converge/keeper exec tsx scripts/demo-stack.ts       (Ctrl-C stops everything)
 * Then open the printed URL on a phone-sized window.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  convergeVaultAbi,
  dataStreamsResolverAbi,
  marketAbi,
  marketFactoryAbi,
  signTestReportSync,
} from "@converge/sdk";
import type { Address } from "viem";
import { startAnvil } from "../test/support/anvil";
import { makeRig } from "../test/support/rig";
import { ASSET_ID, KEYS, TEST_FEED, deployStack } from "../test/support/stack";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const web = resolve(root, "apps/web");
const out = resolve(root, ".demo");
const PORT = Number(process.env.DEMO_PORT ?? 3100);
const ZERO = "0x0000000000000000000000000000000000000000";
const DURATION = 900;
const BASE = 3000;

const log = (s: string) => console.log(`[demo ${new Date().toISOString().slice(11, 19)}] ${s}`);

async function main() {
  mkdirSync(out, { recursive: true });
  const anvil = await startAnvil(1); // 1 s blocks keep the chain clock equal to the wall clock (at 0.4 s anvil runs its clock 2.5x fast)
  log(`chain: ${anvil.url}`);
  const stack = await deployStack(anvil.url);
  await stack.fund(1000);
  // Rounds can only be created ahead of their start: move the chain clock to two minutes before the
  // next boundary so the first round opens right away (the app follows the chain clock).
  {
    const t0 = await stack.now();
    const next = (Math.floor(t0 / DURATION) + 1) * DURATION;
    if (next - t0 > 150) await stack.warp(next - t0 - 120);
  }
  log(`contracts deployed; vault ${stack.addrs.vault} funded with 1000 test USDC`);

  // The price the keeper and the app's display both sit on (like the e2e suite): flat at the base,
  // so a bet placed at the displayed price fills. Each round ends a little up or down, at random.
  const price = { v: BASE };
  const walk = setInterval(() => undefined, 1 << 30);
  const rig = makeRig(stack, { log: process.env.DEMO_LOG === "1" });
  const feed = rig.feed(() => price.v);
  await rig.keeper.start();
  log("keeper started");

  // ---- scheduler: the same job as services/scheduler, on the chain clock, for the one test asset
  const report = (ts: number, px = price.v) =>
    signTestReportSync(
      KEYS.signer,
      TEST_FEED,
      BigInt(ts),
      BigInt(Math.round(px * 1e8)) * 10n ** 10n,
    );
  const endPrice = new Map<number, number>();
  const endOf = (start: number) => {
    if (!endPrice.has(start)) endPrice.set(start, BASE * (1 + (Math.random() - 0.5) * 0.004));
    return endPrice.get(start)!;
  };
  const done = new Set<string>();
  const once = async (key: string, fn: () => Promise<unknown>) => {
    if (done.has(key)) return;
    try {
      await fn();
      done.add(key);
    } catch (e) {
      log(`scheduler ${key}: ${String(e instanceof Error ? e.message : e).split("\n")[0]}`);
    }
  };
  let stopping = false;
  const schedule = (async () => {
    while (!stopping) {
      try {
        const t = await stack.now();
        const cur = Math.floor(t / DURATION) * DURATION;
        for (let k = -2; k <= 3; k++) {
          const start = cur + k * DURATION;
          const end = start + DURATION;
          let market = await stack.read<Address>(
            stack.addrs.factory,
            marketFactoryAbi,
            "getMarket",
            [ASSET_ID, BigInt(DURATION), BigInt(start)],
          );
          if (market === ZERO) {
            if (k < 1) continue; // a round can only be created before its start
            await once(`create:${start}`, () =>
              stack.tx(stack.admin, {
                address: stack.addrs.factory,
                abi: marketFactoryAbi,
                functionName: "createMarket",
                args: [ASSET_ID, BigInt(DURATION), BigInt(start)],
              }),
            );
            market = await stack.read<Address>(stack.addrs.factory, marketFactoryAbi, "getMarket", [
              ASSET_ID,
              BigInt(DURATION),
              BigInt(start),
            ]);
            if (market === ZERO) continue;
          }
          const state = Number(await stack.read<number>(market, marketAbi, "state"));
          if (state === 0 && t >= start) {
            await once(`propose-open:${start}`, () =>
              stack.tx(stack.admin, {
                address: stack.addrs.streams,
                abi: dataStreamsResolverAbi,
                functionName: "submit",
                args: [ASSET_ID, BigInt(start), report(start)],
              }),
            );
            if (t >= start + 22)
              await once(`open:${start}`, async () => {
                await stack.tx(stack.admin, {
                  address: market,
                  abi: marketAbi,
                  functionName: "open",
                  args: ["0x"],
                });
                log(
                  `round ${new Date(start * 1000).toISOString().slice(11, 16)} opened at strike ${price.v.toFixed(2)}`,
                );
              });
          }
          if (state === 1 && t >= end) {
            await once(`propose-end:${start}`, () =>
              stack.tx(stack.admin, {
                address: stack.addrs.streams,
                abi: dataStreamsResolverAbi,
                functionName: "submit",
                args: [ASSET_ID, BigInt(end), report(end, endOf(start))],
              }),
            );
            if (t >= end + 22)
              await once(`resolve:${start}`, async () => {
                await stack.tx(stack.admin, {
                  address: market,
                  abi: marketAbi,
                  functionName: "resolve",
                  args: ["0x"],
                });
                log(
                  `round ${new Date(start * 1000).toISOString().slice(11, 16)} resolved at ${endOf(start).toFixed(2)} (strike ${BASE})`,
                );
              });
          }
        }
      } catch (e) {
        log(`scheduler tick: ${String(e instanceof Error ? e.message : e).split("\n")[0]}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();

  // ---- the app
  const deployment = {
    name: "Local demo chain",
    network: "local",
    chainId: stack.chain.id,
    rpcUrl: anvil.url,
    nativeSymbol: "ETH",
    usdc: stack.addrs.usdc,
    factory: stack.addrs.factory,
    vault: stack.addrs.vault,
    venue: stack.addrs.venue,
    minRewardWei: "1000000000000000",
    testnet: true,
    series: [
      {
        label: "TEST/USD",
        assetId: ASSET_ID,
        name: "ETH",
        pair: "ETH/USD",
        symbol: "ETH",
        binance: "ETHUSDT",
        coinbase: "ETH-USD",
        durations: [DURATION],
        decimals: 2,
      },
    ],
  };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    NEXT_DIST_DIR: ".next-demo",
    NEXT_PUBLIC_APP_ENV: "test",
    NEXT_PUBLIC_DEPLOYMENT_JSON: JSON.stringify(deployment),
    NEXT_PUBLIC_MOCK_PRICES: "1",
    NEXT_PUBLIC_MOCK_BASE: String(BASE),
    NEXT_PUBLIC_FAUCET_ENABLED: "1",
    FAUCET_ENABLED: "1",
    DRIP_PRIVATE_KEY: KEYS.admin, // the public anvil development key: not a secret
    DRIP_RPC_URL: anvil.url,
  };
  const appLog = openSync(resolve(out, "app.log"), "w");
  log("building the app (about a minute)…");
  await new Promise<void>((res, rej) => {
    const b = spawn("pnpm", ["exec", "next", "build"], {
      cwd: web,
      env,
      stdio: ["ignore", appLog, appLog],
    });
    b.on("exit", (c) =>
      c === 0 ? res() : rej(new Error(`next build exited ${c}; see .demo/app.log`)),
    );
  });
  const server: ChildProcess = spawn(
    "pnpm",
    ["exec", "next", "start", "-p", String(PORT), "-H", "0.0.0.0"],
    { cwd: web, env, stdio: ["ignore", appLog, appLog], detached: true },
  );
  writeFileSync(
    resolve(out, "chain.json"),
    JSON.stringify({ rpc: anvil.url, deployment, adminKey: KEYS.admin }, null, 2),
  );
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const v = await stack
    .read<{ tradable: boolean }>(stack.addrs.vault, convergeVaultAbi, "venueView", [
      await stack.read<Address>(stack.addrs.factory, marketFactoryAbi, "getMarket", [
        ASSET_ID,
        BigInt(DURATION),
        BigInt(Math.floor((await stack.now()) / DURATION) * DURATION),
      ]),
    ])
    .catch(() => ({ tradable: false }));
  log("");
  log(`READY  open  http://localhost:${PORT}  (a phone-sized window looks best)`);
  log(`       chain ${anvil.url}   vault ${stack.addrs.vault}`);
  log(`       current round tradable right now: ${v.tradable}`);
  log(
    "       Create an account (passkey), tap 'add money' for test USDC, place a bet, watch the keeper fill it, collect after the round.",
  );

  const stop = async () => {
    stopping = true;
    clearInterval(walk);
    feed.stop();
    rig.stop();
    try {
      process.kill(-(server.pid as number), "SIGTERM");
    } catch {
      /* gone */
    }
    await schedule.catch(() => undefined);
    await anvil.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
