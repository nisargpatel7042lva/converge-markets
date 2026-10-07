import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startAnvil } from "../../../services/keeper/test/support/anvil";
import { ASSET_ID, KEYS, deployStack } from "../../../services/keeper/test/support/stack";
import { convergeVaultAbi } from "@converge/sdk";
import { makeRig } from "../../../services/keeper/test/support/rig";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const PORT = 3100;

/**
 * Brings up the whole system the e2e tests exercise: anvil (0.4 s blocks) with the real contracts
 * and a funded vault, the real keeper (executes orders, halts on a bad price), the app built for
 * this chain, and its server. Nothing in the app is mocked except the display price (a flat
 * random walk around the strike) and the exchange feeds the keeper reads.
 */
export default async function globalSetup() {
  mkdirSync(resolve(root, "e2e-results"), { recursive: true });
  const anvil = await startAnvil();
  const stack = await deployStack(anvil.url);
  await stack.fund(1000);
  const price = { v: 3000 };
  const round = await stack.openRound(price.v, 40);
  const rig = makeRig(stack);
  const feed = rig.feed(() => price.v);
  await rig.keeper.start();
  // wait until the keeper has made the round tradable (sigma, inventory, NAV): the tests start from a live market
  for (let i = 0; ; i++) {
    const v = await stack.read<{ tradable: boolean }>(
      stack.addrs.vault,
      convergeVaultAbi,
      "venueView",
      [round.market],
    );
    if (v.tradable) break;
    if (i > 200) throw new Error("the keeper did not make the round tradable");
    await new Promise((r) => setTimeout(r, 300));
  }

  // A small control port for the tests that need to act on the keeper (the settlement test stops
  // it so that its own end-of-round report is the only one the resolver sees).
  const control = createServer((req, res) => {
    if (req.url === "/stop-keeper") {
      feed.stop();
      rig.stop();
    }
    res.writeHead(200).end("ok");
  }).listen(3101, "127.0.0.1");

  const deployment = {
    name: "Local test chain",
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
        durations: [900],
        decimals: 2,
      },
    ],
  };
  const info = {
    baseURL: `http://localhost:${PORT}`,
    rpc: anvil.url,
    market: round.market,
    start: round.start,
    end: round.end,
    deployment,
    adminKey: KEYS.admin,
    signerKey: KEYS.signer,
    streams: stack.addrs.streams,
    assetId: ASSET_ID,
  };
  writeFileSync(resolve(root, "e2e-results/chain.json"), JSON.stringify(info, null, 2));
  process.env.E2E_CHAIN = resolve(root, "e2e-results/chain.json");
  process.env.E2E_BASE_URL = info.baseURL;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production" as const,
    NEXT_DIST_DIR: ".next-e2e",
    NEXT_PUBLIC_APP_ENV: "test",
    NEXT_PUBLIC_DEPLOYMENT_JSON: JSON.stringify(deployment),
    NEXT_PUBLIC_MOCK_PRICES: "1",
    NEXT_PUBLIC_MOCK_BASE: String(price.v),
    NEXT_PUBLIC_FAUCET_ENABLED: "1",
    FAUCET_ENABLED: "1",
    DRIP_PRIVATE_KEY: KEYS.admin, // the public anvil dev key: not a secret
    DRIP_RPC_URL: anvil.url,
  };
  const log = openSync(resolve(root, "e2e-results/server.log"), "w");
  await run("pnpm", ["exec", "next", "build"], env, log);
  const server: ChildProcess = spawn(
    "pnpm",
    ["exec", "next", "start", "-p", String(PORT), "-H", "0.0.0.0"],
    {
      cwd: root,
      env,
      stdio: ["ignore", log, log],
      detached: true,
    },
  );
  await waitFor(`${info.baseURL}/`, 60_000);

  return async () => {
    try {
      process.kill(-(server.pid as number), "SIGTERM");
    } catch {
      // already gone
    }
    control.close();
    feed.stop();
    rig.stop();
    await anvil.stop();
  };
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, log: number) {
  return new Promise<void>((ok, fail) => {
    const p = spawn(cmd, args, { cwd: root, env, stdio: ["ignore", log, log] });
    p.on("exit", (c) => (c === 0 ? ok() : fail(new Error(`${cmd} ${args.join(" ")} exited ${c}`))));
  });
}

async function waitFor(url: string, ms: number) {
  const t0 = Date.now();
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - t0 > ms) throw new Error(`${url} did not come up`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
