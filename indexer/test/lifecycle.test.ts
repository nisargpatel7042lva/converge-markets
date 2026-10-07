import { createTestIndexer } from "envio";
import { describe, expect, it } from "vitest";
import {
  ASSET,
  CHAIN,
  Chain,
  DEAD,
  LP,
  LP2,
  OTHER,
  TAKER,
  VAULT,
  VENUE,
  ZERO,
  addr,
  marketAddrs,
} from "./helpers";

const U = 1_000_000n; // 1 USDC
const WAD = 10n ** 18n;
const T0 = 1_790_000_000 - (1_790_000_000 % 900); // an epoch-aligned time in Oct 2026

async function run(chain: Chain) {
  const idx = createTestIndexer();
  // simulate takes loosely typed items; the builders produce exactly the declared event params
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await idx.process({ chains: { [CHAIN]: { simulate: chain.events as any } } as any });
  return idx;
}

describe("full lifecycle", () => {
  it("indexes a market, vault epoch, fills, orders, redeem and LP exit with exact numbers", async () => {
    const m = marketAddrs(1);
    const c = new Chain(T0);
    c.tx().assetSet("BTC/USD");
    c.tx().marketCreated(m, T0 + 900);
    c.tx().vault("MarketRegistered", { market: m.market, assetId: ASSET });

    // LP: deposit 1000 USDC (epoch 0), settle at 1:1 with 1000 dead shares, claim.
    c.tx().depositRequested(0, LP, 1000n * U);
    // Contract order (ConvergeVault.settleEpoch): the mints happen in _settleDeposits, THEN EpochSettled and
    // NavSnapshot are emitted with the NAV taken BEFORE the epoch's flows (0 for the very first deposit).
    c.tx(900)
      .shareTransfer(ZERO, DEAD, 1000n)
      .shareTransfer(ZERO, VAULT, 1000n * U - 1000n)
      .epochSettled({
        epochId: 0,
        navLower: 0n,
        navUpper: 0n,
        supplyBefore: 0n,
        sharesMinted: 1000n * U - 1000n,
        sharesBurned: 0n,
        assetsPaid: 0n,
        depositsAccepted: 1000n * U,
      })
      .navSnapshot(0n, 0n, WAD, 1000n * U, true);
    c.tx()
      .shareTransfer(VAULT, LP, 1000n * U - 1000n)
      .depositClaimed(0, LP, LP, 1000n * U - 1000n, 0n);

    // Inventory split by the vault; the market opens.
    c.tx()
      .split(m, VAULT, 100n * U)
      .vault("InventorySplit", { market: m.market, amount: 100n * U });
    c.tx(900).opened(m, 65_000n * 10n ** 8n);

    // TAKER buys 10 UP: one order, two ladder levels, 6 @ 0.54 = 3.24 and 4 @ 0.56 = 2.24 (premium 5.48).
    c.tx().orderPlaced({
      id: 1,
      taker: TAKER,
      market: m.market,
      kind: 0,
      shares: 10n * U,
      limit: (6n * WAD) / 10n,
      execAt: c.now + 2,
    });
    c.tx(2)
      .transfer(m.up, VAULT, TAKER, 6n * U)
      .fill({
        market: m.market,
        upToken: true,
        vaultSells: true,
        units: 6n * U,
        premium: 3_240_000n,
        taker: TAKER,
        basis: -6n * U,
        cash: 3_240_000n,
      })
      .transfer(m.up, VAULT, TAKER, 4n * U)
      .fill({
        market: m.market,
        upToken: true,
        vaultSells: true,
        units: 4n * U,
        premium: 2_240_000n,
        taker: TAKER,
        basis: -10n * U,
        cash: 5_480_000n,
      })
      .orderExecuted(1, OTHER, 10n * U, 5_480_000n);

    // TAKER sells 4 UP at 0.55 = 2.20 (tokens go into escrow at placement).
    c.tx()
      .transfer(m.up, TAKER, VENUE, 4n * U)
      .orderPlaced({
        id: 2,
        taker: TAKER,
        market: m.market,
        kind: 1,
        shares: 4n * U,
        limit: (5n * WAD) / 10n,
        execAt: c.now + 2,
      });
    c.tx(2)
      .transfer(m.up, VENUE, VAULT, 4n * U)
      .fill({
        market: m.market,
        upToken: true,
        vaultSells: false,
        units: 4n * U,
        premium: 2_200_000n,
        taker: TAKER,
        basis: -6n * U,
        cash: 3_280_000n,
      })
      .orderExecuted(2, OTHER, 4n * U, 2_200_000n);

    // After the fills the vault merges 2 pairs back (basis 100 -> ... fills overwrite it, merge subtracts).
    c.tx().vault("InventoryMerged", { market: m.market, amount: 2n * U });
    // The market resolves UP (end price above the strike), TAKER redeems its 6 UP at 1:1.
    c.tx(900).resolved(m, 2, 65_000n * 10n ** 8n, 65_100n * 10n ** 8n);
    c.tx().redeemed(m, TAKER, 6n * U, 0n, 6n * U);

    // LP redeems 500 shares in epoch 1, settled at pps 1.02, claims 510 USDC.
    c.tx()
      .transfer(VAULT, LP, VAULT, 500n * U, "ConvergeVault")
      .redeemRequested(1, LP, 500n * U);
    // pre-flow NAV 1020 / 1022 (pps 1.02 over 1000 shares); 510 is paid out: the vault stores 510 / 512
    c.tx(900)
      .shareTransfer(VAULT, ZERO, 500n * U)
      .epochSettled({
        epochId: 1,
        navLower: 1020n * U,
        navUpper: 1022n * U,
        supplyBefore: 1000n * U,
        sharesMinted: 0n,
        sharesBurned: 500n * U,
        assetsPaid: 510n * U,
        depositsAccepted: 0n,
      })
      .navSnapshot(1020n * U, 1022n * U, (102n * WAD) / 100n, 500n * U, true);
    c.tx().redeemClaimed(1, LP, LP, 510n * U, 0n);

    const idx = await run(c);

    // ---- market
    const market = await idx.Market.getOrThrow(m.market);
    expect(market.asset).toBe("BTC/USD");
    expect(market.status).toBe("RESOLVED_UP");
    expect(market.outcome).toBe("UP");
    expect(market.strike).toBe(65_000n * 10n ** 8n);
    expect(market.endPrice).toBe(65_100n * 10n ** 8n);
    expect(market.vaultRegistered).toBe(true);
    expect(market.tradeCount).toBe(3);
    expect(market.volume).toBe(3_240_000n + 2_240_000n + 2_200_000n);
    expect(market.lastUpPrice?.toString()).toBe("0.55");
    expect([market.vaultBasis, market.vaultCash]).toEqual([-8n * U, 3_280_000n]);
    // supply: vault split 100 + 0 (market created only by the vault's split); redeemed 6 UP burned
    expect(market.upSupply).toBe(100n * U - 6n * U);
    expect(market.downSupply).toBe(100n * U);
    expect((await idx.OutcomeToken.getOrThrow(m.up)).totalSupply).toBe(94n * U);

    // ---- trades
    const trades = (await idx.Trade.getAll()).sort(
      (a, b) => a.logIndex - b.logIndex || a.block - b.block,
    );
    expect(trades).toHaveLength(3);
    const t1 = trades.find((t) => t.size === 6n * U)!;
    expect([t1.side, t1.action, t1.premium, t1.taker, t1.maker]).toEqual([
      "UP",
      "BUY",
      3_240_000n,
      TAKER,
      VAULT,
    ]);
    expect(t1.price.toString()).toBe("0.54");
    const sell = trades.find((t) => t.action === "SELL")!;
    expect(sell.price.toString()).toBe("0.55");
    expect(sell.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    // ---- orders
    const o1 = await idx.Order.getOrThrow(`${VENUE}_1`);
    expect([o1.venue, o1.orderId]).toEqual([VENUE, 1n]);
    expect([o1.status, o1.kind, o1.filled, o1.premium, o1.executor]).toEqual([
      "EXECUTED",
      "BUY_UP",
      10n * U,
      5_480_000n,
      OTHER,
    ]);
    const o2 = await idx.Order.getOrThrow(`${VENUE}_2`);
    expect([o2.status, o2.kind, o2.filled]).toEqual(["EXECUTED", "SELL_UP", 4n * U]);

    // ---- taker position: bought 10 for 5.48, sold 4 for 2.20 (removed cost floor(5.48*4/10) = 2.192),
    // redeemed 6 for 6.00 (removed cost 3.288): realized = (2.200-2.192) + (6.000-3.288) = 2.720
    const pos = await idx.UserPosition.getOrThrow(`${TAKER}_${m.market}`);
    expect(pos.upBalance).toBe(0n); // wallet: 10 in, 4 to the venue, 6 burned
    expect(pos.upEscrowed).toBe(0n);
    expect(pos.upCost).toBe(0n);
    expect(pos.realizedPnl).toBe(8_000n + 2_712_000n);
    expect(pos.totalIn).toBe(5_480_000n);
    expect(pos.totalOut).toBe(2_200_000n + 6_000_000n);
    expect(pos.tradeCount).toBe(3); // 2 buy fills + 1 sell fill
    const user = await idx.User.getOrThrow(TAKER);
    expect(user.realizedPnl).toBe(2_720_000n);
    expect(user.volume).toBe(7_680_000n);

    // ---- the vault is a holder too: wallet balances only, no cost
    const vaultPos = await idx.UserPosition.getOrThrow(`${VAULT}_${m.market}`);
    expect(vaultPos.upBalance).toBe(100n * U - 6n * U - 4n * U + 4n * U); // split, two sells, one buy-back: 100 - 10 + 4
    expect(vaultPos.costBasis).toBe(0n);

    // ---- LP: deposited 1000 for 999.999 shares, redeemed 500 shares for 510
    // removed cost = floor(1000e6 * 500e6 / 999_999_000) = 500_000_500; realized = 510e6 - 500_000_500
    const lp = await idx.LPPosition.getOrThrow(LP);
    expect(lp.shares).toBe(1000n * U - 1000n - 500n * U);
    expect(lp.escrowedShares).toBe(0n);
    expect(lp.realizedPnl).toBe(510n * U - 500_000_500n);
    expect(lp.costBasis).toBe(1000n * U - 500_000_500n);
    expect(lp.totalDeposited).toBe(1000n * U);
    expect(lp.totalWithdrawn).toBe(510n * U);

    // ---- vault state and epochs
    const vault = await idx.Vault.getOrThrow(VAULT);
    expect(vault.totalSupply).toBe(1000n * U - 500n * U); // 1000 minted (incl. dead), 500 burned
    expect(vault.supply).toBe(500n * U);
    expect(vault.ppsLower).toBe((102n * WAD) / 100n);
    expect(vault.settledEpochs).toBe(2);
    expect(vault.lastSettledEpoch).toBe(1);
    expect(vault.totalDeposited).toBe(1000n * U);
    expect(vault.totalRedeemed).toBe(510n * U);
    expect(vault.fillCount).toBe(3);
    const e0 = await idx.VaultEpoch.getOrThrow("0");
    expect([e0.status, e0.ppsLower, e0.navLower, e0.depositsAccepted]).toEqual([
      "SETTLED",
      WAD,
      0n, // as emitted (before the epoch's own deposits)
      1000n * U,
    ]);
    // the stored NAV applies the flows exactly like the contract: nav + accepted - paid
    const snaps = (await idx.NavSnapshot.getAll()).sort((a, b) => a.block - b.block);
    expect([snaps[0]!.navLower, snaps[0]!.navLowerAfter, snaps[0]!.navUpperAfter]).toEqual([
      0n,
      1000n * U,
      1000n * U,
    ]);
    expect([snaps[1]!.navLower, snaps[1]!.navLowerAfter, snaps[1]!.navUpperAfter]).toEqual([
      1020n * U,
      510n * U,
      512n * U,
    ]);
    expect([vault.navLower, vault.navUpper]).toEqual([510n * U, 512n * U]);
    const e1 = await idx.VaultEpoch.getOrThrow("1");
    expect([e1.ppsLower, e1.assetsPaid, e1.sharesBurned, e1.redeemRequested]).toEqual([
      (102n * WAD) / 100n,
      510n * U,
      500n * U,
      500n * U,
    ]);

    // ---- requests
    const dr = await idx.DepositRequest.getOrThrow(`0_${LP}`);
    expect([dr.status, dr.assets, dr.shares, dr.receiver]).toEqual([
      "CLAIMED",
      1000n * U,
      1000n * U - 1000n,
      LP,
    ]);
    const rr = await idx.RedeemRequest.getOrThrow(`1_${LP}`);
    expect([rr.status, rr.assets, rr.requeuedShares]).toEqual(["CLAIMED", 510n * U, 0n]);

    // ---- snapshots, stats
    expect(await idx.NavSnapshot.getAll()).toHaveLength(2);
    const stats = await idx.ProtocolStats.getOrThrow("global");
    expect(stats.totalMarkets).toBe(1);
    expect(stats.totalMarketsResolved).toBe(1);
    expect(stats.totalTrades).toBe(3);
    expect(stats.totalVolume).toBe(7_680_000n);
    expect(stats.totalDeposited).toBe(1000n * U);
    expect(stats.totalRedeemed).toBe(510n * U);
    expect(stats.tvl).toBe(510n * U);
    expect(stats.vaultPps).toBe((102n * WAD) / 100n);
    expect(stats.totalUsers).toBe(2); // LP and TAKER; the vault, venue and dead address are not users
    const days = await idx.DailyStats.getAll();
    expect(days.reduce((s, d) => s + d.trades, 0)).toBe(3);
    expect(days.reduce((s, d) => s + d.activeUsers, 0)).toBeGreaterThanOrEqual(2);
  });
});

describe("orders, escrow, expiry", () => {
  it("an expired sell order returns its escrow and books nothing", async () => {
    const m = marketAddrs(2);
    const c = new Chain(T0);
    c.tx()
      .assetSet()
      .tx()
      .marketCreated(m, T0 + 900);
    c.tx().split(m, OTHER, 20n * U); // OTHER splits 20 USDC: 20 UP + 20 DOWN, cost 10 + 10
    c.tx()
      .transfer(m.down, OTHER, VENUE, 5n * U)
      .orderPlaced({
        id: 7,
        taker: OTHER,
        market: m.market,
        kind: 3,
        shares: 5n * U,
        limit: WAD / 2n,
        execAt: c.now + 2,
      });
    let idx = await run(c);
    let pos = await idx.UserPosition.getOrThrow(`${OTHER}_${m.market}`);
    expect([pos.downBalance, pos.downEscrowed, pos.downCost]).toEqual([15n * U, 5n * U, 10n * U]);

    c.tx(20)
      .transfer(m.down, VENUE, OTHER, 5n * U)
      .orderExpired(7, TAKER);
    idx = await run(c);
    pos = await idx.UserPosition.getOrThrow(`${OTHER}_${m.market}`);
    expect([pos.downBalance, pos.downEscrowed, pos.downCost, pos.realizedPnl]).toEqual([
      20n * U,
      0n,
      10n * U,
      0n,
    ]);
    const o = await idx.Order.getOrThrow(`${VENUE}_7`);
    expect([o.status, o.filled, o.premium]).toEqual(["EXPIRED", 0n, 0n]);
  });

  it("a partially filled sell releases fills and refund exactly once", async () => {
    const m = marketAddrs(3);
    const c = new Chain(T0);
    c.tx()
      .assetSet()
      .tx()
      .marketCreated(m, T0 + 900);
    c.tx().split(m, OTHER, 10n * U); // up cost 5, down cost 5
    c.tx()
      .transfer(m.up, OTHER, VENUE, 10n * U)
      .orderPlaced({
        id: 1,
        taker: OTHER,
        market: m.market,
        kind: 1,
        shares: 10n * U,
        limit: WAD / 10n,
        execAt: c.now + 2,
      });
    c.tx(2)
      .transfer(m.up, VENUE, VAULT, 3n * U)
      .fill({
        market: m.market,
        upToken: true,
        vaultSells: false,
        units: 3n * U,
        premium: 1_800_000n,
        taker: OTHER,
      })
      .transfer(m.up, VENUE, OTHER, 7n * U) // refund of the unfilled 7
      .orderExecuted(1, TAKER, 3n * U, 1_800_000n);
    const idx = await run(c);
    const pos = await idx.UserPosition.getOrThrow(`${OTHER}_${m.market}`);
    expect(pos.upBalance).toBe(7n * U);
    expect(pos.upEscrowed).toBe(0n);
    expect(pos.upCost).toBe(3_500_000n); // 5.0 - 5.0*3/10 = 3.5
    expect(pos.realizedPnl).toBe(1_800_000n - 1_500_000n);
  });
});

describe("vault epochs and requests", () => {
  it("expiry makes deposits refundable and the refund claim is recorded without LP cost", async () => {
    const c = new Chain(T0);
    c.tx().depositRequested(5, LP, 100n * U);
    c.tx(1000).epochExpired(5, 100n * U, 0n);
    let idx = await run(c);
    expect((await idx.DepositRequest.getOrThrow(`5_${LP}`)).status).toBe("REFUNDABLE");
    expect((await idx.VaultEpoch.getOrThrow("5")).status).toBe("EXPIRED");
    expect((await idx.Vault.getOrThrow(VAULT)).expiredEpochs).toBe(1);

    c.tx().depositClaimed(5, LP, LP, 0n, 100n * U);
    idx = await run(c);
    const dr = await idx.DepositRequest.getOrThrow(`5_${LP}`);
    expect([dr.status, dr.refunded]).toEqual(["REFUNDED", 100n * U]);
    const lp = await idx.LPPosition.getOrThrow(LP);
    expect([lp.costBasis, lp.totalDeposited]).toEqual([0n, 0n]);
  });

  it("a partial redemption requeues the rest into the next epoch and keeps those shares in escrow", async () => {
    const c = new Chain(T0);
    // LP holds 1000 shares at cost 1000 (deposit claimed earlier)
    c.tx().depositRequested(0, LP, 1000n * U);
    c.tx(900)
      .shareTransfer(ZERO, VAULT, 1000n * U)
      .epochSettled({
        epochId: 0,
        navLower: 0n,
        navUpper: 0n,
        supplyBefore: 0n,
        sharesMinted: 1000n * U,
        sharesBurned: 0n,
        assetsPaid: 0n,
        depositsAccepted: 1000n * U,
      })
      .navSnapshot(0n, 0n, WAD, 1000n * U, true);
    c.tx()
      .shareTransfer(VAULT, LP, 1000n * U)
      .depositClaimed(0, LP, LP, 1000n * U, 0n);
    // redeem 1000 in epoch 1; only 250 are filled
    c.tx()
      .shareTransfer(LP, VAULT, 1000n * U)
      .redeemRequested(1, LP, 1000n * U);
    c.tx(900)
      .shareTransfer(VAULT, ZERO, 250n * U)
      .epochSettled({
        epochId: 1,
        navLower: 1000n * U,
        navUpper: 1000n * U,
        supplyBefore: 1000n * U,
        sharesMinted: 0n,
        sharesBurned: 250n * U,
        assetsPaid: 250n * U,
        depositsAccepted: 0n,
      })
      .navSnapshot(1000n * U, 1000n * U, WAD, 750n * U, true);
    c.tx()
      .redeemRequested(2, LP, 750n * U, true)
      .redeemClaimed(1, LP, LP, 250n * U, 750n * U);
    const idx = await run(c);
    const lp = await idx.LPPosition.getOrThrow(LP);
    expect(lp.escrowedShares).toBe(750n * U);
    expect(lp.shares).toBe(0n);
    expect(lp.costBasis).toBe(750n * U);
    expect(lp.realizedPnl).toBe(0n); // redeemed at cost
    expect((await idx.RedeemRequest.getOrThrow(`1_${LP}`)).status).toBe("CLAIMED");
    const r2 = await idx.RedeemRequest.getOrThrow(`2_${LP}`);
    expect([r2.status, r2.shares, r2.requeued]).toEqual(["REQUESTED", 750n * U, true]);
    expect((await idx.VaultEpoch.getOrThrow("2")).redeemRequested).toBe(750n * U);
  });

  it("the performance fee (shares to the treasury) is attached to the epoch it was charged in and counted once", async () => {
    const TREASURY = addr(0x4001);
    const c = new Chain(T0);
    c.tx().depositRequested(0, LP, 1000n * U);
    c.tx(900)
      .shareTransfer(ZERO, VAULT, 1000n * U)
      .epochSettled({
        epochId: 0,
        navLower: 0n,
        navUpper: 0n,
        supplyBefore: 0n,
        sharesMinted: 1000n * U,
        sharesBurned: 0n,
        assetsPaid: 0n,
        depositsAccepted: 1000n * U,
      })
      .navSnapshot(0n, 0n, WAD, 1000n * U, true);
    // epoch 1: NAV grew to 1100, the vault mints 5 fee shares to the treasury BEFORE the settlement event
    c.tx(900)
      .shareTransfer(ZERO, TREASURY, 5n * U)
      .performanceFee(5n * U, 6n * U, WAD)
      .epochSettled({
        epochId: 1,
        navLower: 1100n * U,
        navUpper: 1100n * U,
        supplyBefore: 1000n * U,
        sharesMinted: 0n,
        sharesBurned: 0n,
        assetsPaid: 0n,
        depositsAccepted: 0n,
      })
      .navSnapshot(1100n * U, 1100n * U, (1095n * WAD) / 1000n, 1005n * U, true);
    c.tx(900)
      .epochSettled({
        epochId: 2,
        navLower: 1100n * U,
        navUpper: 1100n * U,
        supplyBefore: 1005n * U,
        sharesMinted: 0n,
        sharesBurned: 0n,
        assetsPaid: 0n,
        depositsAccepted: 0n,
      })
      .navSnapshot(1100n * U, 1100n * U, (1095n * WAD) / 1000n, 1005n * U, true);
    const idx = await run(c);
    expect((await idx.VaultEpoch.getOrThrow("0")).feeAssets).toBe(0n);
    expect((await idx.VaultEpoch.getOrThrow("1")).feeAssets).toBe(6n * U);
    expect((await idx.VaultEpoch.getOrThrow("1")).feeShares).toBe(5n * U);
    expect((await idx.VaultEpoch.getOrThrow("2")).feeAssets).toBe(0n);
    const v = await idx.Vault.getOrThrow(VAULT);
    expect([v.totalPerformanceFees, v.pendingFeeAssets, v.totalSupply]).toEqual([
      6n * U,
      0n,
      1005n * U,
    ]);
    expect((await idx.ProtocolStats.getOrThrow("global")).totalFeesPerformance).toBe(6n * U);
    // the treasury's fee shares are a holder row with no cost
    expect((await idx.LPPosition.getOrThrow(TREASURY)).shares).toBe(5n * U);
  });

  it("settlement makes requests CLAIMABLE; a claim to a different receiver puts shares and cost with the receiver", async () => {
    const c = new Chain(T0);
    c.tx().depositRequested(0, LP, 1000n * U);
    c.tx(900)
      .shareTransfer(ZERO, VAULT, 1000n * U)
      .epochSettled({
        epochId: 0,
        navLower: 0n,
        navUpper: 0n,
        supplyBefore: 0n,
        sharesMinted: 1000n * U,
        sharesBurned: 0n,
        assetsPaid: 0n,
        depositsAccepted: 1000n * U,
      })
      .navSnapshot(0n, 0n, WAD, 1000n * U, true);
    let idx = await run(c);
    expect((await idx.DepositRequest.getOrThrow(`0_${LP}`)).status).toBe("CLAIMABLE");
    c.tx()
      .shareTransfer(VAULT, LP2, 1000n * U)
      .depositClaimed(0, LP, LP2, 1000n * U, 0n);
    idx = await run(c);
    const r = await idx.DepositRequest.getOrThrow(`0_${LP}`);
    expect([r.status, r.receiver]).toEqual(["CLAIMED", LP2]);
    const lp2 = await idx.LPPosition.getOrThrow(LP2);
    expect([lp2.shares, lp2.costBasis, lp2.totalDeposited]).toEqual([
      1000n * U,
      1000n * U,
      1000n * U,
    ]);
    expect((await idx.LPPosition.getOrThrow(LP)).costBasis).toBe(0n);
  });

  it("TVL after a settlement with flows equals the contract's stored NAV, and a day without a snapshot keeps the last TVL", async () => {
    const DAY = 86_400;
    const c = new Chain(T0);
    c.tx().depositRequested(0, LP, 1000n * U);
    c.tx(900)
      .shareTransfer(ZERO, VAULT, 1000n * U)
      .epochSettled({
        epochId: 0,
        navLower: 0n,
        navUpper: 0n,
        supplyBefore: 0n,
        sharesMinted: 1000n * U,
        sharesBurned: 0n,
        assetsPaid: 0n,
        depositsAccepted: 1000n * U,
      })
      .navSnapshot(0n, 0n, WAD, 1000n * U, true);
    let idx = await run(c);
    expect((await idx.ProtocolStats.getOrThrow("global")).tvl).toBe(1000n * U);
    expect((await idx.Vault.getOrThrow(VAULT)).navUpper).toBe(1000n * U);
    // two days later a market is created: that day has activity but no NAV snapshot
    const m = marketAddrs(9);
    c.tx(2 * DAY)
      .assetSet()
      .marketCreated(m, T0 + 3 * DAY);
    idx = await run(c);
    const days = (await idx.DailyStats.getAll()).sort((a, b) => a.day - b.day);
    const last = days.at(-1)!;
    expect(last.marketsCreated).toBe(1);
    expect([last.tvlClose, last.ppsClose]).toEqual([1000n * U, WAD]);
  });
});

describe("transfers and flags", () => {
  it("user-to-user token transfers move balance and cost; self transfers change nothing", async () => {
    const m = marketAddrs(4);
    const c = new Chain(T0);
    c.tx()
      .assetSet()
      .tx()
      .marketCreated(m, T0 + 900);
    c.tx()
      .transfer(m.up, VAULT, TAKER, 10n * U)
      .fill({
        market: m.market,
        upToken: true,
        vaultSells: true,
        units: 10n * U,
        premium: 6n * U,
        taker: TAKER,
      });
    c.tx().transfer(m.up, TAKER, OTHER, 5n * U);
    c.tx().transfer(m.up, OTHER, OTHER, 5n * U);
    const idx = await run(c);
    const a = await idx.UserPosition.getOrThrow(`${TAKER}_${m.market}`);
    const b = await idx.UserPosition.getOrThrow(`${OTHER}_${m.market}`);
    expect([a.upBalance, a.upCost, b.upBalance, b.upCost]).toEqual([
      5n * U,
      3n * U,
      5n * U,
      3n * U,
    ]);
  });

  it("flags and configuration events update the vault row", async () => {
    const c = new Chain(T0);
    c.tx().vault("QuotingPaused", { by: LP });
    c.tx().vault("QuotingHalted", { keeper: LP, reason: "0x" + "ab".repeat(32) });
    c.tx().vault("BreakerTripped", { ppsLower: 1n, dayStartPps: 2n });
    c.tx()
      .vault("TvlCapSet", { cap: 5000n * U })
      .vault("FeeSet", { bps: 1000n })
      .vault("KeeperSet", { keeper: TAKER })
      .vault("VenueSet", { venue: VENUE });
    let idx = await run(c);
    let v = await idx.Vault.getOrThrow(VAULT);
    expect([
      v.quotingPaused,
      v.quotingHalted,
      v.breakerTrips,
      v.tvlCap,
      v.performanceFeeBps,
      v.keeper,
      v.venue,
    ]).toEqual([true, true, 1, 5000n * U, 1000, TAKER, VENUE]);
    c.tx().vault("QuotingResumed", { by: LP }).vault("QuotingUnhalted", { keeper: LP });
    idx = await run(c);
    v = await idx.Vault.getOrThrow(VAULT);
    expect([v.quotingPaused, v.quotingHalted]).toEqual([false, false]);
    // the halt flag is cleared by the keeper's unhalt, the last reason and the count are kept
    expect([v.haltReason, v.haltCount]).toEqual(["0x" + "ab".repeat(32), 1]);
    expect(v.haltedAt).toBeGreaterThan(0);
  });

  it("a vault row created by any event starts from the constructor state in deployments/testnet.json", async () => {
    const c = new Chain(T0);
    c.tx().vault("QuotingPaused", { by: LP });
    const v = await (await run(c)).Vault.getOrThrow(VAULT);
    expect(v.performanceFeeBps).toBe(1000); // the contract's field initializer
    expect(v.tvlCap).toBe(5000n * U); // deployments/testnet.json vault.tvlCap
    expect(v.keeper).toBe("0x6e5008e79b3f6bcf314467c8b325b3784a9e9af4"); // vault.vaultKeeper, lowercased
  });

  it("an invalidated market and a redeem fee are recorded", async () => {
    const m = marketAddrs(5);
    const c = new Chain(T0);
    c.tx()
      .assetSet()
      .tx()
      .marketCreated(m, T0 + 900);
    c.tx().split(m, TAKER, 10n * U);
    c.tx().invalidated(m);
    c.tx().redeemed(m, TAKER, 10n * U, 10n * U, 9_900_000n, 100_000n); // half a token each, 1% fee
    const idx = await run(c);
    const mk = await idx.Market.getOrThrow(m.market);
    expect([mk.status, mk.outcome, mk.redeemFeesTotal]).toEqual(["INVALID", "INVALID", 100_000n]);
    const pos = await idx.UserPosition.getOrThrow(`${TAKER}_${m.market}`);
    expect(pos.realizedPnl).toBe(9_900_000n - 10n * U);
    expect((await idx.ProtocolStats.getOrThrow("global")).totalFeesRedeem).toBe(100_000n);
  });
});

describe("derived vault metrics", () => {
  it("7d and 30d APY come from day-bucketed NAV snapshots and are null until history covers the window", async () => {
    const DAY = 86_400;
    const c = new Chain(T0);
    const pps = (n: bigint) => (n * WAD) / 10_000n; // n in basis points of 1.0
    // One snapshot per day for 40 days; pps grows 0.1% per day.
    for (let d = 0; d <= 40; d++) {
      c.tx(d === 0 ? 1 : DAY).navSnapshot(
        1000n * U,
        1000n * U,
        pps(10_000n + BigInt(d) * 10n),
        1000n * U,
        false,
      );
    }
    const idx = await run(c);
    const v = await idx.Vault.getOrThrow(VAULT);
    // At day 40: baseline for 7d is the close of the last day ending before day 33 => day 32 snapshot
    expect(v.apy7d).toBeDefined();
    expect(v.apy30d).toBeDefined();
    // return over ~8 days of 0.1%/day is about 0.8%; over ~31 days about 3.1%
    expect(v.return7d!).toBeGreaterThan(0.007);
    expect(v.return7d!).toBeLessThan(0.0095);
    expect(v.return30d!).toBeGreaterThan(0.029);
    expect(v.return30d!).toBeLessThan(0.034);
    // annualised: (1.001)^365 - 1 is about 44%
    expect(v.apy7d!).toBeGreaterThan(0.38);
    expect(v.apy7d!).toBeLessThan(0.5);
    expect(v.apySinceInception!).toBeGreaterThan(0.38);
    expect((await idx.NavSnapshot.getAll()).length).toBe(41);

    // A young vault has no 7d / 30d figure.
    const c2 = new Chain(T0);
    for (let d = 0; d < 3; d++)
      c2.tx(d === 0 ? 1 : DAY).navSnapshot(
        1000n * U,
        1000n * U,
        pps(10_000n + BigInt(d) * 10n),
        1000n * U,
        false,
      );
    const y = await (await run(c2)).Vault.getOrThrow(VAULT);
    expect([y.apy7d, y.apy30d]).toEqual([undefined, undefined]);
    expect(y.apySinceInception).toBeUndefined(); // 3 days of history: withheld
  });
});

describe("routing", () => {
  it("only registered contracts are indexed: a Transfer from an unknown token is ignored by the router", async () => {
    const m = marketAddrs(6);
    const c = new Chain(T0);
    c.tx()
      .assetSet()
      .tx()
      .marketCreated(m, T0 + 900);
    c.tx().transfer(addr(0xdead0), ZERO, TAKER, 1n * U); // not one of our tokens
    const created = createTestIndexer();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      created.process({ chains: { [CHAIN]: { simulate: c.events as any } } as any }),
    ).rejects.toThrow(/never reached a handler/);
  });
});

describe("guards", () => {
  it("apySinceInception is withheld until a week of history exists", async () => {
    const c = new Chain(T0);
    c.tx().navSnapshot(1000n * U, 1000n * U, WAD, 1000n * U, false);
    c.tx(900).navSnapshot(1010n * U, 1010n * U, (101n * WAD) / 100n, 1000n * U, false); // +1% in 15 minutes
    let v = await (await run(c)).Vault.getOrThrow(VAULT);
    expect(v.apySinceInception).toBeUndefined(); // would annualise to ~1e151
    c.tx(8 * 86_400).navSnapshot(1010n * U, 1010n * U, (101n * WAD) / 100n, 1000n * U, false);
    v = await (await run(c)).Vault.getOrThrow(VAULT);
    expect(v.apySinceInception).toBeDefined();
    expect(Number.isFinite(v.apySinceInception!)).toBe(true);
  });

  it("a venue replacement registers the new venue: its orders are indexed under their own key and it is a system holder", async () => {
    const m = marketAddrs(8);
    const NEW_VENUE = addr(0x5001);
    const c = new Chain(T0);
    c.tx()
      .assetSet()
      .tx()
      .marketCreated(m, T0 + 900);
    c.tx().vault("VenueSet", { venue: NEW_VENUE });
    c.tx().split(m, OTHER, 10n * U);
    c.tx()
      .transfer(m.up, OTHER, NEW_VENUE, 4n * U)
      .emit("ForwardVenue", "OrderPlaced", NEW_VENUE, {
        id: 1n,
        taker: OTHER,
        market: m.market,
        kind: 1n,
        shares: 4n * U,
        limit: WAD / 10n,
        execAt: BigInt(c.now + 2),
        reward: 1n,
      });
    const idx = await run(c);
    // the same order id may exist in the old venue: the keys differ
    expect((await idx.Order.getOrThrow(`${NEW_VENUE}_1`)).venue).toBe(NEW_VENUE);
    const pos = await idx.UserPosition.getOrThrow(`${OTHER}_${m.market}`);
    expect([pos.upBalance, pos.upEscrowed, pos.upCost]).toEqual([6n * U, 4n * U, 5n * U]); // cost stays with the seller
    const venuePos = await idx.UserPosition.getOrThrow(`${NEW_VENUE}_${m.market}`);
    expect([venuePos.upBalance, venuePos.upCost]).toEqual([4n * U, 0n]);
  });

  it("a claim without its request halts the indexer instead of silently dropping the cost basis", async () => {
    const c = new Chain(T0);
    c.tx().depositClaimed(3, LP, LP, 10n * U, 0n);
    await expect(run(c)).rejects.toThrow(/DepositClaimed without a DepositRequest/);
  });
});
