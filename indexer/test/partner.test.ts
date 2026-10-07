import { createTestIndexer } from "envio";
import { describe, expect, it } from "vitest";
import {
  ASSET,
  CHAIN,
  Chain,
  LP,
  OTHER,
  REGISTRY,
  TAKER,
  VAULT,
  ZERO,
  addr,
  marketAddrs,
} from "./helpers";

const U = 1_000_000n;
const WAD = 10n ** 18n;
const T0 = 1_790_000_000 - (1_790_000_000 % 900);
const PARTNER = addr(0x5001);
const PARTNER2 = addr(0x5002);

async function run(chain: Chain) {
  const idx = createTestIndexer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await idx.process({ chains: { [CHAIN]: { simulate: chain.events as any } } as any });
  return idx;
}

describe("partner markets (PartnerRegistry, ADR-008)", () => {
  it("indexes a partner market like a factory market, with its partner, strike and 3 hour duration", async () => {
    const m = marketAddrs(7);
    const c = new Chain(T0);
    c.tx().assetSet("ETH/USD");
    c.tx().vault("PartnerRegistrySet", { registry: REGISTRY });
    c.tx().registry("PartnerApproved", {
      partner: PARTNER,
      exposureCap: 40n * U,
      feeShareBps: 3000,
      assets: [ASSET],
    });
    c.tx().registry("BondPosted", { partner: PARTNER, amount: 100n * U, bond: 100n * U });
    // creation: MarketCreated and PartnerMarketCreated, then Opened (same transaction, in this order)
    c.tx()
      .partnerMarketCreated(m, PARTNER, c.now, 3 * 3600, 3200n * WAD)
      .opened(m, 3200n * WAD);
    // the vault allocates and a taker buys through the ordinary venue / vault events
    c.tx()
      .vault("MarketRegistered", { market: m.market, assetId: ASSET })
      .split(m, VAULT, 40n * U)
      .vault("InventorySplit", { market: m.market, amount: 40n * U });
    c.tx()
      .orderPlaced({
        id: 1,
        taker: TAKER,
        market: m.market,
        kind: 0,
        shares: 10n * U,
        limit: (6n * WAD) / 10n,
        execAt: c.now + 2,
      })
      .transfer(m.up, VAULT, TAKER, 10n * U)
      .fill({
        market: m.market,
        upToken: true,
        vaultSells: true,
        units: 10n * U,
        premium: 5_500_000n,
        taker: TAKER,
        basis: 30n * U,
        cash: 5_500_000n,
      })
      .orderExecuted(1, OTHER, 10n * U, 5_500_000n);
    const idx = await run(c);

    const market = await idx.Market.getOrThrow(m.market);
    expect(market.partner).toBe(PARTNER);
    expect(market.voided).toBe(false);
    expect(market.status).toBe("OPEN");
    expect(market.strike).toBe(3200n * WAD);
    expect(market.duration).toBe(3 * 3600);
    expect(market.endTime - market.startTime).toBe(3 * 3600);
    expect(market.redeemFeeBps).toBe(50);
    expect(market.vaultRegistered).toBe(true);
    expect(market.volume).toBe(5_500_000n);
    expect(market.tradeCount).toBe(1);
    // both tokens were registered from the registry's MarketCreated
    expect((await idx.OutcomeToken.getOrThrow(m.up)).market_id).toBe(m.market);
    expect((await idx.OutcomeToken.getOrThrow(m.down)).market_id).toBe(m.market);

    const p = await idx.Partner.getOrThrow(PARTNER);
    expect(p).toMatchObject({
      approved: true,
      suspended: false,
      exposureCap: 40n * U,
      feeShareBps: 3000,
      bond: 100n * U,
      marketsCreated: 1,
      voidedMarkets: 0,
      slashedTotal: 0n,
    });
    expect(p.allowedAssets).toEqual([ASSET]);
    const protocol = await idx.ProtocolStats.getOrThrow("global");
    expect(protocol.totalMarkets).toBe(1);
    expect(protocol.totalVolume).toBe(5_500_000n);
  });

  it("keeps the bond, pending withdrawal and slashes in step with the registry's accounting", async () => {
    const c = new Chain(T0);
    c.tx().vault("PartnerRegistrySet", { registry: REGISTRY });
    c.tx().registry("PartnerApproved", {
      partner: PARTNER,
      exposureCap: 40n * U,
      feeShareBps: 0,
      assets: [],
    });
    c.tx().registry("BondPosted", { partner: PARTNER, amount: 100n * U, bond: 100n * U });
    c.tx().registry("BondWithdrawalRequested", {
      partner: PARTNER,
      amount: 40n * U,
      withdrawableAt: BigInt(T0 + 8 * 86_400),
    });
    c.tx().registry("BondWithdrawalCancelled", { partner: PARTNER, amount: 10n * U });
    // bond 70, pending 30; a 80 slash takes the whole bond first, then 10 of the pending
    c.tx().registry("Slashed", {
      partner: PARTNER,
      amount: 80n * U,
      recipient: VAULT,
      reason: `0x${"ab".repeat(32)}`,
    });
    c.tx().registry("BondWithdrawn", { partner: PARTNER, amount: 20n * U });
    const idx = await run(c);
    const p = await idx.Partner.getOrThrow(PARTNER);
    expect(p.bond).toBe(0n);
    expect(p.pendingWithdrawal).toBe(0n);
    expect(p.slashedTotal).toBe(80n * U);
  });

  it("tracks suspension, terms, voided markets and fees", async () => {
    const m = marketAddrs(9);
    const c = new Chain(T0);
    c.tx().assetSet("ETH/USD");
    c.tx().vault("PartnerRegistrySet", { registry: REGISTRY });
    c.tx().registry("PartnerApproved", {
      partner: PARTNER,
      exposureCap: 40n * U,
      feeShareBps: 3000,
      assets: [ASSET],
    });
    c.tx().registry("PartnerApproved", {
      partner: PARTNER2,
      exposureCap: 10n * U,
      feeShareBps: 100,
      assets: [],
    });
    c.tx()
      .partnerMarketCreated(m, PARTNER, c.now, 900, 3000n * WAD)
      .opened(m, 3000n * WAD);
    c.tx().registry("PartnerTermsSet", {
      partner: PARTNER,
      exposureCap: 25n * U,
      feeShareBps: 500,
    });
    c.tx().registry("PartnerSuspended", { partner: PARTNER, suspended: true, by: OTHER });
    c.tx().registry("MarketVoided", {
      market: m.market,
      partner: PARTNER,
      reason: `0x${"cd".repeat(32)}`,
    });
    c.tx().registry("FeesCollected", {
      market: m.market,
      partner: PARTNER,
      partnerShare: 1_500_000n,
      treasuryShare: 3_500_000n,
    });
    c.tx().registry("PartnerSuspended", { partner: PARTNER, suspended: false, by: LP });
    const idx = await run(c);
    const p = await idx.Partner.getOrThrow(PARTNER);
    expect(p).toMatchObject({
      exposureCap: 25n * U,
      feeShareBps: 500,
      suspended: false,
      voidedMarkets: 1,
      feesEarned: 1_500_000n,
    });
    expect((await idx.Market.getOrThrow(m.market)).voided).toBe(true);
    expect((await idx.Vault.getOrThrow(VAULT)).partnerRegistry).toBe(REGISTRY);
    // the other partner is untouched
    const q = await idx.Partner.getOrThrow(PARTNER2);
    expect(q).toMatchObject({ exposureCap: 10n * U, marketsCreated: 0, voidedMarkets: 0 });
    expect(ZERO).toBe("0x0000000000000000000000000000000000000000");
  });

  it("does not mark a core factory market as a partner market", async () => {
    const m = marketAddrs(3);
    const c = new Chain(T0);
    c.tx().assetSet("BTC/USD");
    c.tx().marketCreated(m, T0 + 900);
    const idx = await run(c);
    const market = await idx.Market.getOrThrow(m.market);
    expect(market.partner).toBeUndefined();
    expect(market.voided).toBe(false);
  });
});
