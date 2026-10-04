/**
 * Local soak bring-up (LABELLED MOCK FEEDS): deploys the devnet stack on a real-time local chain,
 * makes the fallback the leader, and writes .soak/devnet.json + .soak/scheduler.env for docker
 * compose. Prices: MON via a mock aggregator mirrored from Chainlink MON/USD on Monad mainnet
 * (mon-mirror.ts); BTC/ETH via TEST-signer reports priced from Chainlink BTC/USD and ETH/USD on
 * Monad mainnet. Keys are anvil's public dev keys (local only).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { schedulerReceiverAbi } from "@converge/sdk";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { DEVNET_FEEDS, deployDevnet, devnetSeriesConfig } from "../devnet";

const RPC = process.env.SOAK_RPC_URL ?? "http://127.0.0.1:8547";
const ROOT = resolve(process.cwd(), "../../..");
const keys = {
  admin: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  scheduler: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  forwarder: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  signer: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;
// Chainlink proxies on Monad mainnet (docs/EXTERNAL.md)
const MAINNET = {
  btc: "0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546",
  eth: "0x1B1414782B859871781bA3E4B0979b9ca57A0A04",
  mon: "0xBcD78f76005B7515837af6b50c7C52BCf73822fb",
};

const pub = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 250 });
const admin = createWalletClient({
  account: privateKeyToAccount(keys.admin),
  chain: foundry,
  transport: http(RPC),
});
const dev = await deployDevnet(
  pub,
  admin,
  privateKeyToAccount(keys.scheduler).address,
  privateKeyToAccount(keys.forwarder).address,
  privateKeyToAccount(keys.signer).address,
);
const h = await admin.writeContract({
  address: dev.receiver,
  abi: schedulerReceiverAbi,
  functionName: "setLeader",
  args: [1],
});
await pub.waitForTransactionReceipt({ hash: h });
const epoch = (await pub.getBlock()).timestamp;
mkdirSync(resolve(ROOT, ".soak"), { recursive: true });
writeFileSync(
  resolve(ROOT, "config/series.devnet.json"),
  JSON.stringify(devnetSeriesConfig(), null, 2) + "\n",
);
writeFileSync(
  resolve(ROOT, ".soak/devnet.json"),
  JSON.stringify({ rpc: RPC, epoch: Number(epoch), ...dev, monMainnetFeed: MAINNET.mon }, null, 2),
);
writeFileSync(
  resolve(ROOT, ".soak/scheduler.env"),
  [
    `RPC_URL=${RPC}`,
    `FACTORY=${dev.factory}`,
    `RECEIVER=${dev.receiver}`,
    `LENS=${dev.lens}`,
    `HEALTH_HOST=127.0.0.1`,
    `SCHEDULER_PRIVATE_KEY=${keys.scheduler}`,
    `SERIES_CONFIG=/app/config/series.devnet.json`,
    `LOOP_INTERVAL_MS=10000`,
    `EPOCH=${epoch}`,
    `HEALTH_PORT=8088`,
    `LOG_LEVEL=info`,
    `ALERT_KIND=none`,
    `STREAMS_SOURCE=test-signer`,
    `STREAMS_TEST_SIGNER_KEY=${keys.signer}`,
    `TEST_PRICE_FEEDS=${JSON.stringify({ [DEVNET_FEEDS["BTC/USD"]]: MAINNET.btc, [DEVNET_FEEDS["ETH/USD"]]: MAINNET.eth })}`,
    `TEST_PRICE_RPC_URL=https://rpc.monad.xyz`,
  ].join("\n") + "\n",
);
console.log(JSON.stringify({ ...dev, epoch: Number(epoch) }));
