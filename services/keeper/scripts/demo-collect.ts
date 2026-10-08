/**
 * Collects the demo taker's winnings on every resolved round (what the app's "collect" button does).
 *   pnpm --filter @converge/keeper exec tsx scripts/demo-collect.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { marketAbi, marketFactoryAbi, mockErc20Abi } from "@converge/sdk";
import { createPublicClient, createWalletClient, defineChain, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ASSET_ID, KEYS } from "../test/support/stack";

const info = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../.demo/chain.json", import.meta.url)), "utf8"),
) as { rpc: string; deployment: { chainId: number; usdc: Address; factory: Address } };
const chain = defineChain({
  id: info.deployment.chainId,
  name: "demo",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [info.rpc] } },
});
const pub = createPublicClient({ chain, transport: http(info.rpc) });
const taker = createWalletClient({
  account: privateKeyToAccount(KEYS.taker),
  chain,
  transport: http(info.rpc),
});
const me = taker.account.address;
const t = Number((await pub.getBlock()).timestamp);
const cur = Math.floor(t / 900) * 900;
for (let k = -8; k <= 0; k++) {
  const start = cur + k * 900;
  const m = (await pub.readContract({
    address: info.deployment.factory,
    abi: marketFactoryAbi,
    functionName: "getMarket",
    args: [ASSET_ID, 900n, BigInt(start)],
  })) as Address;
  if (/^0x0+$/.test(m)) continue;
  const state = Number(
    await pub.readContract({ address: m, abi: marketAbi, functionName: "state" }),
  );
  const up = (await pub.readContract({
    address: m,
    abi: marketAbi,
    functionName: "up",
  })) as Address;
  const down = (await pub.readContract({
    address: m,
    abi: marketAbi,
    functionName: "down",
  })) as Address;
  const bal = async (a: Address) =>
    (await pub.readContract({
      address: a,
      abi: mockErc20Abi,
      functionName: "balanceOf",
      args: [me],
    })) as bigint;
  const [u, d] = [await bal(up), await bal(down)];
  if (u === 0n && d === 0n) continue;
  const label = new Date(start * 1000).toISOString().slice(11, 16);
  if (state !== 2 && state !== 3 && state !== 4) {
    console.log(
      `round ${label}: still running (holding UP ${Number(u) / 1e6}, DOWN ${Number(d) / 1e6})`,
    );
    continue;
  }
  const before = await bal(info.deployment.usdc);
  const h = await taker.writeContract({
    address: m,
    abi: marketAbi,
    functionName: "redeem",
    chain,
    gas: 400_000n,
  });
  await pub.waitForTransactionReceipt({ hash: h });
  const after = await bal(info.deployment.usdc);
  console.log(
    `round ${label} ${state === 2 ? "UP won" : state === 3 ? "DOWN won" : "INVALID"}: held UP ${Number(u) / 1e6} / DOWN ${Number(d) / 1e6}, collected ${Number(after - before) / 1e6} USDC`,
  );
}
