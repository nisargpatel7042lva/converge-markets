/**
 * Local nonce bookkeeping. The chain's pending nonce is read once; after that every transaction
 * takes the next number locally so several can be in flight at once. A nonce that was acquired but
 * never broadcast is released and reused (a gap would block everything after it).
 */
export class NonceManager {
  private next: number | null = null;
  private readonly gaps: number[] = [];
  private readonly inflight = new Set<number>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly fetchPending: () => Promise<number>) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  acquire(): Promise<number> {
    return this.serial(async () => {
      if (this.next === null) this.next = await this.fetchPending();
      const gap = this.gaps.shift();
      const n = gap ?? this.next++;
      this.inflight.add(n);
      return n;
    });
  }

  /** Take over a nonce that is already in use on the chain (a replacement of the transaction there). */
  adopt(nonce: number): void {
    this.inflight.add(nonce);
    const gap = this.gaps.indexOf(nonce);
    if (gap >= 0) this.gaps.splice(gap, 1);
    if (this.next !== null && nonce >= this.next) this.next = nonce + 1;
  }

  /** The transaction with this nonce was mined (or replaced): it is done. */
  settle(nonce: number): void {
    this.inflight.delete(nonce);
  }

  /** The nonce was never broadcast: hand it to the next caller. */
  release(nonce: number): void {
    if (!this.inflight.delete(nonce)) return;
    if (this.next !== null && nonce === this.next - 1) {
      this.next -= 1;
      // collapse gaps that now touch the end
      while (this.gaps.length > 0 && this.gaps[this.gaps.length - 1] === this.next - 1) {
        this.gaps.pop();
        this.next -= 1;
      }
    } else if (!this.gaps.includes(nonce)) {
      this.gaps.push(nonce);
      this.gaps.sort((a, b) => a - b);
    }
  }

  /** After "nonce too low/high" or a long outage: trust the chain again. */
  resync(): Promise<number> {
    return this.serial(async () => {
      const chain = await this.fetchPending();
      const top = this.inflight.size > 0 ? Math.max(...this.inflight) + 1 : 0;
      this.next = Math.max(chain, top);
      this.gaps.length = 0;
      return this.next;
    });
  }

  get pendingCount(): number {
    return this.inflight.size;
  }

  get peek(): number | null {
    return this.next;
  }
}
