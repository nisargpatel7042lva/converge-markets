import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  convergeVaultAbi,
  forwardVenueAbi,
  marketAbi,
  mockErc20Abi,
  partnerRegistryAbi,
} from "../src/abi/generated";
import {
  ConvergeError,
  assetIdFor,
  bidFromLadder,
  createConvergeClient,
  floorFor,
  formatStrike,
  parseStrike,
  type ConvergeAddresses,
} from "../src/partner";
import { WAD } from "../src/indexer-math";

const A: ConvergeAddresses = {
  registry: getAddress("0x00000000000000000000000000000000000000a1"),
  vault: getAddress("0x00000000000000000000000000000000000000a2"),
  venue: getAddress("0x00000000000000000000000000000000000000a3"),
  collateral: getAddress("0x00000000000000000000000000000000000000a4"),
};
const MARKET: Address = getAddress("0x00000000000000000000000000000000000000b1");
const ME: Address = getAddress("0x00000000000000000000000000000000000000c1");
const UP: Address = getAddress("0x00000000000000000000000000000000000000d1");
const DOWN: Address = getAddress("0x00000000000000000000000000000000000000d2");

describe("strike and asset parsing", () => {
  it("scales a decimal strike to the oracle's 18 decimals", () => {
    expect(parseStrike("3200")).toBe(3200n * 10n ** 18n);
    expect(parseStrike("3200.5")).toBe(32005n * 10n ** 17n);
    expect(parseStrike(0.031542)).toBe(31542n * 10n ** 12n);
    expect(parseStrike(5)).toBe(5n * 10n ** 18n);
    expect(parseStrike(10n ** 18n)).toBe(10n ** 18n); // a bigint is already scaled
    expect(formatStrike(3200n * 10n ** 18n)).toBe(3200);
  });

  it("rejects things that are not a positive price", () => {
    for (const bad of [
      "",
      "abc",
      "-1",
      "0",
      "1e3",
      "1.1234567890123456789",
      0,
      -5,
      NaN,
      Infinity,
    ]) {
      expect(() => parseStrike(bad as string | number), String(bad)).toThrow(ConvergeError);
    }
    expect(() => parseStrike(0n)).toThrow(ConvergeError);
    expect(() => parseStrike(3200n)).toThrow(/already scaled/); // the unscaled-bigint footgun
    expect(() => parseStrike(2n ** 191n)).toThrow(/int192/);
    expect(() => parseStrike("9".repeat(60))).toThrow(/int192/);
    expect(() => parseStrike(-1n)).toThrow(ConvergeError);
  });

  it("maps a label to the oracle asset id and passes a 32-byte id through", () => {
    expect(assetIdFor("ETH/USD")).toBe(keccak256(stringToHex("ETH/USD")));
    const id = `0x${"ab".repeat(32)}` as Hex;
    expect(assetIdFor(id)).toBe(id);
  });
});

describe("ladder helpers", () => {
  const q = {
    quoting: true,
    bids: [{ price: 450_000_000_000_000_000n, size: 10_000_000n }],
    asks: [{ price: 550_000_000_000_000_000n, size: 8_000_000n }],
  };
  it("a seller of UP gets the UP bid, a seller of DOWN gets one minus the UP ask", () => {
    expect(bidFromLadder("UP", q)).toEqual({
      priceWad: 450_000_000_000_000_000n,
      sizeShares: 10_000_000n,
    });
    expect(bidFromLadder("DOWN", q)).toEqual({
      priceWad: WAD - 550_000_000_000_000_000n,
      sizeShares: 8_000_000n,
    });
  });
  it("returns nothing when the vault is not quoting or a side is empty", () => {
    expect(bidFromLadder("UP", { ...q, quoting: false })).toBeNull();
    expect(bidFromLadder("UP", { ...q, bids: [] })).toBeNull();
    expect(bidFromLadder("DOWN", { ...q, asks: [{ price: 5n, size: 0n }] })).toBeNull();
  });
  it("a sell limit is the bid less the slippage, never below 0.01 and never above the bid", () => {
    expect(floorFor(500_000_000_000_000_000n, 100)).toBe(495_000_000_000_000_000n);
    expect(floorFor(500_000_000_000_000_000n, 0)).toBe(500_000_000_000_000_000n);
    expect(floorFor(20_000_000_000_000_000n, 5_000)).toBe(10_000_000_000_000_000n);
    expect(() => floorFor(5n * 10n ** 17n, -1)).toThrow(ConvergeError);
    expect(() => floorFor(5n * 10n ** 17n, 5_001)).toThrow(ConvergeError);
  });
});

// ------------------------------------------------------------------ a stub chain for the client

type Sent = { to: Address; data: Hex; value?: bigint };

function logFor(abi: Abi, eventName: string, args: Record<string, unknown>, address: Address) {
  const ev = (
    abi as readonly {
      type: string;
      name?: string;
      inputs: { name: string; type: string; indexed?: boolean }[];
    }[]
  ).find((x) => x.type === "event" && x.name === eventName)!;
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const unindexed = ev.inputs.filter((i) => !i.indexed);
  const data =
    unindexed.length === 0
      ? "0x"
      : encodeAbiParameters(unindexed as never, unindexed.map((i) => args[i.name]) as never);
  return {
    address,
    topics,
    data,
    blockNumber: 1n,
    transactionHash: "0x01" as Hex,
    logIndex: 0,
    transactionIndex: 0,
    blockHash: "0x02" as Hex,
    removed: false,
  };
}

function stub(
  over: {
    reads?: (c: { address: Address; functionName: string; args?: readonly unknown[] }) => unknown;
    logs?: unknown[];
    callReverts?: string;
    allowance?: bigint;
  } = {},
) {
  const sent: Sent[] = [];
  const calls: string[] = [];
  const pub = {
    async getBlock() {
      return { timestamp: 1_800_000_000n };
    },
    async getBlockNumber() {
      return 1000n;
    },
    async readContract(c: { address: Address; functionName: string; args?: readonly unknown[] }) {
      calls.push(c.functionName);
      if (c.functionName === "allowance") return over.allowance ?? 0n;
      if (c.functionName === "minReward") return 10n ** 15n;
      return over.reads?.(c);
    },
    async multicall({
      contracts,
    }: {
      contracts: { address: Address; functionName: string; args?: readonly unknown[] }[];
    }) {
      return contracts.map((c) => over.reads?.(c));
    },
    async call() {
      if (over.callReverts)
        throw new Error(`reverted with the following custom error:\n  ${over.callReverts}()`);
      return { data: "0x" as Hex };
    },
    async waitForTransactionReceipt() {
      return { status: "success" as const, logs: over.logs ?? [], blockNumber: 1n };
    },
    async getContractEvents() {
      return [];
    },
  } as unknown as PublicClient;
  const wallet = {
    account: { address: ME },
    chain: undefined,
    async sendTransaction(t: Sent) {
      sent.push(t);
      return `0x${sent.length.toString(16).padStart(64, "0")}` as Hex;
    },
  } as unknown as WalletClient;
  return { pub, wallet, sent, calls };
}

const ladder = {
  quoting: true,
  fair: 5n * 10n ** 17n,
  halfSpread: 0n,
  skew: 0n,
  // the contract's ladder sizes are WAD-scaled: 20e18 is 20 shares
  bids: [{ price: 450_000_000_000_000_000n, size: 20n * 10n ** 18n }],
  asks: [{ price: 550_000_000_000_000_000n, size: 20n * 10n ** 18n }],
};

const marketReads = (c: { address: Address; functionName: string }) => {
  switch (c.functionName) {
    case "quoteAt":
      return ladder;
    case "up":
      return UP;
    case "down":
      return DOWN;
    case "redeemFeeBps":
      return 50;
    case "state":
      return 1;
    case "startTime":
      return 1_799_999_000n;
    case "endTime":
      return 1_800_003_000n;
    case "strike":
      return 3200n * 10n ** 18n;
    case "endPrice":
      return 0n;
    case "assetId":
      return keccak256(stringToHex("ETH/USD"));
    case "infoOf":
      return { partner: ME, voided: false, feeShareBps: 3000, endTime: 1_800_003_000n };
    case "limits":
      return { exists: true, active: true, partner: ME, partnerCap: 1n, globalCap: 1n };
    case "venueView":
      return { tradable: true };
    default:
      return undefined;
  }
};

describe("client: reading", () => {
  it("reads a market into one view", async () => {
    const { pub } = stub({ reads: marketReads });
    const c = createConvergeClient({ publicClient: pub, addresses: A });
    const m = await c.getMarket(MARKET);
    expect(m).toMatchObject({
      address: MARKET,
      strikeNumber: 3200,
      status: "OPEN",
      upToken: UP,
      downToken: DOWN,
      redeemFeeBps: 50,
      partner: ME,
      active: true,
      quoting: true,
      endPrice: null,
    });
    expect(m.phase).toEqual({ phase: "LIVE", endsIn: 3000, closing: false });
  });

  it("turns the UP ladder into prices for both outcomes", async () => {
    const { pub } = stub({ reads: marketReads });
    const c = createConvergeClient({ publicClient: pub, addresses: A });
    const q = await c.getQuotes(MARKET, { spot: 3150 });
    expect(q.quoting).toBe(true);
    expect(q.fair).toBeCloseTo(0.5, 9);
    expect(q.up.ask?.price).toBeCloseTo(0.55, 9);
    expect(q.up.bid?.price).toBeCloseTo(0.45, 9);
    expect(q.down.ask?.price).toBeCloseTo(0.55, 9); // 1 - the UP bid
    expect(q.down.bid?.price).toBeCloseTo(0.45, 9); // 1 - the UP ask
    // sizes come back in the collateral's base units (6 decimals): 20 shares
    expect(q.up.ask?.size).toBe(20_000_000n);
    expect(q.down.bid?.size).toBe(20_000_000n);
    expect(q.spot).toBe(3150);
    expect(q.at).toBe(1_800_000_000);
  });

  it("reports a market the vault is not quoting", async () => {
    const { pub } = stub({
      reads: (c) =>
        c.functionName === "quoteAt"
          ? { ...ladder, quoting: false, bids: [], asks: [] }
          : marketReads(c),
    });
    const c = createConvergeClient({ publicClient: pub, addresses: A });
    const q = await c.getQuotes(MARKET, { spot: 3150 });
    expect(q.quoting).toBe(false);
    expect(q.up.ask).toBeNull();
    expect(q.down.bid).toBeNull();
  });
});

describe("client: writing", () => {
  it("creates a market with the scaled strike and reads the address from the event", async () => {
    const strike = 3200n * 10n ** 18n;
    const params = {
      factory: A.registry,
      assetId: keccak256(stringToHex("ETH/USD")),
      resolver: ME,
      collateral: A.collateral,
      up: UP,
      down: DOWN,
      startTime: 1_800_000_000n,
      endTime: 1_800_003_600n,
      redeemFeeBps: 50,
    };
    const logs = [
      logFor(
        partnerRegistryAbi as Abi,
        "MarketCreated",
        {
          market: MARKET,
          assetId: params.assetId,
          startTime: 1_800_000_000n,
          duration: 3600n,
          params,
        },
        A.registry,
      ),
      logFor(
        partnerRegistryAbi as Abi,
        "PartnerMarketCreated",
        {
          market: MARKET,
          partner: ME,
          assetId: params.assetId,
          strike,
          startTime: 1_800_000_000n,
          endTime: 1_800_003_600n,
          resolver: ME,
          feeShareBps: 3000,
        },
        A.registry,
      ),
    ];
    const { pub, wallet, sent } = stub({ logs });
    const c = createConvergeClient({ publicClient: pub, walletClient: wallet, addresses: A });
    const r = await c.createPartnerMarket({ asset: "ETH/USD", strike: "3200", end: 1_800_003_600 });
    expect(r).toMatchObject({
      market: MARKET,
      upToken: UP,
      downToken: DOWN,
      strike,
      endTime: 1_800_003_600,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(A.registry);
    const d = decodeFunctionData({ abi: partnerRegistryAbi, data: sent[0]!.data });
    expect(d.functionName).toBe("createThresholdMarket");
    expect(d.args).toEqual([params.assetId, strike, 1_800_003_600n]);
  });

  it("surfaces the contract's error name when the simulation reverts, and sends nothing", async () => {
    const { pub, wallet, sent } = stub({ callReverts: "BondTooLow" });
    const c = createConvergeClient({ publicClient: pub, walletClient: wallet, addresses: A });
    await expect(
      c.createPartnerMarket({ asset: "ETH/USD", strike: "3200", end: 1_800_003_600 }),
    ).rejects.toThrow(/BondTooLow/);
    expect(sent).toHaveLength(0);
  });

  it("refuses writes without a wallet", async () => {
    const { pub } = stub({ reads: marketReads });
    const c = createConvergeClient({ publicClient: pub, addresses: A });
    await expect(
      c.createPartnerMarket({ asset: "ETH/USD", strike: "3200", end: 1_800_003_600 }),
    ).rejects.toMatchObject({ code: "NO_WALLET" });
    await expect(c.redeem(MARKET)).rejects.toBeInstanceOf(ConvergeError);
    expect(c.account).toBeNull();
  });

  const orderLog = (kind: number) =>
    logFor(
      forwardVenueAbi as Abi,
      "OrderPlaced",
      {
        id: 7n,
        taker: ME,
        market: MARKET,
        kind,
        shares: 1n,
        limit: 1n,
        execAt: 1_800_000_002n,
        reward: 10n ** 15n,
      },
      A.venue,
    );

  it("buys: approves the escrow, then places an order whose limit is the price plus slippage", async () => {
    const { pub, wallet, sent } = stub({ reads: marketReads, logs: [orderLog(0)], allowance: 0n });
    const c = createConvergeClient({ publicClient: pub, walletClient: wallet, addresses: A });
    const r = await c.buy({
      market: MARKET,
      side: "UP",
      amount: "5.5",
      spot: 3150,
      slippageBps: 100,
    });
    expect(r.orderId).toBe(7n);
    expect(r.executesAt).toBe(1_800_000_002);
    expect(sent).toHaveLength(2);
    const approve = decodeFunctionData({ abi: mockErc20Abi, data: sent[0]!.data });
    expect(sent[0]!.to).toBe(A.collateral);
    expect(approve.functionName).toBe("approve");
    expect(approve.args![0]).toBe(A.venue);
    expect(approve.args![1]).toBe(r.plan!.escrow);
    const place = decodeFunctionData({ abi: forwardVenueAbi, data: sent[1]!.data });
    expect(sent[1]!.to).toBe(A.venue);
    expect(sent[1]!.value).toBe(10n ** 15n);
    expect(place.functionName).toBe("placeOrder");
    expect(place.args).toEqual([MARKET, 0, r.plan!.shares, 555_500_000_000_000_000n]); // 0.55 + 1 % of the price
    expect(r.plan!.escrow).toBeLessThanOrEqual(5_500_000n); // never more than the budget
  });

  it("does not approve again when the allowance is enough", async () => {
    const { pub, wallet, sent } = stub({
      reads: marketReads,
      logs: [orderLog(0)],
      allowance: 10n ** 12n,
    });
    const c = createConvergeClient({ publicClient: pub, walletClient: wallet, addresses: A });
    await c.buy({ market: MARKET, side: "UP", amount: "5", spot: 3150 });
    expect(sent).toHaveLength(1);
    expect(decodeFunctionData({ abi: forwardVenueAbi, data: sent[0]!.data }).functionName).toBe(
      "placeOrder",
    );
  });

  it("buys DOWN at one minus the UP bid", async () => {
    const { pub, wallet, sent } = stub({
      reads: marketReads,
      logs: [orderLog(2)],
      allowance: 10n ** 12n,
    });
    const c = createConvergeClient({ publicClient: pub, walletClient: wallet, addresses: A });
    await c.buy({ market: MARKET, side: "DOWN", amount: "5", spot: 3150, slippageBps: 0 });
    const place = decodeFunctionData({ abi: forwardVenueAbi, data: sent[0]!.data });
    expect(place.args![1]).toBe(2);
    expect(place.args![3]).toBe(550_000_000_000_000_000n);
  });

  it("refuses to buy when the vault is not quoting", async () => {
    const { pub, wallet, sent } = stub({
      reads: (c) =>
        c.functionName === "quoteAt"
          ? { ...ladder, quoting: false, bids: [], asks: [] }
          : marketReads(c),
    });
    const c = createConvergeClient({ publicClient: pub, walletClient: wallet, addresses: A });
    await expect(
      c.buy({ market: MARKET, side: "UP", amount: "5", spot: 3150 }),
    ).rejects.toMatchObject({ code: "NOT_QUOTING" });
    await expect(
      c.sell({ market: MARKET, side: "UP", shares: "5", spot: 3150 }),
    ).rejects.toMatchObject({ code: "NOT_QUOTING" });
    expect(sent).toHaveLength(0);
  });

  it("sells: approves the token and places a sell order with the floor as the limit", async () => {
    const { pub, wallet, sent } = stub({ reads: marketReads, logs: [orderLog(3)], allowance: 0n });
    const c = createConvergeClient({ publicClient: pub, walletClient: wallet, addresses: A });
    const r = await c.sell({
      market: MARKET,
      side: "DOWN",
      shares: "4",
      spot: 3150,
      slippageBps: 200,
    });
    expect(r.shares).toBe(4_000_000n);
    expect(sent[0]!.to).toBe(DOWN); // approving the DOWN token, not the collateral
    const place = decodeFunctionData({ abi: forwardVenueAbi, data: sent[1]!.data });
    expect(place.args![1]).toBe(3); // SELL_DOWN
    // DOWN bid = 1 - 0.55 = 0.45, less 2 %
    expect(place.args![3]).toBe(441_000_000_000_000_000n);
    await expect(
      c.sell({ market: MARKET, side: "UP", shares: 0n, spot: 3150 }),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
  });

  it("redeems only a market with an outcome", async () => {
    const open = stub({ reads: marketReads });
    const c1 = createConvergeClient({
      publicClient: open.pub,
      walletClient: open.wallet,
      addresses: A,
    });
    await expect(c1.redeem(MARKET)).rejects.toMatchObject({ code: "NOT_RESOLVED" });
    expect(open.sent).toHaveLength(0);

    const done = stub({ reads: (c) => (c.functionName === "state" ? 2 : marketReads(c)) });
    const c2 = createConvergeClient({
      publicClient: done.pub,
      walletClient: done.wallet,
      addresses: A,
    });
    await c2.redeem(MARKET);
    expect(done.sent[0]!.to).toBe(MARKET);
    expect(decodeFunctionData({ abi: marketAbi, data: done.sent[0]!.data }).functionName).toBe(
      "redeem",
    );
  });

  it("reads a position", async () => {
    const { pub } = stub({
      reads: (c) =>
        c.functionName === "balanceOf"
          ? c.address === UP
            ? 7n
            : 3n
          : c.functionName === "claimable"
            ? 7n
            : marketReads(c),
    });
    const c = createConvergeClient({ publicClient: pub, addresses: A });
    expect(await c.getPosition(MARKET, ME)).toEqual({
      market: MARKET,
      up: 7n,
      down: 3n,
      claimable: 7n,
    });
    await expect(c.getPosition(MARKET)).rejects.toMatchObject({ code: "NO_WALLET" });
  });
});

describe("client: resolving", () => {
  const reports = { reportAt: async () => "0xabcd" as Hex };
  const reads = (state: () => number) => (c: { functionName: string }) => {
    if (c.functionName === "state") return state();
    if (c.functionName === "endTime") return 1_799_999_000n; // already ended at the stub's clock
    if (c.functionName === "assetId") return keccak256(stringToHex("ETH/USD"));
    if (c.functionName === "assetCfg") return [true, `0x${"11".repeat(32)}`, 0n, 0n, 0n, 0n];
    return undefined;
  };

  it("treats a market resolved by someone else mid-call as success", async () => {
    let state = 1;
    const { pub, wallet, sent } = stub({ reads: reads(() => state) });
    // the simulation passes, then the market is resolved by another account before ours mines
    (pub as unknown as { waitForTransactionReceipt: unknown }).waitForTransactionReceipt =
      async () => {
        state = 2;
        return { status: "reverted", logs: [], blockNumber: 1n };
      };
    const c = createConvergeClient({ publicClient: pub, walletClient: wallet, addresses: A });
    expect(await c.resolve(MARKET, { reports })).toBe("RESOLVED_UP");
    expect(sent).toHaveLength(1);
  });

  it("returns at once when the market already has an outcome", async () => {
    const { pub, wallet, sent } = stub({ reads: reads(() => 3) });
    const c = createConvergeClient({ publicClient: pub, walletClient: wallet, addresses: A });
    expect(await c.resolve(MARKET, { reports })).toBe("RESOLVED_DOWN");
    expect(sent).toHaveLength(0);
  });

  it("without a report it still tries to finalize (an invalid market after the grace)", async () => {
    let state = 1;
    const { pub, wallet, sent } = stub({ reads: reads(() => state) });
    (pub as unknown as { waitForTransactionReceipt: unknown }).waitForTransactionReceipt =
      async () => {
        state = 4; // the oracle's grace had passed: the market became INVALID
        return { status: "success", logs: [], blockNumber: 1n };
      };
    const c = createConvergeClient({ publicClient: pub, walletClient: wallet, addresses: A });
    expect(await c.resolve(MARKET, { reports: { reportAt: async () => null } })).toBe("INVALID");
    expect(decodeFunctionData({ abi: marketAbi, data: sent[0]!.data }).args).toEqual(["0x"]);
  });

  it("still raises a revert when the market is not resolved", async () => {
    const { pub, wallet } = stub({ reads: reads(() => 1), callReverts: "PriceNotFinal" });
    const c = createConvergeClient({ publicClient: pub, walletClient: wallet, addresses: A });
    await expect(c.resolve(MARKET, { reports, timeoutMs: 100 })).rejects.toThrow(/PriceNotFinal/);
  });

  it("fails clearly when there is no oracle report yet and finalizing is refused", async () => {
    const { pub, wallet } = stub({ reads: reads(() => 1), callReverts: "PriceNotFinal" });
    const c = createConvergeClient({ publicClient: pub, walletClient: wallet, addresses: A });
    await expect(
      c.resolve(MARKET, { reports: { reportAt: async () => null }, timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: "NO_REPORT" });
  });

  it("retries a transaction that reverted after a passing simulation (a lost race) until it works", async () => {
    let state = 1;
    let receipts = 0;
    const { pub, wallet, sent } = stub({ reads: reads(() => state) });
    (pub as unknown as { waitForTransactionReceipt: unknown }).waitForTransactionReceipt =
      async () => {
        receipts += 1;
        if (receipts === 1) return { status: "reverted", logs: [], blockNumber: 1n }; // lost the race
        state = 2;
        return { status: "success", logs: [], blockNumber: 2n };
      };
    const c = createConvergeClient({ publicClient: pub, walletClient: wallet, addresses: A });
    expect(await c.resolve(MARKET, { reports, timeoutMs: 20_000 })).toBe("RESOLVED_UP");
    expect(sent).toHaveLength(2);
  });

  it("sends the report once, then only polls with 0x, and fetches a missing report again", async () => {
    let state = 1;
    let calls = 0;
    const { pub, wallet, sent } = stub({ reads: reads(() => state) });
    (pub as unknown as { waitForTransactionReceipt: unknown }).waitForTransactionReceipt =
      async () => {
        calls += 1;
        if (calls === 3) state = 2; // the third transaction finalizes
        return { status: "success", logs: [], blockNumber: BigInt(calls) };
      };
    let asked = 0;
    const lateReports = {
      reportAt: async () => (++asked < 2 ? null : ("0xabcd" as Hex)), // not there the first time
    };
    const c = createConvergeClient({ publicClient: pub, walletClient: wallet, addresses: A });
    expect(await c.resolve(MARKET, { reports: lateReports, timeoutMs: 30_000 })).toBe(
      "RESOLVED_UP",
    );
    const args = sent.map((t) => decodeFunctionData({ abi: marketAbi, data: t.data }).args![0]);
    // the report is fetched again before the first send (it was missing at the very first look),
    // goes out once, and the following calls only poll with "0x"
    expect(args).toEqual(["0xabcd", "0x", "0x"]);
  }, 20_000);

  it("times out with the last error when the market never resolves", async () => {
    const { pub, wallet } = stub({ reads: reads(() => 1), callReverts: "PriceNotFinal" });
    const c = createConvergeClient({ publicClient: pub, walletClient: wallet, addresses: A });
    await expect(c.resolve(MARKET, { reports, timeoutMs: 100 })).rejects.toThrow(/PriceNotFinal/);
  });
});

describe("client: partner account", () => {
  const partnerReads = (c: { functionName: string }) => {
    if (c.functionName === "partnerOf")
      return {
        approved: true,
        suspended: false,
        exposureCap: 40_000_000n,
        feeShareBps: 3000,
        bond: 100_000_000n,
        pendingWithdrawal: 0n,
        withdrawableAt: 0n,
        lastMarketEnd: 0n,
        marketsCreated: 2,
      };
    if (c.functionName === "minBond") return 10_000_000n;
    if (c.functionName === "feesOwed") return 1_500_000n;
    return undefined;
  };

  it("reads a partner's terms and whether it can create", async () => {
    const { pub } = stub({ reads: partnerReads });
    const c = createConvergeClient({ publicClient: pub, addresses: A });
    expect(await c.getPartner(ME)).toEqual({
      address: ME,
      approved: true,
      suspended: false,
      exposureCap: 40_000_000n,
      feeShareBps: 3000,
      bond: 100_000_000n,
      minBond: 10_000_000n,
      feesOwed: 1_500_000n,
      marketsCreated: 2,
      canCreate: true,
    });
    await expect(c.getPartner()).rejects.toMatchObject({ code: "NO_WALLET" });
    const below = stub({
      reads: (x) => (x.functionName === "minBond" ? 200_000_000n : partnerReads(x)),
    });
    const c2 = createConvergeClient({ publicClient: below.pub, addresses: A });
    expect((await c2.getPartner(ME)).canCreate).toBe(false);
  });

  it("posts a bond: approves the registry, then calls postBond", async () => {
    const { pub, wallet, sent } = stub({ allowance: 0n });
    const c = createConvergeClient({ publicClient: pub, walletClient: wallet, addresses: A });
    await c.postBond("100");
    expect(sent).toHaveLength(2);
    expect(sent[0]!.to).toBe(A.collateral);
    expect(decodeFunctionData({ abi: mockErc20Abi, data: sent[0]!.data }).args).toEqual([
      A.registry,
      100_000_000n,
    ]);
    expect(sent[1]!.to).toBe(A.registry);
    const d = decodeFunctionData({ abi: partnerRegistryAbi, data: sent[1]!.data });
    expect(d.functionName).toBe("postBond");
    expect(d.args).toEqual([100_000_000n]);
  });

  it("withdraws fees to the signer by default", async () => {
    const { pub, wallet, sent } = stub();
    const c = createConvergeClient({ publicClient: pub, walletClient: wallet, addresses: A });
    await c.withdrawFees();
    const d = decodeFunctionData({ abi: partnerRegistryAbi, data: sent[0]!.data });
    expect(d.functionName).toBe("withdrawFees");
    expect(d.args).toEqual([ME]);
  });
});

describe("client: fills", () => {
  it("emits only new fills from the indexer, oldest first, and stops when asked", async () => {
    const row = (id: string, block: number) => ({
      id,
      marketId: MARKET.toLowerCase(),
      side: "UP",
      action: "BUY",
      size: "1000000",
      premium: "550000",
      price: "0.55",
      taker: ME,
      txHash: "0xab",
      block,
      timestamp: 1_800_000_000 + block,
      logIndex: block,
    });
    let poll = 0;
    const polls = [
      [row("a", 1)],
      [row("b", 2), row("a", 1)],
      [row("c", 3), row("b", 2), row("a", 1)],
    ];
    const fetchStub = (async () => {
      const trades = polls[Math.min(poll++, polls.length - 1)];
      return new Response(
        JSON.stringify({
          data: {
            Market_by_pk: {
              id: MARKET.toLowerCase(),
              asset: "ETH",
              assetId: "0x",
              duration: 3600,
              startTime: 1,
              endTime: 2,
              strike: "1",
              endPrice: null,
              status: "OPEN",
              outcome: null,
              upToken: UP,
              downToken: DOWN,
              volume: "0",
              tradeCount: 0,
              lastUpPrice: null,
              vaultRegistered: true,
              vaultBasis: "0",
              vaultCash: "0",
              upSupply: "0",
              downSupply: "0",
              trades,
            },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const { pub } = stub();
    const c = createConvergeClient({
      publicClient: pub,
      addresses: A,
      indexer: { url: "http://x/v1/graphql", fetch: fetchStub },
    });
    const seen: string[] = [];
    const stop = c.subscribeFills({ market: MARKET, pollMs: 5 }, (f) =>
      seen.push(`${f.txHash}:${f.block}:${f.source}`),
    );
    await new Promise((r) => setTimeout(r, 120));
    stop();
    const n = poll;
    await new Promise((r) => setTimeout(r, 40));
    expect(poll).toBeLessThanOrEqual(n + 1); // stopped polling
    // the first poll only primes (no replay of history); then b and c, once each, in order
    expect(seen).toEqual(["0xab:2:indexer", "0xab:3:indexer"]);
  });

  it("falls back to the vault's Fill events when there is no indexer", async () => {
    const seen: { side: string; action: string; price: number; source: string }[] = [];
    const { pub } = stub();
    let calls = 0;
    (pub as unknown as { getContractEvents: unknown }).getContractEvents = async () => {
      calls += 1;
      return calls === 1
        ? []
        : [
            {
              args: {
                market: MARKET,
                upToken: false,
                vaultSells: false,
                units: 2_000_000n,
                premium: 900_000n,
                taker: ME,
              },
              transactionHash: "0xcd",
              blockNumber: 1001n,
            },
          ];
    };
    let head = 1000n;
    (pub as unknown as { getBlockNumber: unknown }).getBlockNumber = async () => head++;
    const c = createConvergeClient({ publicClient: pub, addresses: A });
    const stop = c.subscribeFills({ pollMs: 5 }, (f) => seen.push(f));
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(seen[0]).toMatchObject({
      side: "DOWN",
      action: "SELL",
      source: "chain",
      shares: 2_000_000n,
    });
    expect(seen[0]!.price).toBeCloseTo(0.45, 9);
  });

  it("scans the last two blocks again and still delivers a fill once", async () => {
    const { pub } = stub();
    let head = 1_000n;
    (pub as unknown as { getBlockNumber: unknown }).getBlockNumber = async () => head;
    const fromBlocks: bigint[] = [];
    const log = {
      args: {
        market: MARKET,
        upToken: true,
        vaultSells: true,
        units: 1_000_000n,
        premium: 500_000n,
        taker: ME,
      },
      transactionHash: "0xaa",
      logIndex: 3,
      blockNumber: 1_001n,
    };
    (pub as unknown as { getContractEvents: unknown }).getContractEvents = async (a: {
      fromBlock: bigint;
      toBlock: bigint;
    }) => {
      fromBlocks.push(a.fromBlock);
      return a.fromBlock <= 1_001n && a.toBlock >= 1_001n ? [log] : [];
    };
    const seen: unknown[] = [];
    const c = createConvergeClient({ publicClient: pub, addresses: A });
    const stop = c.subscribeFills({ pollMs: 5 }, (f) => seen.push(f));
    await new Promise((r) => setTimeout(r, 30));
    head = 1_002n;
    await new Promise((r) => setTimeout(r, 40));
    head = 1_003n;
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(seen).toHaveLength(1); // seen by two scans, delivered once
    expect(fromBlocks.some((f) => f === 1_000n || f === 1_001n)).toBe(true);
  });

  it("reports polling errors without throwing", async () => {
    const { pub } = stub();
    (pub as unknown as { getBlockNumber: unknown }).getBlockNumber = async () => {
      throw new Error("rpc down");
    };
    const c = createConvergeClient({ publicClient: pub, addresses: A });
    const errors: unknown[] = [];
    const stop = c.subscribeFills({ pollMs: 5, onError: (e) => errors.push(e) }, () => undefined);
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("client: log windows (the public Monad RPC allows 100 blocks per eth_getLogs)", () => {
  const limited = (head: bigint) => {
    const ranges: [bigint, bigint][] = [];
    const { pub } = stub();
    (pub as unknown as { getBlockNumber: unknown }).getBlockNumber = async () => head;
    (pub as unknown as { getContractEvents: unknown }).getContractEvents = async (a: {
      fromBlock: bigint;
      toBlock?: bigint;
    }) => {
      const to = a.toBlock ?? head;
      if (to - a.fromBlock + 1n > 100n) throw new Error("eth_getLogs is limited to a 100 range");
      ranges.push([a.fromBlock, to]);
      return [];
    };
    return { pub, ranges };
  };

  it("waitForFill never asks for more than the limit, even from a far-back block", async () => {
    const { pub, ranges } = limited(5_000n);
    const c = createConvergeClient({ publicClient: pub, addresses: A });
    await expect(c.waitForFill(1n, { timeoutMs: 50, fromBlock: 1_000n })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(ranges.length).toBeGreaterThan(40); // 4,000 blocks in windows of 90, two event types
    for (const [f, t] of ranges) expect(t - f + 1n).toBeLessThanOrEqual(90n);
    // the default start is within one window of the head
    const fresh = limited(5_000n);
    const c2 = createConvergeClient({ publicClient: fresh.pub, addresses: A });
    await expect(c2.waitForFill(1n, { timeoutMs: 50 })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(fresh.ranges[0]![0]).toBeGreaterThanOrEqual(5_000n - 89n);
  });

  it("subscribeFills catches up over a long gap in windows instead of dying", async () => {
    let head = 1_000n;
    const ranges: [bigint, bigint][] = [];
    const { pub } = stub();
    (pub as unknown as { getBlockNumber: unknown }).getBlockNumber = async () => head;
    (pub as unknown as { getContractEvents: unknown }).getContractEvents = async (a: {
      fromBlock: bigint;
      toBlock: bigint;
    }) => {
      if (a.toBlock - a.fromBlock + 1n > 100n) throw new Error("limited to a 100 range");
      ranges.push([a.fromBlock, a.toBlock]);
      return [];
    };
    const errors: unknown[] = [];
    const c = createConvergeClient({ publicClient: pub, addresses: A });
    const stop = c.subscribeFills({ pollMs: 5, onError: (e) => errors.push(e) }, () => undefined);
    await new Promise((r) => setTimeout(r, 30));
    head = 1_500n; // the tab slept: 500 blocks passed
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(errors).toEqual([]);
    expect(ranges.some(([, t]) => t === 1_500n)).toBe(true);
    for (const [f, t] of ranges) expect(t - f + 1n).toBeLessThanOrEqual(90n);
  });
});

describe("client: waiting for an order", () => {
  it("returns the fill when the venue emitted OrderExecuted, and times out otherwise", async () => {
    const { pub } = stub();
    let n = 0;
    let head = 1000n;
    (pub as unknown as { getBlockNumber: unknown }).getBlockNumber = async () => head++; // blocks keep coming
    (pub as unknown as { getContractEvents: unknown }).getContractEvents = async ({
      eventName,
    }: {
      eventName: string;
    }) => {
      n += 1;
      if (eventName === "OrderExecuted" && n > 4)
        return [{ args: { filled: 5n, premium: 3n }, transactionHash: "0xee" }];
      return [];
    };
    const c = createConvergeClient({ publicClient: pub, addresses: A });
    const r = await c.waitForFill(1n, { timeoutMs: 5_000 });
    expect(r).toEqual({ status: "EXECUTED", filled: 5n, premium: 3n, txHash: "0xee" });

    const { pub: pub2 } = stub();
    const c2 = createConvergeClient({ publicClient: pub2, addresses: A });
    await expect(c2.waitForFill(2n, { timeoutMs: 50 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

// keep the ABI imports honest: the vault ABI must expose what the client reads
describe("abi surface", () => {
  it("has the functions the client calls", () => {
    const names = (abi: readonly { type: string; name?: string }[]) =>
      new Set(abi.filter((x) => x.type === "function").map((x) => x.name));
    expect(names(partnerRegistryAbi)).toEqual(expect.objectContaining({}));
    for (const f of ["createThresholdMarket", "infoOf", "limits", "liveMarkets"])
      expect(names(partnerRegistryAbi).has(f), f).toBe(true);
    for (const f of ["venueView", "assetCfg", "partnerRegistry", "partnerOf"])
      expect(names(convergeVaultAbi).has(f), f).toBe(true);
  });
});
