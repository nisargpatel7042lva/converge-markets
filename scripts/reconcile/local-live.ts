/**
 * LOCAL live load: keeps producing indexed events (split / merge / token transfers on the newest
 * market) at a steady rate while the indexer is running, so the lag monitor has something to chase.
 * Local anvil only (anvil dev keys).
 *
 * Usage: tsx local-live.ts [--duration 120] [--rate 4]    (rate = transactions per second)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Abi, Address } from "viem";
import { accountOf, artifact, localClients, ROOT } from "./lib/chain";
import { opt, parseArgs, rng, sleep } from "./lib/common";

const args = parseArgs(process.argv.slice(2));
const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:8611";
const duration = Number(opt(args, "duration", "DURATION", "120"));
const rate = Number(opt(args, "rate", "RATE", "4"));
const OUT_DIR = process.env.OUT_DIR ?? resolve(ROOT, ".local-indexer");
const a = JSON.parse(readFileSync(resolve(OUT_DIR, "addresses.json"), "utf8")) as {
  tusdc: Address;
  markets: { market: Address; up: Address; down: Address }[];
};
const { pub, wallet } = localClients(RPC);
const erc20 = artifact("MockERC20").abi;
const market = artifact("Market").abi as Abi;
const m = a.markets.at(-1)!;
const users = [5, 6, 7, 8, 9].map(accountOf);
const rand = rng(11);

let reverted = 0;
async function send(
  who: (typeof users)[number],
  address: Address,
  abi: Abi,
  fn: string,
  args: unknown[],
) {
  try {
    const hash = await wallet(who).writeContract({ address, abi, functionName: fn, args } as never);
    await pub.waitForTransactionReceipt({ hash });
  } catch {
    reverted++; // e.g. a merge without a pair or a transfer above the balance: expected now and then
  }
}

async function main() {
  for (const u of users) await send(u, a.tusdc, erc20 as Abi, "approve", [m.market, 2n ** 255n]);
  // every user holds some pairs to start with
  for (const u of users) await send(u, m.market, market, "split", [50_000_000n]);
  const end = Date.now() + duration * 1000;
  let n = 0;
  while (Date.now() < end) {
    const t0 = Date.now();
    const u = users[Math.floor(rand() * users.length)]!;
    const v = users[Math.floor(rand() * users.length)]!;
    const r = rand();
    if (r < 0.4)
      await send(u, m.market, market, "split", [BigInt(1 + Math.floor(rand() * 5)) * 1_000_000n]);
    else if (r < 0.6) await send(u, m.market, market, "merge", [1_000_000n]);
    else
      await send(u, rand() < 0.5 ? m.up : m.down, erc20 as Abi, "transfer", [
        v.address,
        1_000_000n,
      ]);
    n++;
    await sleep(Math.max(0, 1000 / rate - (Date.now() - t0)));
  }
  console.log(
    `live load done: ${n} txs (${reverted} reverted/skipped) in ${duration}s (head ${await pub.getBlockNumber()})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
