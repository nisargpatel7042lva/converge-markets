import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import type { Deployment } from "./lister";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
export const STATE_PATH = `${root}deployments/kuru-testnet.json`;

/** One key out of the repo's untracked `.env`; never printed. */
export function envKey(k: string): string {
  const line = readFileSync(`${root}.env`, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${k}=`));
  if (!line) throw new Error(`${k} missing in .env`);
  return line.slice(k.length + 1).trim();
}

export const makerKey = (): Hex =>
  envKey(process.env.KURU_MAKER_KEY_NAME ?? "DEPLOYER_PRIVATE_KEY") as Hex;
export const rpcUrl = (): string => process.env.RPC_URL ?? "https://rpc-testnet.monadinfra.com";

export function loadDeployment(): Deployment {
  return JSON.parse(readFileSync(`${root}deployments/testnet.json`, "utf8")) as Deployment;
}

/** The keeper's reference price (median of Binance and Coinbase) from the local relay; Coinbase if it is down. */
export async function refPrice(): Promise<number> {
  try {
    const j = (await (
      await fetch("http://127.0.0.1:9203/price", { signal: AbortSignal.timeout(2000) })
    ).json()) as { price: number };
    if (j.price > 0) return j.price;
  } catch {
    /* fall through */
  }
  const j = (await (
    await fetch("https://api.exchange.coinbase.com/products/ETH-USD/ticker", {
      signal: AbortSignal.timeout(5000),
    })
  ).json()) as { bid: string; ask: string };
  return (Number(j.bid) + Number(j.ask)) / 2;
}
