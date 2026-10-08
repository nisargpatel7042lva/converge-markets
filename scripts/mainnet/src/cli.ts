/**
 * Mainnet deployment CLI.
 *   plan        validate the configuration and print what would happen (no RPC writes)
 *   deploy      run the idempotent deployment (needs --execute; mainnet also needs the confirmation variable)
 *   verify      read-only: check the deployment on chain against the intended configuration
 *   safe-batch  write the Safe Transaction Builder JSON files (handover and launch)
 *   explorer    print the forge verify-contract commands
 *   gen         write the keeper config and the app's deployment JSON from the deployment record
 * Environment (see docs/ops/mainnet-deploy.md):
 *   NETWORK=mainnet|rehearsal  RPC_URL  DEPLOYER_PRIVATE_KEY  SAFE_ADDRESS  GUARDIAN_ADDRESS
 *   KEEPER_ADDRESS  SCHEDULER_ADDRESS  [TREASURY_ADDRESS]  [TVL_CAP_USDC]  [ENABLE_PARTNERS=1]
 *   [SCHEDULER_LEADER=fallback|cre]  CONFIRM_MAINNET=I_UNDERSTAND_THIS_SPENDS_REAL_MONEY (mainnet + --execute)
 * Keys are read from the environment only; nothing is printed except addresses.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { DEFAULT_TVL_CAP, MAINNET_CHAIN_ID } from "./constants";
import { Deployer, validateConfig, type DeployConfig, type SeriesAsset } from "./deploy";
import { verifyCommands } from "./explorer";
import { appDeployment, keeperConfig, launchSummary, writeGenerated } from "./gen";
import { repoRoot } from "./params";
import { handoverBatch, launchBatch } from "./safe";
import { readState } from "./state";
import { render, verifyDeployment } from "./verify";

const addr = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((a) => getAddress(a));
const Env = z.object({
  NETWORK: z.enum(["mainnet", "rehearsal"]).default("rehearsal"),
  RPC_URL: z.string().url(),
  SAFE_ADDRESS: addr,
  GUARDIAN_ADDRESS: addr,
  KEEPER_ADDRESS: addr,
  SCHEDULER_ADDRESS: addr,
  TREASURY_ADDRESS: addr.optional(),
  TVL_CAP_USDC: z.coerce.number().positive().max(100_000).optional(),
  ENABLE_PARTNERS: z.enum(["0", "1"]).default("0"),
  SCHEDULER_LEADER: z.enum(["fallback", "cre"]).default("fallback"),
});

export function loadConfig(env: NodeJS.ProcessEnv): DeployConfig {
  const e = Env.parse(env);
  const series = JSON.parse(readFileSync(resolve(repoRoot, "config/series.json"), "utf8")) as {
    assets: SeriesAsset[];
  };
  return {
    network: e.NETWORK,
    chainId: MAINNET_CHAIN_ID,
    safe: e.SAFE_ADDRESS,
    guardian: e.GUARDIAN_ADDRESS,
    keeper: e.KEEPER_ADDRESS,
    scheduler: e.SCHEDULER_ADDRESS,
    treasury: e.TREASURY_ADDRESS ?? e.SAFE_ADDRESS,
    tvlCap: e.TVL_CAP_USDC ? BigInt(Math.round(e.TVL_CAP_USDC * 1e6)) : DEFAULT_TVL_CAP,
    enablePartners: e.ENABLE_PARTNERS === "1",
    leader: e.SCHEDULER_LEADER,
    assets: series.assets,
  };
}

async function clients(rpc: string, key?: Hex) {
  const chain = defineChain({
    id: MAINNET_CHAIN_ID,
    name: "monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = key
    ? createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(rpc) })
    : undefined;
  return { chain, pub, wallet };
}

async function isLocalFork(rpc: string): Promise<boolean> {
  try {
    const r = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "web3_clientVersion", params: [] }),
    });
    return /anvil/i.test(((await r.json()) as { result?: string }).result ?? "");
  } catch {
    return false;
  }
}

async function main() {
  const [cmd, ...flags] = process.argv.slice(2);
  const cfg = loadConfig(process.env);
  const rpc = process.env.RPC_URL as string;
  const key = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  const { pub, wallet } = await clients(rpc, key);

  if (cmd === "plan") {
    if (!wallet)
      throw new Error("DEPLOYER_PRIVATE_KEY is needed to check that no role is the deployer");
    validateConfig(cfg, wallet.account!.address);
    console.log(
      JSON.stringify(
        {
          deployer: wallet.account!.address,
          ...cfg,
          tvlCapUsdc: Number(cfg.tvlCap) / 1e6,
          assets: cfg.assets.map((a) => a.label),
        },
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
        2,
      ),
    );
    console.log("configuration is valid; nothing was sent");
    return;
  }
  if (cmd === "deploy") {
    if (!wallet) throw new Error("DEPLOYER_PRIVATE_KEY is not set");
    if (!flags.includes("--execute"))
      throw new Error("refusing to send transactions without --execute (use `plan` to validate)");
    const fork = await isLocalFork(rpc);
    if (cfg.network === "rehearsal" && !fork)
      throw new Error("NETWORK=rehearsal only runs against a local anvil fork of mainnet");
    if (cfg.network === "mainnet") {
      if (fork) throw new Error("NETWORK=mainnet against a local fork: use NETWORK=rehearsal");
      if (process.env.CONFIRM_MAINNET !== "I_UNDERSTAND_THIS_SPENDS_REAL_MONEY")
        throw new Error(
          "set CONFIRM_MAINNET=I_UNDERSTAND_THIS_SPENDS_REAL_MONEY to deploy to mainnet",
        );
    }
    const d = new Deployer(pub, wallet, cfg);
    const state = await d.run();
    console.log(
      `done. gas billed (limit x price): ${Number(d.totalCostWei()) / 1e18} MON over ${state.transactions.length} transactions`,
    );
    return;
  }
  const state = readState(cfg.network, cfg.chainId);
  if (cmd === "verify") {
    const deployer =
      wallet?.account?.address ?? (process.env.DEPLOYER_ADDRESS as Address | undefined);
    const checks = await verifyDeployment(pub, state, cfg, deployer);
    console.log(render(checks));
    const fails = checks.filter((c) => c.level === "FAIL").length;
    const warns = checks.filter((c) => c.level === "WARN").length;
    console.log(`\n${checks.length} checks, ${fails} FAIL, ${warns} WARN`);
    if (fails) process.exit(1);
    return;
  }
  if (cmd === "safe-batch") {
    const dir = resolve(repoRoot, "deployments");
    mkdirSync(dir, { recursive: true });
    for (const [name, batch] of [
      ["handover", handoverBatch(state)],
      ["launch", launchBatch(state)],
    ] as const) {
      const f = resolve(dir, `safe-${name}.${cfg.network}.json`);
      writeFileSync(f, JSON.stringify(batch, null, 2) + "\n");
      console.log(`wrote ${f} (${batch.transactions.length} transactions)`);
    }
    return;
  }
  if (cmd === "explorer") {
    console.log((await verifyCommands(pub, state)).join("\n"));
    return;
  }
  if (cmd === "gen") {
    const rpcForApp = process.env.APP_RPC_URL;
    if (!rpcForApp) throw new Error("APP_RPC_URL (the RPC the browsers will use) is required");
    console.log(
      `wrote ${writeGenerated(cfg.network, "keeper.json", JSON.stringify(keeperConfig(state), null, 2) + "\n")}`,
    );
    console.log(
      `wrote ${writeGenerated(cfg.network, "app-deployment.json", JSON.stringify(appDeployment(state, rpcForApp)) + "\n")}`,
    );
    console.log(JSON.stringify(launchSummary(state), null, 2));
    console.log(
      "indexer: pnpm --filter @converge/indexer gen:config (reads deployments/mainnet.json)",
    );
    return;
  }
  throw new Error("usage: plan | deploy --execute | verify | safe-batch | explorer | gen");
}

if (process.argv[1]?.endsWith("cli.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
