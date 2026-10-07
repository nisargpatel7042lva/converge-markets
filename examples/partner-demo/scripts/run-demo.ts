/**
 * The testnet run of the whole partner journey (create, quote, trade, resolve, redeem) with the
 * accounts in .env, using the same function as the anvil end-to-end test. Takes about 20 minutes:
 * the shortest market is 15 minutes. Needs the deployment from contracts/script/deploy-partners.sh,
 * the keeper running against it, MON in the partner and trader accounts, and (testnet only)
 * STREAMS_TEST_SIGNER_KEY for the end price. Writes docs/evidence/phase-8/testnet-demo.json.
 *   pnpm --filter partner-demo exec tsx scripts/run-demo.ts [--spot 3150] [--strike 3150]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { TestSignerStreamsSource, mockErc20Abi } from "@converge/sdk";
import { createPublicClient, createWalletClient, defineChain, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { runDemoFlow } from "../lib/flow";
import { key, loadEnv, readAddresses, repoRoot } from "./env";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  loadEnv();
  const network = process.env.NETWORK ?? "testnet";
  const { chainId, addresses } = readAddresses(network);
  const rpc = process.env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz";
  const chain = defineChain({
    id: chainId,
    name: network,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const partner = privateKeyToAccount(key("PARTNER_PRIVATE_KEY"));
  const taker = privateKeyToAccount(key("TAKER_PRIVATE_KEY"));
  const signer = privateKeyToAccount(key("STREAMS_TEST_SIGNER_KEY"));
  const partnerWallet = createWalletClient({ account: partner, chain, transport: http(rpc) });
  const takerWallet = createWalletClient({ account: taker, chain, transport: http(rpc) });

  for (const [name, a] of [
    ["partner", partner.address],
    ["trader", taker.address],
  ] as const) {
    const bal = await publicClient.getBalance({ address: a });
    console.log(`${name} ${a} holds ${Number(bal) / 1e18} MON`);
    if (bal < parseEther("0.3")) throw new Error(`${name} needs about 0.3 MON for gas: fund ${a}`);
  }

  const spot = Number(arg("spot") ?? 3000);
  const strike = arg("strike") ?? String(spot);
  const endPrice = Number(arg("end-price") ?? spot * 1.01);
  let endTime = 0;
  const evidence = await runDemoFlow({
    publicClient,
    partnerWallet,
    takerWallet,
    addresses,
    asset: "TEST/USD",
    strike,
    spot,
    durationSec: 15 * 60 + 60,
    buyUsd: "3",
    reports: new TestSignerStreamsSource(signer, async (ts) => {
      const p = Number(ts) >= endTime && endTime > 0 ? endPrice : spot;
      return BigInt(Math.round(p * 1e8)) * 10n ** 10n;
    }),
    chainNow: async () => Number((await publicClient.getBlock()).timestamp),
    waitUntil: async (end) => {
      endTime = end;
      while (Number((await publicClient.getBlock()).timestamp) < end + 1) {
        await new Promise((r) => setTimeout(r, 2_000));
      }
    },
    fundTaker: async () => {
      const bal = (await publicClient.readContract({
        address: addresses.collateral,
        abi: mockErc20Abi,
        functionName: "balanceOf",
        args: [taker.address],
      })) as bigint;
      if (bal >= 20_000_000n) return;
      const hash = await takerWallet.writeContract({
        address: addresses.collateral,
        abi: mockErc20Abi,
        functionName: "mint",
        args: [taker.address, 100_000_000n],
        chain,
        account: taker,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    },
    onStep: (s, d) => console.log(s, JSON.stringify(d)),
  });
  const dir = resolve(repoRoot, "docs/evidence/phase-8");
  mkdirSync(dir, { recursive: true });
  const out = resolve(dir, "testnet-demo.json");
  writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log(`evidence written to ${out}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
