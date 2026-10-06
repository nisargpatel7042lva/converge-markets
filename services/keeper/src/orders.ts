import type { Address } from "viem";
import { type Clients } from "./chain/clients";
import { readNextOrderId, readOrder, type OrderRow } from "./chain/vault";

/**
 * Follows the venue's orders by id (no event log queries): new ids are read as they appear, and an
 * order leaves the pending set the moment the venue no longer shows it OPEN. One batched HTTP
 * request per refresh.
 */
export class OrderTracker {
  private scanFrom: bigint | null = null;
  private readonly pending = new Map<bigint, OrderRow>();

  constructor(
    private readonly c: Clients,
    private readonly venue: Address,
    /** On start, look back this many ids for orders still pending. */
    private readonly lookback = 200n,
  ) {}

  get open(): OrderRow[] {
    return [...this.pending.values()].sort((a, b) =>
      a.execAt === b.execAt ? Number(a.id - b.id) : a.execAt - b.execAt,
    );
  }

  get size(): number {
    return this.pending.size;
  }

  /** Drop an order we know is finished (we executed or expired it). */
  forget(id: bigint): void {
    this.pending.delete(id);
  }

  async refresh(): Promise<void> {
    const next = await readNextOrderId(this.c, this.venue);
    this.scanFrom ??= next > this.lookback ? next - this.lookback : 1n;
    const ids: bigint[] = [];
    for (let id = this.scanFrom; id < next; id++) ids.push(id);
    for (const id of this.pending.keys()) if (!ids.includes(id)) ids.push(id);
    if (ids.length === 0) return;
    const rows = await Promise.all(ids.map((id) => readOrder(this.c, this.venue, id)));
    for (const r of rows) {
      if (r.status === 1) this.pending.set(r.id, r);
      else this.pending.delete(r.id);
    }
    this.scanFrom = next;
  }
}
