import { describe, expect, it } from "vitest";
import { dailyCost, gasToUsd, meanGasLimit, type GasRecord } from "./cost-model";

const rec = (label: string, gasLimit: number): GasRecord => ({
  label,
  gasLimit: String(gasLimit),
  gasUsed: String(gasLimit),
});

describe("cost model", () => {
  it("prices the Monad docs reference tx: 200k gas at 100 gwei = 0.02 MON", () => {
    // https://docs.monad.xyz/developer-essentials/gas-pricing worked example
    expect(gasToUsd(200_000, { gasPriceWei: 100_000_000_000n, monUsd: 1 })).toBeCloseTo(0.02, 12);
  });

  it("averages gas limit by label prefix and rejects unknown prefixes", () => {
    const rs = [rec("requote 01", 100), rec("requote 02", 300), rec("other", 9)];
    expect(meanGasLimit(rs, "requote")).toBe(200);
    expect(() => meanGasLimit(rs, "missing")).toThrow();
  });

  it("scales re-quote cost with frequency and live markets", () => {
    const rs = [
      rec("deploy outcome r1", 1_000_000),
      rec("approve outcome", 100_000),
      rec("kuru deployProxy r1", 1_000_000),
      rec("margin deposit a", 500_000),
      rec("initial bid+ask", 500_000),
      rec("teardown cancel", 250_000),
      rec("margin withdraw outcome", 125_000),
      rec("requote 01", 1_000_000),
    ];
    const p = { gasPriceWei: 1_000_000_000_000n, monUsd: 1 }; // 1e-6 MON per gas
    const c = dailyCost(rs, p, 10, 2, 1);
    expect(c.setupPerRoundUsd).toBeCloseTo(4.1, 9); // 1+0.1+1+2*0.5+0.5+0.25+2*0.125 Mgas
    expect(c.setupPerDayUsd).toBeCloseTo(41, 9);
    expect(c.requotePerMarketPerDayUsd).toBeCloseTo(86_400, 6);
    expect(c.requotePerDayUsd).toBeCloseTo(172_800, 6);
    expect(c.totalPerDayUsd).toBeCloseTo(172_841, 6);
  });
});
