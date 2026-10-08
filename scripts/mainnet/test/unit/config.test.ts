import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeFunctionData, getAddress, toFunctionSelector, zeroHash } from "viem";
import { describe, expect, it } from "vitest";
import * as K from "../../src/constants";
import { checkStreamFeedId, validateConfig, type DeployConfig } from "../../src/deploy";
import { loadLaunchParams, repoRoot, wad } from "../../src/params";
import {
  HANDOVER_SALT,
  LAUNCH_SALT,
  handoverBatch,
  handoverCalls,
  launchExecuteBatch,
  launchScheduleBatch,
  timelockAbi,
} from "../../src/safe";
import type { Deployment } from "../../src/state";

const external = readFileSync(resolve(repoRoot, "docs/EXTERNAL.md"), "utf8");

describe("constants are the ones in docs/EXTERNAL.md", () => {
  const addresses: Record<string, string> = {
    USDC: K.USDC,
    VERIFIER_PROXY: K.VERIFIER_PROXY,
    CRE_FORWARDER: K.CRE_FORWARDER,
    MON_USD_FEED: K.MON_USD_FEED,
    ...Object.fromEntries(Object.entries(K.SAFE).map(([k, v]) => [`SAFE.${k}`, v])),
  };
  for (const [name, a] of Object.entries(addresses)) {
    it(`${name} appears verbatim, checksummed`, () => {
      expect(getAddress(a)).toBe(a);
      expect(external).toContain(a);
    });
  }
  it("is on Monad mainnet", () => {
    expect(K.MAINNET_CHAIN_ID).toBe(143);
  });
});

describe("launch parameters", () => {
  it("convert from config/strategy.default.json without float error", () => {
    expect(wad(0.05)).toBe(50_000_000_000_000_000n);
    expect(wad(0.02)).toBe(20_000_000_000_000_000n);
    const p = loadLaunchParams();
    expect(p.minHalfSpread).toBe(50_000_000_000_000_000n);
    expect(p.stalenessSec).toBe(4_000_000_000_000_000_000n);
    expect(p.levels).toBe(2n);
    expect(p.noQuoteWindowSec).toBe(30n);
    expect(p.perMarketMaxFraction).toBe(10_000_000_000_000_000n);
    expect(p.totalAtRiskMaxFraction).toBe(80_000_000_000_000_000n);
  });

  it("satisfy the vault's own hard limits (ConvergeVault._validateParams), so the constructor will not revert", () => {
    const p = loadLaunchParams();
    const W = 10n ** 18n;
    expect(p.tick > 0n && p.tick <= W / 20n).toBe(true);
    expect(p.levels >= 1n && p.levels <= 4n).toBe(true);
    expect(p.minHalfSpread >= W / 50n && p.minHalfSpread <= p.maxHalfSpread).toBe(true);
    expect(p.maxHalfSpread <= W / 2n).toBe(true);
    expect(
      p.priceMin >= W / 100n && p.priceMax <= (99n * W) / 100n && p.priceMin < p.priceMax,
    ).toBe(true);
    expect(p.minRangeTicks > 0n && p.minRangeTicks <= p.baseRangeTicks).toBe(true);
    expect(p.liquidityNavFraction <= W / 2n).toBe(true);
    expect(p.perMarketMaxFraction > 0n && p.perMarketMaxFraction <= W / 20n).toBe(true);
    expect(
      p.totalAtRiskMaxFraction <= (2n * W) / 5n &&
        p.totalAtRiskMaxFraction >= p.perMarketMaxFraction,
    ).toBe(true);
    expect(p.inventorySkewMax <= W / 2n).toBe(true);
    expect(p.noQuoteWindowSec >= 10n).toBe(true);
  });

  it("keep the conservative launch risk: 1 % per market, 8 % in total", () => {
    const p = loadLaunchParams();
    expect(p.perMarketMaxFraction).toBe(wad(0.01));
    expect(p.totalAtRiskMaxFraction).toBe(wad(0.08));
  });

  it("sigma bands are inside the vault's allowed range (1 % to 1,000 %)", () => {
    for (const b of Object.values(K.SIGMA_BANDS)) {
      expect(b.min >= wad(0.01) && b.max <= wad(10) && b.min <= b.max).toBe(true);
    }
  });

  it("default TVL cap is the 5,000 USD launch cap and the minimum request exceeds the dead shares", () => {
    expect(K.DEFAULT_TVL_CAP).toBe(5_000_000_000n);
    expect(K.MIN_REQUEST > 1000n).toBe(true);
  });
});

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const GOOD_ID = `0x0003${"ab".repeat(30)}`;
const OTHER_ID = `0x0003${"cd".repeat(30)}`;
const base = (over: Partial<DeployConfig> = {}): DeployConfig => ({
  network: "rehearsal",
  chainId: 143,
  safe: A(1),
  guardian: A(2),
  keeper: A(3),
  scheduler: A(4),
  treasury: A(1),
  tvlCap: 5_000_000_000n,
  enablePartners: false,
  leader: "fallback",
  timelockDelaySec: 86_400,
  assets: [
    { label: "BTC/USD", symbol: "BTC", resolver: "streams", streamsFeedId: GOOD_ID },
    { label: "ETH/USD", symbol: "ETH", resolver: "streams", streamsFeedId: OTHER_ID },
    { label: "MON/USD", symbol: "MON", resolver: "round" },
  ],
  ...over,
});

describe("the deployer refuses an unsafe configuration before sending anything", () => {
  const deployer = A(9);
  it("accepts a clean one", () => {
    expect(() => validateConfig(base(), deployer)).not.toThrow();
  });
  it("refuses a placeholder or malformed Data Streams feed id (they are written to an immutable resolver)", () => {
    expect(() => checkStreamFeedId("BTC/USD", `0x${"00".repeat(32)}`)).toThrow(/placeholder/);
    expect(() => checkStreamFeedId("BTC/USD", undefined)).toThrow(/placeholder/);
    expect(() => checkStreamFeedId("BTC/USD", "0x1234")).toThrow(/placeholder/);
    expect(() => checkStreamFeedId("BTC/USD", `0x0002${"ab".repeat(30)}`)).toThrow(/v3 stream id/);
    expect(checkStreamFeedId("BTC/USD", GOOD_ID)).toBe(GOOD_ID);
    const zero = base({
      assets: [
        {
          label: "BTC/USD",
          symbol: "BTC",
          resolver: "streams",
          streamsFeedId: `0x${"00".repeat(32)}`,
        },
      ],
    });
    expect(() => validateConfig(zero, deployer)).toThrow(/placeholder/);
  });
  it("the repository's own config/series.json still holds placeholders, so a mainnet deploy is refused today", () => {
    const series = JSON.parse(readFileSync(resolve(repoRoot, "config/series.json"), "utf8")) as {
      assets: { label: string; resolver: string; streamsFeedId?: string }[];
    };
    const streams = series.assets.filter((a) => a.resolver === "streams");
    expect(streams.length).toBeGreaterThan(0);
    // when real stream ids are committed this test stops asserting the refusal and starts asserting acceptance
    const placeholders = streams.every((a) => /^0x0+$/.test(a.streamsFeedId ?? ""));
    const run = () =>
      validateConfig(base({ assets: series.assets as DeployConfig["assets"] }), deployer);
    if (placeholders) expect(run).toThrow(/placeholder/);
    else expect(run).not.toThrow();
  });
  it("refuses a role that is the deployer key, or two roles that are the same key", () => {
    expect(() => validateConfig(base({ keeper: deployer }), deployer)).toThrow(/deployer key/);
    expect(() => validateConfig(base({ guardian: A(3) }), deployer)).toThrow(/same address/);
    expect(() => validateConfig(base({ scheduler: A(1) }), deployer)).toThrow(/same address/);
    expect(() =>
      validateConfig(base({ safe: "0x0000000000000000000000000000000000000000" }), deployer),
    ).toThrow(/not set/);
  });
  it("refuses a TVL cap of zero or above 100,000 USDC, and a config with no Data Streams asset", () => {
    expect(() => validateConfig(base({ tvlCap: 0n }), deployer)).toThrow(/TVL cap/);
    expect(() => validateConfig(base({ tvlCap: 100_000_000_001n }), deployer)).toThrow(/TVL cap/);
    expect(() =>
      validateConfig(
        base({ assets: [{ label: "MON/USD", symbol: "MON", resolver: "round" }] }),
        deployer,
      ),
    ).toThrow(/no Data Streams asset/);
  });
  it("refuses two assets on one feed id (the vault accepts one asset per feed)", () => {
    expect(() =>
      validateConfig(
        base({
          assets: [
            { label: "BTC/USD", symbol: "BTC", resolver: "streams", streamsFeedId: GOOD_ID },
            { label: "ETH/USD", symbol: "ETH", resolver: "streams", streamsFeedId: GOOD_ID },
          ],
        }),
        deployer,
      ),
    ).toThrow(/share one Data Streams feed id/);
  });
  it("refuses a Data Streams asset without a sigma band", () => {
    expect(() =>
      validateConfig(
        base({
          assets: [
            { label: "DOGE/USD", symbol: "DOGE", resolver: "streams", streamsFeedId: GOOD_ID },
          ],
        }),
        deployer,
      ),
    ).toThrow(/sigma band/);
  });
});

describe("the owner timelock", () => {
  const deployer = A(9);
  it("refuses a delay that is too short for mainnet (the delay is the LPs' warning time)", () => {
    expect(() =>
      validateConfig(base({ network: "mainnet", timelockDelaySec: 3599 }), deployer),
    ).toThrow(/out of range/);
    expect(() =>
      validateConfig(base({ network: "mainnet", timelockDelaySec: 3600 }), deployer),
    ).not.toThrow();
    expect(() => validateConfig(base({ timelockDelaySec: 59 }), deployer)).toThrow(/out of range/);
    expect(() => validateConfig(base({ timelockDelaySec: 1.5 }), deployer)).toThrow(/out of range/);
  });
});

describe("Safe batches", () => {
  const d: Deployment = {
    chainId: 143,
    network: "rehearsal",
    transactions: [],
    timelock: A(20),
    dataStreamsResolver: A(11),
    vault: {
      vault: A(12),
      forwardVenue: A(13),
      deployBlock: 1,
      vaultKeeper: A(3),
      epochLength: 900,
      tvlCap: "1",
      execDelaySeconds: 2,
      maxLatenessSeconds: 4,
    },
    partners: {
      partnerRegistry: A(14),
      deployBlock: 1,
      thresholdResolverImplementation: A(15),
      minBond: "1",
      globalExposureCap: "1",
      redeemFeeBps: 50,
    },
  };

  it("the handover accepts ownership of exactly the contracts that exist, then raises the timelock delay", () => {
    const calls = handoverCalls(d, 86_400);
    expect(calls.map((c) => c.to)).toEqual([A(12), A(11), A(14), A(20)]);
    for (const c of calls.slice(0, 3)) expect(c.data).toBe(toFunctionSelector("acceptOwnership()"));
    const last = decodeFunctionData({ abi: timelockAbi, data: calls[3]!.data });
    expect(last).toMatchObject({ functionName: "updateDelay", args: [86_400n] });
  });

  it("the handover batch is schedule then execute of the same operation, both to the timelock", () => {
    const b = handoverBatch(d, 86_400);
    expect(b.chainId).toBe("143");
    expect(b.transactions.map((t) => t.to)).toEqual([A(20), A(20)]);
    const s = decodeFunctionData({ abi: timelockAbi, data: b.transactions[0]!.data });
    const e = decodeFunctionData({ abi: timelockAbi, data: b.transactions[1]!.data });
    expect(s.functionName).toBe("scheduleBatch");
    expect(e.functionName).toBe("executeBatch");
    // same targets, payloads, predecessor and salt; the schedule carries delay 0 (boot state)
    expect(s.args!.slice(0, 5)).toEqual(e.args!.slice(0, 5));
    expect(s.args![3]).toBe(zeroHash);
    expect(s.args![4]).toBe(HANDOVER_SALT);
    expect(s.args![5]).toBe(0n);
  });

  it("the launch is a timelocked resumeQuoting on the vault and nothing else", () => {
    const sch = launchScheduleBatch(d, 86_400);
    const exe = launchExecuteBatch(d);
    expect(sch.transactions).toHaveLength(1);
    expect(exe.transactions).toHaveLength(1);
    const s = decodeFunctionData({ abi: timelockAbi, data: sch.transactions[0]!.data });
    const e = decodeFunctionData({ abi: timelockAbi, data: exe.transactions[0]!.data });
    expect(s.functionName).toBe("schedule");
    expect((s.args![0] as string).toLowerCase()).toBe(A(12));
    expect(s.args![2]).toBe(toFunctionSelector("resumeQuoting()"));
    expect(s.args![4]).toBe(LAUNCH_SALT);
    expect(s.args![5]).toBe(86_400n); // the full delay
    expect(e.args).toEqual(s.args!.slice(0, 5));
    expect(LAUNCH_SALT).not.toBe(HANDOVER_SALT);
  });

  it("refuses to build batches without a timelock", () => {
    const none: Deployment = { ...d, timelock: undefined };
    expect(() => handoverCalls(none, 1)).toThrow(/no timelock/);
    expect(() => launchScheduleBatch(none, 1)).toThrow(/no timelock/);
  });
});
