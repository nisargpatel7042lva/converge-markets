/**
 * Prints the ADR-001 cost table from a spike evidence file.
 * Usage: pnpm --filter @converge/spike report [docs/evidence/phase-0/kuru-spike-fork.json]
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dailyCost, gasToUsd, meanGasLimit, type GasRecord } from "./cost-model";

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(
  here,
  "../../..",
  process.argv[2] ?? "docs/evidence/phase-0/kuru-spike-fork.json",
);
const data = JSON.parse(readFileSync(file, "utf8")) as { records: GasRecord[]; monUsd: number };

// Live Monad pricing read 2026-10-04: base fee 100 gwei (protocol floor) + 2 gwei priority.
const prices = { gasPriceWei: 102_000_000_000n, monUsd: data.monUsd };
const ROUNDS_PER_DAY = 3 * (96 + 24);
const LIVE_MARKETS = 6; // 3 assets x {15m, 1h}, one live round each

console.log(`source: ${file}`);
console.log(`price/gas: 102 gwei, MON/USD: ${prices.monUsd}`);
for (const p of ["kuru deployProxy", "requote", "unbatched cancel", "unbatched bid"]) {
  const g = meanGasLimit(data.records, p);
  console.log(
    `${p.padEnd(18)} gasLimit=${g.toFixed(0).padStart(8)}  usd=${gasToUsd(g, prices).toFixed(6)}`,
  );
}
console.log(
  `\nOption A (new Kuru market per round), ${ROUNDS_PER_DAY} rounds/day, ${LIVE_MARKETS} live markets`,
);
for (const [label, sec] of [
  ["every block (0.4s)", 0.4],
  ["every 2s", 2],
  ["every 10s", 10],
  ["every 60s", 60],
] as const) {
  const c = dailyCost(data.records, prices, ROUNDS_PER_DAY, LIVE_MARKETS, sec);
  console.log(
    `re-quote ${label.padEnd(20)} setup/day=$${c.setupPerDayUsd.toFixed(2)}  requote/day=$${c.requotePerDayUsd.toFixed(2)}  total/day=$${c.totalPerDayUsd.toFixed(2)}`,
  );
}
