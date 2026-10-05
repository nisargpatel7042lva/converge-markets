/** `pnpm --filter @converge/backtest verify-data`: every archive matches the pinned manifest. */
import { dataStats } from "./pipeline/stages";

const stats = dataStats(); // loadSeries() checks each archive's SHA-256 against data/manifest.json
for (const s of stats) {
  console.log(
    `${s.asset}: ${s.days} days, ${s.samples} samples, ${s.missingSamples} missing, verified`,
  );
}
