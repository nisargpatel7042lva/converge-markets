/**
 * PartnerRegistry handlers (ADR-008): who the partners are, their bonds and caps, the markets they
 * created, and the owner's governance actions (slash, suspend, void). The registry's MarketCreated is
 * handled with the factory's (market.ts); here a market gets its `partner` and the `Partner` entity
 * is kept in step with the registry's own accounting.
 */
import { indexer, type Partner } from "envio";
import { type Ctx, lc } from "../lib/store";

async function loadPartner(context: Ctx, address: string, block: number): Promise<Partner> {
  return context.Partner.getOrCreate({
    id: lc(address),
    approved: false,
    suspended: false,
    exposureCap: 0n,
    feeShareBps: 0,
    bond: 0n,
    pendingWithdrawal: 0n,
    slashedTotal: 0n,
    marketsCreated: 0,
    voidedMarkets: 0,
    feesEarned: 0n,
    allowedAssets: [],
    firstSeenBlock: block,
    updatedBlock: block,
  });
}

const touch = (p: Partner, block: number, over: Partial<Partner>): Partner => ({
  ...p,
  ...over,
  updatedBlock: block,
});

indexer.onEvent(
  { contract: "PartnerRegistry", event: "PartnerMarketCreated" },
  async ({ event, context }) => {
    const market = await context.Market.get(lc(event.params.market));
    if (market) context.Market.set({ ...market, partner: lc(event.params.partner) });
    else context.log.error(`PartnerMarketCreated for an unknown market ${event.params.market}`);
    const p = await loadPartner(context, event.params.partner, event.block.number);
    context.Partner.set(touch(p, event.block.number, { marketsCreated: p.marketsCreated + 1 }));
  },
);

indexer.onEvent(
  { contract: "PartnerRegistry", event: "PartnerApproved" },
  async ({ event, context }) => {
    const p = await loadPartner(context, event.params.partner, event.block.number);
    const assets = new Set([...p.allowedAssets, ...event.params.assets.map(lc)]);
    context.Partner.set(
      touch(p, event.block.number, {
        approved: true,
        exposureCap: event.params.exposureCap,
        feeShareBps: Number(event.params.feeShareBps),
        allowedAssets: [...assets],
      }),
    );
  },
);

indexer.onEvent(
  { contract: "PartnerRegistry", event: "PartnerTermsSet" },
  async ({ event, context }) => {
    const p = await loadPartner(context, event.params.partner, event.block.number);
    context.Partner.set(
      touch(p, event.block.number, {
        exposureCap: event.params.exposureCap,
        feeShareBps: Number(event.params.feeShareBps),
      }),
    );
  },
);

indexer.onEvent(
  { contract: "PartnerRegistry", event: "PartnerSuspended" },
  async ({ event, context }) => {
    const p = await loadPartner(context, event.params.partner, event.block.number);
    context.Partner.set(touch(p, event.block.number, { suspended: event.params.suspended }));
  },
);

indexer.onEvent(
  { contract: "PartnerRegistry", event: "BondPosted" },
  async ({ event, context }) => {
    const p = await loadPartner(context, event.params.partner, event.block.number);
    context.Partner.set(touch(p, event.block.number, { bond: event.params.bond }));
  },
);

// A withdrawal request moves the amount from the active bond to the pending withdrawal.
indexer.onEvent(
  { contract: "PartnerRegistry", event: "BondWithdrawalRequested" },
  async ({ event, context }) => {
    const p = await loadPartner(context, event.params.partner, event.block.number);
    context.Partner.set(
      touch(p, event.block.number, {
        bond: p.bond - event.params.amount,
        pendingWithdrawal: p.pendingWithdrawal + event.params.amount,
      }),
    );
  },
);

indexer.onEvent(
  { contract: "PartnerRegistry", event: "BondWithdrawalCancelled" },
  async ({ event, context }) => {
    const p = await loadPartner(context, event.params.partner, event.block.number);
    context.Partner.set(
      touch(p, event.block.number, {
        bond: p.bond + event.params.amount,
        pendingWithdrawal: p.pendingWithdrawal - event.params.amount,
      }),
    );
  },
);

indexer.onEvent(
  { contract: "PartnerRegistry", event: "BondWithdrawn" },
  async ({ event, context }) => {
    const p = await loadPartner(context, event.params.partner, event.block.number);
    context.Partner.set(
      touch(p, event.block.number, {
        pendingWithdrawal: p.pendingWithdrawal - event.params.amount,
      }),
    );
  },
);

// A slash takes the active bond first, then a pending withdrawal (PartnerRegistry.slash).
indexer.onEvent({ contract: "PartnerRegistry", event: "Slashed" }, async ({ event, context }) => {
  const p = await loadPartner(context, event.params.partner, event.block.number);
  const amount = event.params.amount;
  const fromBond = amount > p.bond ? p.bond : amount;
  context.Partner.set(
    touch(p, event.block.number, {
      bond: p.bond - fromBond,
      pendingWithdrawal: p.pendingWithdrawal - (amount - fromBond),
      slashedTotal: p.slashedTotal + amount,
    }),
  );
});

indexer.onEvent(
  { contract: "PartnerRegistry", event: "MarketVoided" },
  async ({ event, context }) => {
    const market = await context.Market.get(lc(event.params.market));
    if (market) context.Market.set({ ...market, voided: true });
    const p = await loadPartner(context, event.params.partner, event.block.number);
    context.Partner.set(touch(p, event.block.number, { voidedMarkets: p.voidedMarkets + 1 }));
  },
);

indexer.onEvent(
  { contract: "PartnerRegistry", event: "FeesCollected" },
  async ({ event, context }) => {
    const p = await loadPartner(context, event.params.partner, event.block.number);
    context.Partner.set(
      touch(p, event.block.number, { feesEarned: p.feesEarned + event.params.partnerShare }),
    );
  },
);
