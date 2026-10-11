/**
 * All-time traded volume of the current testnet venue, from its OrderExecuted events. Resumable: it reads the
 * existing snapshot (apps/web/src/config/stats-snapshot.json) and continues from its last block, so the /api/stats
 * route only has to top up the last few minutes. Rate limited (the public RPC allows about 15 requests/s per IP,
 * shared with the keeper and the scheduler) and `eth_getLogs` is capped at 100 blocks per call on Monad.
 *
 *   pnpm --filter @converge/keeper exec tsx scripts/stats-volume.ts
 *
 * Volume = the sum of `premium` (the collateral paid for, or received from, the shares: 6 decimals) of orders that
 * filled. One order is one trade, whatever the number of price levels it crossed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, defineChain, http, parseAbiItem, type Address } from "viem";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dep = JSON.parse(readFileSync(`${root}deployments/testnet.json`, "utf8")) as {
  chainId: number;
  vault: { forwardVenue: Address; deployBlock: number };
};
const OUT = `${root}apps/web/src/config/stats-snapshot.json`;
const rpc = process.env.RPC_URL ?? "https://rpc-testnet.monadinfra.com";
const chain = defineChain({
  id: dep.chainId,
  name: "Monad testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const pub = createPublicClient({ chain, transport: http(rpc, { retryCount: 3, retryDelay: 400 }) });
const ev = parseAbiItem(
  "event OrderExecuted(uint256 indexed id, address indexed executor, uint256 filled, uint256 premium, uint256 reportPrice, uint32 reportValidFrom, uint32 reportObservations)",
);

type Snap = {
  chainId: number;
  venue: Address;
  fromBlock: number;
  toBlock: number;
  executed: number;
  trades: number;
  volumeUsd6: string;
  generatedAt: string;
};
const prev: Snap | null = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as Snap) : null;
const reuse = prev && prev.venue.toLowerCase() === dep.vault.forwardVenue.toLowerCase();
let snap: Snap = reuse
  ? prev!
  : {
      chainId: dep.chainId,
      venue: dep.vault.forwardVenue,
      fromBlock: dep.vault.deployBlock,
      toBlock: dep.vault.deployBlock - 1,
      executed: 0,
      trades: 0,
      volumeUsd6: "0",
      generatedAt: "",
    };

const head = Number(await pub.getBlockNumber()) - 2;
const STEP = 100;
const RPS = Number(process.env.RPS ?? 5);
let volume = BigInt(snap.volumeUsd6);
let from = snap.toBlock + 1;
let calls = 0;
const save = (to: number) => {
  snap = {
    ...snap,
    toBlock: to,
    volumeUsd6: volume.toString(),
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(OUT, JSON.stringify(snap, null, 2) + "\n");
};
const WORKERS = Number(process.env.WORKERS ?? 4);
while (from <= head) {
  // WORKERS ranges at once (the public RPC answers in about a second, so one at a time is far too slow); the
  // results are applied in block order so the snapshot's toBlock is always contiguous
  const ranges: [number, number][] = [];
  for (let i = 0; i < WORKERS && from <= head; i++) {
    const to = Math.min(from + STEP - 1, head);
    ranges.push([from, to]);
    from = to + 1;
  }
  const results = await Promise.all(
    ranges.map(([f, t]) =>
      pub.getLogs({ address: snap.venue, event: ev, fromBlock: BigInt(f), toBlock: BigInt(t) }),
    ),
  );
  for (const logs of results)
    for (const l of logs) {
      snap.executed += 1;
      if (l.args.filled! > 0n) {
        snap.trades += 1;
        volume += l.args.premium!;
      }
    }
  const last = ranges[ranges.length - 1]![1];
  calls += ranges.length;
  if (calls % 40 === 0) {
    save(last);
    console.log(
      `block ${last} / ${head} (${(((last - snap.fromBlock) / (head - snap.fromBlock)) * 100).toFixed(1)}%): ${snap.trades} trades, $${(Number(volume) / 1e6).toFixed(2)}`,
    );
  }
  await new Promise((r) => setTimeout(r, (ranges.length * 1000) / RPS));
}
save(head);
console.log(
  `done at block ${head}: ${snap.trades} filled trades of ${snap.executed} executed orders, volume $${(Number(volume) / 1e6).toFixed(2)}`,
);
