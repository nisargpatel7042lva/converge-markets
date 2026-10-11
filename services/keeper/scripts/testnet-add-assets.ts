/**
 * TESTNET ONLY. Adds the BTC and MON up/down series to the live Monad testnet deployment, next to the
 * existing ETH one: per asset, map a feed id on the Data Streams resolver (the test verifier takes any),
 * register it on the factory, and whitelist it in the vault with a volatility band. Idempotent: every step
 * is skipped when the chain already has it.
 *
 *   pnpm --filter @converge/keeper exec tsx scripts/testnet-add-assets.ts      (reads ../../.env, never prints a key)
 * Needs the deployer key (owner of the resolver, admin of the factory, owner of the vault).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assetIdOf } from "@converge/sdk";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const envFile = readFileSync(`${root}.env`, "utf8").split("\n");
const env = (k: string): string => {
  const line = envFile.find((l) => l.startsWith(`${k}=`));
  if (!line) throw new Error(`${k} missing in .env`);
  return line.slice(k.length + 1).trim();
};
const dep = JSON.parse(readFileSync(`${root}deployments/testnet.json`, "utf8")) as {
  marketFactory: Address;
  dataStreamsResolver: Address;
  vault: { vault: Address };
};

/** label = the factory/keeper label (assetId = keccak256 of it); sigma = the vault's volatility band. */
export const SERIES = [
  {
    label: "TEST-BTC/USD",
    short: "TEST-BTC",
    feedId: "0x0003000000000000000000000000000000000000000000000000000000000002" as Hex,
    sigmaMin: 0.3,
    sigmaMax: 1.0,
  },
  {
    label: "TEST-MON/USD",
    short: "TEST-MON",
    feedId: "0x0003000000000000000000000000000000000000000000000000000000000003" as Hex,
    sigmaMin: 0.6,
    sigmaMax: 2.0,
  },
] as const;

const rpc = process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz";
const chain = defineChain({
  id: 10143,
  name: "Monad testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({
  account: privateKeyToAccount(env("DEPLOYER_PRIVATE_KEY") as Hex),
  chain,
  transport: http(rpc),
});
const abi = parseAbi([
  "function feedIdOf(bytes32) view returns (bytes32)",
  "function configureAsset(bytes32 assetId, bytes32 feedId)",
  "function asset(bytes32) view returns ((address resolver, string label, bool enabled))",
  "function setAsset(bytes32 assetId, address resolver, string label, bool enabled)",
  "function assetCfg(bytes32) view returns (bool enabled, bytes32 feedId, uint128 sigma, uint64 sigmaUpdatedAt, uint128 sigmaMin, uint128 sigmaMax)",
  "function enableAsset(bytes32 assetId, uint256 sigmaMin, uint256 sigmaMax)",
]);
const log = (s: string) => console.log(`[assets ${new Date().toISOString().slice(11, 19)}] ${s}`);

async function send(address: Address, functionName: string, args: readonly unknown[]) {
  const req = { address, abi, functionName, args, account: wallet.account } as never;
  const gas = await pub.estimateContractGas(req);
  const hash = await wallet.writeContract({
    ...(req as object),
    chain,
    gas: (gas * 115n) / 100n,
  } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  log(`${functionName} ok (${hash})`);
}

for (const s of SERIES) {
  const id = assetIdOf(s.label);
  log(`${s.label}: assetId ${id}`);
  const feed = await pub.readContract({
    address: dep.dataStreamsResolver,
    abi,
    functionName: "feedIdOf",
    args: [id],
  });
  if (feed === "0x0000000000000000000000000000000000000000000000000000000000000000")
    await send(dep.dataStreamsResolver, "configureAsset", [id, s.feedId]);
  const fa = (await pub.readContract({
    address: dep.marketFactory,
    abi,
    functionName: "asset",
    args: [id],
  })) as { enabled: boolean };
  if (!fa.enabled)
    await send(dep.marketFactory, "setAsset", [id, dep.dataStreamsResolver, s.short, true]);
  const cfg = (await pub.readContract({
    address: dep.vault.vault,
    abi,
    functionName: "assetCfg",
    args: [id],
  })) as readonly [boolean, ...unknown[]];
  if (!cfg[0])
    await send(dep.vault.vault, "enableAsset", [
      id,
      BigInt(Math.round(s.sigmaMin * 1e18)),
      BigInt(Math.round(s.sigmaMax * 1e18)),
    ]);
  log(`${s.label}: ready`);
}
