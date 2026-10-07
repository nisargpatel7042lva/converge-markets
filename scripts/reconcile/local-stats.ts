/**
 * Counts the indexed-event types on the local chain (what the indexer should have seen), straight
 * from RPC logs. Used as evidence that the local activity covers every handler.
 * Usage: pnpm --filter @converge/reconcile exec tsx local-stats.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Abi, type Address, decodeEventLog } from "viem";
import { artifact, localClients, ROOT } from "./lib/chain";

const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:8611";
const OUT_DIR = process.env.OUT_DIR ?? resolve(ROOT, ".local-indexer");
const a = JSON.parse(readFileSync(resolve(OUT_DIR, "addresses.json"), "utf8")) as {
  factory: Address;
  vault: Address;
  venue: Address;
  markets: { market: Address; up: Address; down: Address }[];
};
const { pub } = localClients(RPC);

const counts = new Map<string, number>();
async function count(address: Address[], abi: Abi, label: string) {
  const logs = await pub.getLogs({ address, fromBlock: 0n });
  for (const l of logs) {
    try {
      const ev = decodeEventLog({ abi, data: l.data, topics: l.topics });
      const k = `${label}.${ev.eventName}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    } catch {
      /* not in this ABI */
    }
  }
}
await count([a.factory], artifact("MarketFactory").abi, "MarketFactory");
await count([a.vault], artifact("ConvergeVault").abi, "ConvergeVault");
await count([a.venue], artifact("ForwardVenue").abi, "ForwardVenue");
await count(
  a.markets.map((m) => m.market),
  artifact("Market").abi,
  "Market",
);
await count(
  a.markets.flatMap((m) => [m.up, m.down]),
  artifact("OutcomeToken").abi,
  "OutcomeToken",
);
const rows = [...counts.entries()].sort();
for (const [k, v] of rows) console.log(`${k.padEnd(40)} ${v}`);
console.log(`TOTAL ${rows.reduce((s, [, v]) => s + v, 0)}`);
