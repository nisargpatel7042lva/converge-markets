/**
 * ForwardVenue handlers (ADR-004): orders placed at t, executed once at t + execDelay.
 * Fills themselves are indexed from ConvergeVault.Fill (one event per ladder level); here we track
 * the order lifecycle and the escrow of sell orders (tokens locked in the venue until execution).
 *
 * This is also the repo's trade source in place of the spec's KuruAdapter / PmAmmPool: neither
 * contract exists (ADR-004/005, Kuru leg blocked), so nothing is indexed for them.
 */
import { indexer } from "envio";
import { addEscrow, releaseEscrow, type SideKey } from "../lib/position";
import { lc, loadPosition, positionState, savePosition, touchUser } from "../lib/store";

// ForwardVenue.Kind: 0 BUY_UP, 1 SELL_UP, 2 BUY_DOWN, 3 SELL_DOWN.
const KINDS = ["BUY_UP", "SELL_UP", "BUY_DOWN", "SELL_DOWN"] as const;

/** Order ids restart at 1 in every ForwardVenue deployment: key them by venue. */
const orderKey = (venue: string, id: bigint): string => `${lc(venue)}_${id}`;

const isSell = (kind: (typeof KINDS)[number]): boolean =>
  kind === "SELL_UP" || kind === "SELL_DOWN";
const sideOf = (kind: (typeof KINDS)[number]): SideKey =>
  kind === "BUY_UP" || kind === "SELL_UP" ? "up" : "down";

indexer.onEvent({ contract: "ForwardVenue", event: "OrderPlaced" }, async ({ event, context }) => {
  const p = event.params;
  const ts = event.block.timestamp;
  const kind = KINDS[Number(p.kind)];
  if (!kind) throw new Error(`OrderPlaced with unknown kind ${p.kind}`);
  const taker = lc(p.taker);
  const market = lc(p.market);
  context.Order.set({
    id: orderKey(event.srcAddress, p.id),
    venue: lc(event.srcAddress),
    orderId: p.id,
    taker,
    market_id: market,
    kind,
    status: "OPEN",
    shares: p.shares,
    limit: p.limit,
    execAt: Number(p.execAt),
    reward: p.reward,
    filled: undefined,
    premium: undefined,
    executor: undefined,
    reportPrice: undefined,
    placedBlock: event.block.number,
    placedTimestamp: ts,
    placedTx: event.transaction.hash,
    settledBlock: undefined,
    settledTimestamp: undefined,
    settledTx: undefined,
  });
  await touchUser(context, event.chainId, taker, ts, event.block.number);
  if (isSell(kind)) {
    const pos = await loadPosition(context, taker, market, ts);
    savePosition(context, pos, addEscrow(positionState(pos), sideOf(kind), p.shares), ts);
  }
});

indexer.onEvent(
  { contract: "ForwardVenue", event: "OrderExecuted" },
  async ({ event, context }) => {
    const p = event.params;
    const ts = event.block.timestamp;
    const order = await context.Order.get(orderKey(event.srcAddress, p.id));
    if (!order) {
      // An order placed before this venue was indexed (anyone can place orders on any venue
      // contract): nothing of ours changes, and a griefer must not be able to halt the indexer.
      context.log.warn(
        `OrderExecuted for unknown order ${p.id} of venue ${event.srcAddress}: skipped`,
      );
      return;
    }
    context.Order.set({
      ...order,
      status: "EXECUTED",
      filled: p.filled,
      premium: p.premium,
      executor: lc(p.executor),
      reportPrice: p.reportPrice,
      settledBlock: event.block.number,
      settledTimestamp: ts,
      settledTx: event.transaction.hash,
    });
    if (isSell(order.kind)) {
      // The Fill events already released `filled` from escrow; the unfilled rest was refunded.
      const refunded = order.shares > p.filled ? order.shares - p.filled : 0n;
      const pos = await loadPosition(context, order.taker, order.market_id, ts);
      savePosition(
        context,
        pos,
        releaseEscrow(positionState(pos), sideOf(order.kind), refunded),
        ts,
      );
    }
  },
);

indexer.onEvent({ contract: "ForwardVenue", event: "OrderExpired" }, async ({ event, context }) => {
  const ts = event.block.timestamp;
  const order = await context.Order.get(orderKey(event.srcAddress, event.params.id));
  if (!order) {
    context.log.warn(
      `OrderExpired for unknown order ${event.params.id} of venue ${event.srcAddress}: skipped`,
    );
    return;
  }
  context.Order.set({
    ...order,
    status: "EXPIRED",
    filled: 0n,
    premium: 0n,
    settledBlock: event.block.number,
    settledTimestamp: ts,
    settledTx: event.transaction.hash,
  });
  if (isSell(order.kind)) {
    const pos = await loadPosition(context, order.taker, order.market_id, ts);
    savePosition(
      context,
      pos,
      releaseEscrow(positionState(pos), sideOf(order.kind), order.shares),
      ts,
    );
  }
});
