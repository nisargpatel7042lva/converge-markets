/** `pnpm backtest:data`: downloads and verifies the Binance archives, pins them in the manifest. */
import { downloadAll, loadSeries } from "./data/binance";

const labels = process.argv.slice(2);
const targets = labels.length > 0 ? labels : ["BTC/USD", "ETH/USD", "MON/USD"];
console.log(`downloading ${targets.join(", ")} ...`);
await downloadAll(targets);
for (const l of targets) {
  const { stats } = loadSeries(l);
  console.log(
    `${l}: ${stats.days} days ${stats.firstDay}..${stats.lastDay}, ${stats.samples} samples, ` +
      `${stats.missingSamples} forward-filled (${stats.missingPct.toFixed(4)}%), longest gap ${stats.longestGapSec}s`,
  );
}
