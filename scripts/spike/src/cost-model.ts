/**
 * Cost model for ADR-001. Turns spike gas measurements into MON / USD per day.
 * Monad bills the declared gas LIMIT, not gas used
 * (https://docs.monad.xyz/developer-essentials/gas-pricing, verified 2026-10-04).
 */
export type GasRecord = { label: string; gasLimit: string; gasUsed: string };

export type Prices = {
  /** price per gas in wei (base fee + priority fee) */
  gasPriceWei: bigint;
  monUsd: number;
};

export function meanGasLimit(records: readonly GasRecord[], prefix: string): number {
  const xs = records.filter((r) => r.label.startsWith(prefix));
  if (xs.length === 0) throw new Error(`no records with prefix "${prefix}"`);
  return xs.reduce((s, r) => s + Number(r.gasLimit), 0) / xs.length;
}

export function gasToUsd(gas: number, p: Prices): number {
  return ((gas * Number(p.gasPriceWei)) / 1e18) * p.monUsd;
}

export type DailyCost = {
  setupPerRoundUsd: number;
  setupPerDayUsd: number;
  requotePerMarketPerDayUsd: number;
  requotePerDayUsd: number;
  totalPerDayUsd: number;
};

/**
 * @param roundsPerDay  markets created per day (e.g. 3 assets x (96 + 24))
 * @param liveMarkets   markets being quoted at any instant
 * @param requoteIntervalSec  seconds between re-quotes per market (0.4 = every Monad block)
 */
export function dailyCost(
  records: readonly GasRecord[],
  p: Prices,
  roundsPerDay: number,
  liveMarkets: number,
  requoteIntervalSec: number,
): DailyCost {
  const setupGas =
    meanGasLimit(records, "deploy outcome") +
    meanGasLimit(records, "kuru deployProxy") +
    meanGasLimit(records, "margin deposit") +
    meanGasLimit(records, "initial bid+ask");
  const setupPerRoundUsd = gasToUsd(setupGas, p);
  const requoteUsd = gasToUsd(meanGasLimit(records, "requote"), p);
  const requotePerMarketPerDayUsd = requoteUsd * (86_400 / requoteIntervalSec);
  const setupPerDayUsd = setupPerRoundUsd * roundsPerDay;
  const requotePerDayUsd = requotePerMarketPerDayUsd * liveMarkets;
  return {
    setupPerRoundUsd,
    setupPerDayUsd,
    requotePerMarketPerDayUsd,
    requotePerDayUsd,
    totalPerDayUsd: setupPerDayUsd + requotePerDayUsd,
  };
}
