/**
 * LABELLED MOCK FEED: mirrors Chainlink MON/USD (Monad mainnet) into the local MockAggregator.
 * Each time the mainnet feed publishes a new round, a round with the same answer is written
 * locally with the local block time, so the local feed has the real ~30 s cadence and real prices.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { aggregatorV3Abi, mockAggregatorAbi } from "@converge/sdk";
import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const ROOT = resolve(process.cwd(), "../../..");
const dev = JSON.parse(readFileSync(resolve(ROOT, ".soak/devnet.json"), "utf8")) as {
  rpc: string;
  monFeed: Address;
  monMainnetFeed: Address;
};
const mainnet = createPublicClient({
  transport: http("https://rpc.monad.xyz", { timeout: 10_000 }),
});
const local = createPublicClient({
  chain: foundry,
  transport: http(dev.rpc),
  pollingInterval: 250,
});
// anvil dev key #4 (local only), separate from the scheduler and admin
const wallet = createWalletClient({
  account: privateKeyToAccount(
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  ),
  chain: foundry,
  transport: http(dev.rpc),
});
let lastMainnetRound = 0n;
let localRound = 1n;
for (;;) {
  try {
    const [rid, answer] = await mainnet.readContract({
      address: dev.monMainnetFeed,
      abi: aggregatorV3Abi,
      functionName: "latestRoundData",
    });
    if (rid !== lastMainnetRound) {
      lastMainnetRound = rid;
      localRound += 1n;
      const ts = (await local.getBlock()).timestamp;
      const hash = await wallet.writeContract({
        address: dev.monFeed,
        abi: mockAggregatorAbi,
        functionName: "setRound",
        args: [1, localRound, answer, ts],
      });
      await local.waitForTransactionReceipt({ hash });
      console.log(
        JSON.stringify({
          t: new Date().toISOString(),
          mainnetRound: String(rid),
          localRound: String(localRound),
          answer: String(answer),
          localTs: Number(ts),
        }),
      );
    }
  } catch (e) {
    console.log(JSON.stringify({ t: new Date().toISOString(), error: String(e).slice(0, 200) }));
  }
  await new Promise((r) => setTimeout(r, 5_000));
}
