import { describe, expect, it } from "vitest";
import { KeeperFileSchema } from "../../../../services/keeper/src/config";
import { SIGMA_BANDS } from "../../src/constants";
import { appDeployment, keeperConfig } from "../../src/gen";
import type { Deployment } from "../../src/state";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const dep: Deployment = {
  chainId: 143,
  network: "mainnet",
  transactions: [],
  marketFactory: A(1),
  assets: {
    "BTC/USD": {
      assetId: `0x${"11".repeat(32)}`,
      kind: "streams",
      feedId: `0x0003${"ab".repeat(30)}`,
    },
    "ETH/USD": {
      assetId: `0x${"22".repeat(32)}`,
      kind: "streams",
      feedId: `0x0003${"cd".repeat(30)}`,
    },
    "MON/USD": { assetId: `0x${"33".repeat(32)}`, kind: "round", feed: A(9) },
  },
  vault: {
    vault: A(2),
    forwardVenue: A(3),
    deployBlock: 10,
    vaultKeeper: A(4),
    epochLength: 900,
    tvlCap: "5000000000",
    execDelaySeconds: 2,
    maxLatenessSeconds: 4,
  },
};

describe("generated mainnet configuration", () => {
  it("the keeper file passes the keeper's own schema and quotes only Data Streams assets", () => {
    const parsed = KeeperFileSchema.parse(keeperConfig(dep));
    expect(parsed.assets.map((a) => a.label)).toEqual(["BTC/USD", "ETH/USD"]);
    expect(parsed.assets[0]!.feedId).toBe(`0x0003${"ab".repeat(30)}`);
    expect(parsed.price.minSources).toBe(2);
    expect(parsed.reserveMon).toBeGreaterThanOrEqual(0.5);
  });

  it("each asset's volatility estimate is clamped inside the vault's sigma band (else setSigma reverts)", () => {
    const parsed = KeeperFileSchema.parse(keeperConfig(dep));
    for (const a of parsed.assets) {
      const band = SIGMA_BANDS[a.label]!;
      expect(a.vol.minAnnualVol).toBeCloseTo(Number(band.min) / 1e18, 12);
      expect(a.vol.maxAnnualVol).toBeCloseTo(Number(band.max) / 1e18, 12);
      expect(a.vol.priorAnnualVol).toBeGreaterThanOrEqual(a.vol.minAnnualVol);
      expect(a.vol.priorAnnualVol).toBeLessThanOrEqual(a.vol.maxAnnualVol);
    }
  });

  it("refuses to generate a keeper file when there is nothing the keeper can quote", () => {
    expect(() => keeperConfig({ ...dep, assets: { "MON/USD": dep.assets!["MON/USD"]! } })).toThrow(
      /no Data Streams asset/,
    );
  });

  it("the app lists BTC and ETH only (MON has no vault liquidity) and points at mainnet", () => {
    const a = appDeployment(dep, "https://rpc.example") as Record<string, unknown> & {
      series: { name: string }[];
    };
    expect(a.series.map((s) => s.name)).toEqual(["BTC", "ETH"]);
    expect(a.testnet).toBe(false);
    expect(a.chainId).toBe(143);
    expect(a.usdc).toBe("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
    expect(a.vault).toBe(A(2));
    expect(a.rpcUrl).toBe("https://rpc.example");
  });
});
