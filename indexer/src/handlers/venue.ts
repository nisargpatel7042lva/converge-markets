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

const isSell = (kind: (typeof KINDS)[number]): boolean =>
  kind === "SELL_UP" || kind === "SELL_DOWN";
const sideOf = (kind: (typeof KINDS)[number]): SideKey =>
  kind === "BUY_UP" || kind === "SELL_UP" ? "up" : "down";

indexer.onEvent({ contract: "ForwardVenue", event: "OrderPlaced" }, async ({ event, context }) => {
  const p = event.params;
  const ts = event.block.timestamp;
  const kind = KINDS[Number(p.kind)];
  if (!kind) {
    context.log.error(`OrderPlaced with unknown kind ${p.kind}`);
    return;
  }
  const taker = lc(p.taker);
  const market = lc(p.market);
  context.Order.set({
    id: p.id.toString(),
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
    const order = await context.Order.get(p.id.toString());
    if (!order) {
      context.log.error(`OrderExecuted for unknown order ${p.id}`);
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
  const order = await context.Order.get(event.params.id.toString());
  if (!order) {
    context.log.error(`OrderExpired for unknown order ${event.params.id}`);
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
