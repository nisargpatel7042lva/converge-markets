import { createPublicClient, webSocket, type PublicClient } from "viem";
import type { Logger } from "pino";
import { errText } from "../errors";

export type Head = {
  number: bigint;
  /** Chain time in seconds. */
  timestamp: bigint;
  /** Wall clock when this process first saw the block. */
  seenAtMs: number;
};

/**
 * New heads: a WebSocket subscription when `wsUrl` is set, with an HTTP polling fallback that takes
 * over when the socket is silent (or absent) and gives way again once a socket delivers blocks.
 */
export class BlockSource {
  private polling: NodeJS.Timeout | null = null;
  private unwatch: (() => void) | null = null;
  private last: Head | null = null;
  private stopped = false;
  private wsClient: PublicClient | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  mode: "ws" | "poll" = "poll";
  readonly byNumber = new Map<bigint, Head>();

  constructor(
    private readonly pub: PublicClient,
    private readonly onHead: (h: Head) => void,
    private readonly log: Logger,
    private readonly o: {
      wsUrl?: string | undefined;
      pollMs: number;
      stallMs: number;
      now?: () => number;
    },
  ) {}

  get latest(): Head | null {
    return this.last;
  }

  start(): void {
    this.stopped = false;
    if (this.o.wsUrl) this.openWs();
    this.startPolling(); // always running: cheap insurance while the socket is the primary
    this.stallTimer = setInterval(() => this.checkStall(), Math.max(250, this.o.stallMs / 2));
    this.stallTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    this.unwatch?.();
    if (this.polling) clearInterval(this.polling);
    if (this.stallTimer) clearInterval(this.stallTimer);
  }

  private emit(number: bigint, timestamp: bigint, via: "ws" | "poll"): void {
    if (this.last && number <= this.last.number) return;
    const now = (this.o.now ?? Date.now)();
    const h: Head = { number, timestamp, seenAtMs: now };
    this.last = h;
    this.mode = via;
    this.byNumber.set(number, h);
    if (this.byNumber.size > 2_000) {
      const first = this.byNumber.keys().next().value as bigint;
      this.byNumber.delete(first);
    }
    this.onHead(h);
  }

  private openWs(): void {
    if (this.stopped || !this.o.wsUrl) return;
    try {
      this.wsClient = createPublicClient({
        transport: webSocket(this.o.wsUrl, { retryCount: 0 }),
      }) as PublicClient;
      this.unwatch = this.wsClient.watchBlocks({
        onBlock: (b) => {
          // a socket error can deliver an empty block: ignore it, the polling fallback covers
          if (b?.number === null || b?.number === undefined) return;
          this.emit(b.number, b.timestamp, "ws");
        },
        onError: (e) => {
          this.log.warn({ err: errText(e, 100) }, "block socket error");
          this.reopenWsLater();
        },
        emitMissed: false,
      });
    } catch (e) {
      this.log.warn({ err: errText(e, 100) }, "block socket open failed");
      this.reopenWsLater();
    }
  }

  private reopenWsLater(): void {
    this.unwatch?.();
    this.unwatch = null;
    setTimeout(() => this.openWs(), 3_000).unref();
  }

  private startPolling(): void {
    let busy = false;
    this.polling = setInterval(async () => {
      if (busy) return;
      // when the socket is healthy the polling loop only runs at a low rate
      const socketHealthy =
        this.o.wsUrl !== undefined &&
        this.mode === "ws" &&
        this.last !== null &&
        (this.o.now ?? Date.now)() - this.last.seenAtMs < this.o.stallMs;
      if (socketHealthy) return;
      busy = true;
      try {
        const b = await this.pub.getBlock();
        this.emit(b.number as bigint, b.timestamp, "poll");
      } catch (e) {
        this.log.debug({ err: errText(e, 80) }, "block poll failed");
      } finally {
        busy = false;
      }
    }, this.o.pollMs);
    this.polling.unref();
  }

  private checkStall(): void {
    if (!this.o.wsUrl || this.mode !== "ws" || !this.last) return;
    if ((this.o.now ?? Date.now)() - this.last.seenAtMs > this.o.stallMs) {
      this.log.warn("block socket silent: polling over HTTP");
      this.mode = "poll";
      this.reopenWsLater();
    }
  }
}
