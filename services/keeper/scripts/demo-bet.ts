/**
 * Places one bet on the running demo stack (.demo/chain.json) exactly as the app would, and waits for
 * the keeper to fill it: mint test USDC, approve the venue, placeOrder, poll the order.
 *   pnpm --filter @converge/keeper exec tsx scripts/demo-bet.ts [UP|DOWN] [usd]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  forwardVenueAbi,
  marketFactoryAbi,
  mockErc20Abi,
  planBuy,
  askFromLadder,
  ORDER_KIND,
} from "@converge/sdk";
import { createPublicClient, createWalletClient, defineChain, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ASSET_ID, KEYS } from "../test/support/stack";

const info = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../.demo/chain.json", import.meta.url)), "utf8"),
) as {
  rpc: string;
  deployment: { chainId: number; usdc: Address; factory: Address; venue: Address };
};
const side = (process.argv[2] ?? "UP").toUpperCase() as "UP" | "DOWN";
const usd = Number(process.argv[3] ?? 5);
const chain = defineChain({
  id: info.deployment.chainId,
  name: "demo",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [info.rpc] } },
});
const pub = createPublicClient({ chain, transport: http(info.rpc) });
const admin = createWalletClient({
  account: privateKeyToAccount(KEYS.admin),
  chain,
  transport: http(info.rpc),
});
const taker = createWalletClient({
  account: privateKeyToAccount(KEYS.taker),
  chain,
  transport: http(info.rpc),
});
const send = async (w: typeof admin, req: Record<string, unknown>) => {
  const h = await w.writeContract({ ...req, chain, gas: 1_500_000n } as never);
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error(`reverted: ${String(req.functionName)}`);
  return r;
};
const usdc = info.deployment.usdc;
const bal = async () =>
  (await pub.readContract({
    address: usdc,
    abi: mockErc20Abi,
    functionName: "balanceOf",
    args: [taker.account.address],
  })) as bigint;

const t = Number((await pub.getBlock()).timestamp);
const start = Math.floor(t / 900) * 900;
const market = (await pub.readContract({
  address: info.deployment.factory,
  abi: marketFactoryAbi,
  functionName: "getMarket",
  args: [ASSET_ID, 900n, BigInt(start)],
})) as Address;
console.log(
  `round ${new Date(start * 1000).toISOString().slice(11, 16)} market ${market}, ${start + 900 - t}s left`,
);
const q = await pub.readContract({
  address: info.deployment.venue,
  abi: forwardVenueAbi,
  functionName: "quoteAt",
  args: [market, 3000n * 10n ** 18n, BigInt(t)],
});
const ask = askFromLadder(side, { quoting: q.quoting, bids: q.bids, asks: q.asks });
if (!ask)
  throw new Error(
    "the vault is not quoting this round yet (the keeper needs a few seconds after it opens)",
  );
const plan = planBuy({
  side,
  budget: BigInt(Math.round(usd * 1e6)),
  priceWad: ask.priceWad,
  slippageBps: 300,
});
console.log(
  `${side} ask ${Number(ask.priceWad) / 1e18} -> ${plan.shares} shares, escrow ${plan.escrow}`,
);
await send(admin, {
  address: usdc,
  abi: mockErc20Abi,
  functionName: "mint",
  args: [taker.account.address, plan.escrow],
});
await send(taker, {
  address: usdc,
  abi: mockErc20Abi,
  functionName: "approve",
  args: [info.deployment.venue, plan.escrow],
});
const before = await bal();
await send(taker, {
  address: info.deployment.venue,
  abi: forwardVenueAbi,
  functionName: "placeOrder",
  args: [market, ORDER_KIND[plan.kind], plan.shares, plan.limitWad],
  value: 10n ** 15n,
});
const id =
  ((await pub.readContract({
    address: info.deployment.venue,
    abi: forwardVenueAbi,
    functionName: "nextOrderId",
  })) as bigint) - 1n;
console.log(`order ${id} placed; waiting for the keeper to execute it…`);
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const o = (await pub.readContract({
    address: info.deployment.venue,
    abi: forwardVenueAbi,
    functionName: "orders",
    args: [id],
  })) as readonly unknown[];
  if (Number(o[2]) === 2) {
    const spent = before - (await bal());
    const tokens = (await pub.readContract({
      address: usdc,
      abi: mockErc20Abi,
      functionName: "balanceOf",
      args: [taker.account.address],
    })) as bigint;
    console.log(
      `EXECUTED after ${i + 1}s: escrow released, net cost ${Number(spent) / 1e6} USDC, wallet USDC ${Number(tokens) / 1e6}`,
    );
    process.exit(0);
  }
}
throw new Error("not executed in 60 s");
