/**
 * TESTNET: one scripted bet with the deployer wallet (what the app does for a user), to prove the live
 * keeper fills it. pnpm --filter @converge/keeper exec tsx scripts/testnet-bet.ts [UP|DOWN] [usd]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ORDER_KIND,
  askFromLadder,
  forwardVenueAbi,
  marketFactoryAbi,
  mockErc20Abi,
  planBuy,
} from "@converge/sdk";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const env = (k: string) =>
  readFileSync(`${root}.env`, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${k}=`))!
    .slice(k.length + 1)
    .trim();
const dep = JSON.parse(readFileSync(`${root}deployments/testnet.json`, "utf8"));
const side = (process.argv[2] ?? "UP").toUpperCase() as "UP" | "DOWN";
const usd = Number(process.argv[3] ?? 5);
const rpc = env("MONAD_TESTNET_RPC_URL");
const chain = defineChain({
  id: 10143,
  name: "Monad testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const pub = createPublicClient({ chain, transport: http(rpc) });
const w = createWalletClient({
  account: privateKeyToAccount(env("DEPLOYER_PRIVATE_KEY") as Hex),
  chain,
  transport: http(rpc),
});
const usdc: Address = dep.collateral_tUSDC;
const venue: Address = dep.vault.forwardVenue;
const send = async (req: Record<string, unknown>) => {
  const gas = await pub.estimateContractGas({ ...req, account: w.account } as never);
  const h = await w.writeContract({ ...req, chain, gas: (gas * 115n) / 100n } as never);
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error(`reverted ${String(req.functionName)}`);
  return r;
};
const t = Number((await pub.getBlock()).timestamp);
const start = Math.floor(t / 900) * 900;
const market = (await pub.readContract({
  address: dep.marketFactory,
  abi: marketFactoryAbi,
  functionName: "getMarket",
  args: [dep.assetTEST, 900n, BigInt(start)],
})) as Address;
const tick = (await (
  await fetch("https://api.exchange.coinbase.com/products/ETH-USD/ticker")
).json()) as { bid: string; ask: string };
const spot = (Number(tick.bid) + Number(tick.ask)) / 2;
console.log(
  `round ${new Date(start * 1000).toISOString().slice(11, 16)} ${market}, ${start + 900 - t}s left, ETH ${spot}`,
);
const q = await pub.readContract({
  address: venue,
  abi: forwardVenueAbi,
  functionName: "quoteAt",
  args: [market, BigInt(Math.round(spot * 1e8)) * 10n ** 10n, BigInt(t)],
});
const ask = askFromLadder(side, { quoting: q.quoting, bids: q.bids, asks: q.asks });
if (!ask) throw new Error("not quoting this round yet");
const plan = planBuy({
  side,
  budget: BigInt(Math.round(usd * 1e6)),
  priceWad: ask.priceWad,
  slippageBps: Number(process.env.SLIPPAGE_BPS ?? 200),
});
console.log(
  `${side} ask ${Number(ask.priceWad) / 1e18}: ${plan.shares} shares, escrow ${plan.escrow}`,
);
await send({
  address: usdc,
  abi: mockErc20Abi,
  functionName: "mint",
  args: [w.account.address, plan.escrow],
});
await send({
  address: usdc,
  abi: mockErc20Abi,
  functionName: "approve",
  args: [venue, plan.escrow],
});
const bal = async () =>
  (await pub.readContract({
    address: usdc,
    abi: mockErc20Abi,
    functionName: "balanceOf",
    args: [w.account.address],
  })) as bigint;
const before = await bal();
const min = (await pub.readContract({
  address: venue,
  abi: forwardVenueAbi,
  functionName: "minReward",
})) as bigint;
const r = await send({
  address: venue,
  abi: forwardVenueAbi,
  functionName: "placeOrder",
  args: [market, ORDER_KIND[plan.kind], plan.shares, plan.limitWad],
  value: min,
});
console.log(`placed in block ${r.blockNumber}; waiting for the keeper…`);
const id =
  ((await pub.readContract({
    address: venue,
    abi: forwardVenueAbi,
    functionName: "nextOrderId",
  })) as bigint) - 1n;
for (let i = 0; i < 60; i++) {
  await new Promise((x) => setTimeout(x, 1500));
  const o = (await pub.readContract({
    address: venue,
    abi: forwardVenueAbi,
    functionName: "orders",
    args: [id],
  })) as readonly unknown[];
  if (Number(o[2]) === 2) {
    console.log(
      `DONE after ~${(i + 1) * 1.5}s; net cost ${Number(before - (await bal())) / 1e6} USDC (0 would mean unfilled and refunded)`,
    );
    process.exit(0);
  }
}
throw new Error("keeper did not execute in 90 s");
