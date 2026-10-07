/**
 * Creates the partner market the page embeds:
 *   pnpm create-market --asset TEST/USD --strike 3200 --end 2026-10-08T20:00:00Z
 *   pnpm create-market --asset TEST/USD --strike 3200 --in 1h
 * Uses the partner key from .env (PARTNER_PRIVATE_KEY) and deployments/<NETWORK>.json (default
 * "testnet"). Prints the market address to put in NEXT_PUBLIC_MARKET.
 */
import { createConvergeClient } from "@converge/sdk";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { key, loadEnv, readAddresses } from "./env";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function endTime(): Date {
  const abs = arg("end");
  if (abs) return new Date(abs);
  const rel = /^(\d+)([mhd])$/.exec(arg("in") ?? "");
  if (!rel) throw new Error("pass --end <ISO time> or --in <15m|1h|2d>");
  const unit = { m: 60, h: 3600, d: 86_400 }[rel[2] as "m" | "h" | "d"];
  return new Date(Date.now() + Number(rel[1]) * unit * 1000 + 30_000);
}

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
  const account = privateKeyToAccount(key("PARTNER_PRIVATE_KEY"));
  const walletClient = createWalletClient({ account, chain, transport: http(rpc) });
  const converge = createConvergeClient({ publicClient, walletClient, addresses });

  const me = await converge.getPartner();
  if (!me.approved) throw new Error(`${account.address} is not an approved partner`);
  if (!me.canCreate) {
    console.log(`posting a bond of ${Number(me.minBond) / 1e6} (the minimum)`);
    await converge.postBond(String(Number(me.minBond) / 1e6));
  }
  const strike = arg("strike") ?? "3200";
  const created = await converge.createPartnerMarket({
    asset: arg("asset") ?? "TEST/USD",
    strike,
    end: endTime(),
  });
  console.log(JSON.stringify(created, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`\nNEXT_PUBLIC_MARKET=${created.market}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
