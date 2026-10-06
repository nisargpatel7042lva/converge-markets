import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { NonceManager } from "../../src/chain/nonce";
import {
  FeeCapExceeded,
  SimulationReverted,
  TxManager,
  TxTimeout,
  type ChainTx,
  type TxManagerCfg,
  type TxReceipt,
  type TxRequest,
} from "../../src/chain/tx";

const GWEI = 10n ** 9n;
const cfg: TxManagerCfg = {
  gasMultiplierPct: 115,
  maxFeePerGasWei: 300n * GWEI,
  haltFeeBoost: 3,
  stuckMs: 1000,
  maxReplacements: 2,
  bumpPct: 25,
  pollMs: 100,
};
const TO = "0x0000000000000000000000000000000000000001" as Address;
const DATA = "0xdeadbeef" as Hex;

/** A chain that mines on demand: a clock, a mempool and a nonce counter. */
class FakeChain implements ChainTx {
  nowMs = 0;
  chainNonce = 0;
  baseFee = 100n * GWEI;
  tip = 2n * GWEI;
  sent: TxRequest[] = [];
  mined = new Map<Hex, TxReceipt>();
  /** Hash -> number of polls before it is mined (Infinity = never). */
  behaviour: (req: TxRequest, n: number) => number = () => 0;
  failEstimate = false;
  failSend: ((req: TxRequest, n: number) => Error | null) | null = null;
  private sends = 0;
  private due = new Map<Hex, { polls: number; req: TxRequest }>();

  async fees() {
    return { baseFee: this.baseFee, tip: this.tip };
  }
  async estimateGas() {
    if (this.failEstimate) throw new Error("execution reverted: MarketNotTradable");
    return 200_000n;
  }
  async sendTx(req: TxRequest): Promise<Hex> {
    this.sends += 1;
    const err = this.failSend?.(req, this.sends);
    if (err) throw err;
    this.sent.push(req);
    const hash = `0x${this.sends.toString(16).padStart(64, "0")}` as Hex;
    this.due.set(hash, { polls: this.behaviour(req, this.sends), req });
    return hash;
  }
  async receipt(hash: Hex): Promise<TxReceipt | null> {
    const d = this.due.get(hash);
    if (!d) return null;
    if (d.polls > 0) {
      d.polls -= 1;
      return null;
    }
    // a replacement for the same nonce wins only if it pays more (we mine whatever is asked)
    this.confirmed = Math.max(this.confirmed, d.req.nonce + 1);
    return {
      hash,
      status: "success",
      blockNumber: 100n + BigInt(this.sends),
      gasUsed: 150_000n,
      effectiveGasPrice: d.req.maxFeePerGas,
    };
  }
  async pendingNonce() {
    return this.chainNonce;
  }
  /** Nonces the chain has consumed (mined transactions); tests move it as they mine. */
  confirmed = 0;
  readonly address = TO;
  async confirmedNonce() {
    return this.confirmed;
  }
}

function make(chain: FakeChain, over: Partial<TxManagerCfg> = {}) {
  const sleep = async (ms: number) => {
    chain.nowMs += ms;
  };
  return new TxManager(chain, { ...cfg, ...over }, { now: () => chain.nowMs, sleep });
}

describe("NonceManager", () => {
  it("starts from the chain and counts up locally, even concurrently", async () => {
    const n = new NonceManager(async () => 7);
    const got = await Promise.all([n.acquire(), n.acquire(), n.acquire()]);
    expect(got).toEqual([7, 8, 9]);
  });

  it("reuses a released nonce instead of leaving a gap", async () => {
    const n = new NonceManager(async () => 0);
    const [a, b, c] = [await n.acquire(), await n.acquire(), await n.acquire()];
    n.release(b); // a middle one was never broadcast
    expect(await n.acquire()).toBe(b);
    n.release(c); // the last one collapses back
    expect(await n.acquire()).toBe(c);
    expect(a).toBe(0);
  });

  it("collapses touching gaps when the tail is released", async () => {
    const n = new NonceManager(async () => 0);
    const xs = [await n.acquire(), await n.acquire(), await n.acquire()];
    n.release(xs[1] as number);
    n.release(xs[2] as number);
    expect(n.peek).toBe(1);
    expect(await n.acquire()).toBe(1);
  });

  it("resyncs from the chain and never goes below an in-flight nonce", async () => {
    let chain = 0;
    const n = new NonceManager(async () => chain);
    await n.acquire(); // 0 in flight
    await n.acquire(); // 1 in flight
    chain = 5;
    expect(await n.resync()).toBe(5);
    chain = 0; // a lagging node
    expect(await n.resync()).toBe(2); // not below the highest in-flight + 1
  });
});

describe("TxManager", () => {
  it("sends, waits for the receipt and reports latency and cost on the gas limit", async () => {
    const chain = new FakeChain();
    chain.behaviour = () => 3; // three polls before it is mined
    const seen: string[] = [];
    const tm = new TxManager(chain, cfg, {
      now: () => chain.nowMs,
      sleep: async (ms) => void (chain.nowMs += ms),
      onTx: (r) => seen.push(r.kind),
    });
    const r = await tm.submit("setSigma", TO, DATA);
    expect(r.status).toBe("success");
    expect(r.nonce).toBe(0);
    expect(r.attempts).toBe(1);
    expect(r.gasLimit).toBe(230_000n); // 200,000 x 1.15
    expect(r.latencyMs).toBe(300);
    expect(r.costWei).toBe(230_000n * r.effectiveGasPrice); // Monad bills the limit
    expect(seen).toEqual(["setSigma"]);
    expect(chain.sent[0]?.maxFeePerGas).toBe(100n * GWEI * 2n + 2n * GWEI);
  });

  it("gives concurrent transactions consecutive nonces", async () => {
    const chain = new FakeChain();
    chain.chainNonce = 40;
    const tm = make(chain);
    const rs = await Promise.all([
      tm.submit("a", TO, DATA),
      tm.submit("b", TO, DATA),
      tm.submit("c", TO, DATA),
    ]);
    expect(rs.map((r) => r.nonce).sort()).toEqual([40, 41, 42]);
  });

  it("replaces a stuck transaction with the same nonce and a higher fee", async () => {
    const chain = new FakeChain();
    chain.behaviour = (_req, n) => (n === 1 ? Number.POSITIVE_INFINITY : 0); // the first never mines
    const tm = make(chain);
    const r = await tm.submit("executeOrder", TO, DATA);
    expect(r.attempts).toBe(2);
    expect(chain.sent).toHaveLength(2);
    expect(chain.sent[1]?.nonce).toBe(chain.sent[0]?.nonce);
    expect((chain.sent[1]?.maxFeePerGas ?? 0n) > (chain.sent[0]?.maxFeePerGas ?? 0n)).toBe(true);
    expect(r.latencyMs).toBeGreaterThanOrEqual(1000);
  });

  it("times out after the replacements and keeps the nonce reserved", async () => {
    const chain = new FakeChain();
    chain.behaviour = () => Number.POSITIVE_INFINITY;
    const tm = make(chain);
    await expect(tm.submit("x", TO, DATA)).rejects.toBeInstanceOf(TxTimeout);
    expect(chain.sent).toHaveLength(4); // the original, two replacements and the cancellation
    const cancel = chain.sent[3] as TxRequest;
    expect(cancel.to).toBe(chain.address);
    expect(cancel.gas).toBe(21_000n);
    expect(cancel.nonce).toBe(chain.sent[0]?.nonce);
    expect(cancel.maxFeePerGas > (chain.sent[2]?.maxFeePerGas ?? 0n)).toBe(true);
    expect(tm.nonces.pendingCount).toBe(1); // the cancellation did not mine either: still held
    chain.behaviour = () => 0;
    const next = await tm.submit("y", TO, DATA);
    expect(next.nonce).toBe(1); // not 0: that one is still pending
  });

  it("does not take a nonce when the simulation reverts", async () => {
    const chain = new FakeChain();
    chain.failEstimate = true;
    const tm = make(chain);
    await expect(tm.submit("settleEpoch", TO, DATA)).rejects.toBeInstanceOf(SimulationReverted);
    chain.failEstimate = false;
    expect((await tm.submit("ok", TO, DATA)).nonce).toBe(0);
  });

  it("releases the nonce when the broadcast fails", async () => {
    const chain = new FakeChain();
    chain.failSend = (_r, n) => (n === 1 ? new Error("connection reset") : null);
    const tm = make(chain);
    await expect(tm.submit("a", TO, DATA)).rejects.toThrow("connection reset");
    expect((await tm.submit("b", TO, DATA)).nonce).toBe(0); // reused, no gap
  });

  it("resyncs on 'nonce too low' and retries once", async () => {
    const chain = new FakeChain();
    chain.chainNonce = 3;
    const tm = make(chain);
    await tm.nonces.acquire(); // local counter now 4 after the next acquire; chain says 3...
    tm.nonces.release(3);
    chain.chainNonce = 10; // the chain moved on without us (another process used 3..9)
    chain.failSend = (req, n) =>
      n === 1 ? new Error("nonce too low") : req.nonce < 10 ? new Error("nonce too low") : null;
    const r = await tm.submit("a", TO, DATA);
    expect(r.nonce).toBeGreaterThanOrEqual(10);
  });

  it("refuses to pay above the fee cap, except a halt, which may pay more", async () => {
    const chain = new FakeChain();
    chain.baseFee = 400n * GWEI; // above the 300 gwei cap
    const tm = make(chain);
    await expect(tm.submit("setSigma", TO, DATA)).rejects.toBeInstanceOf(FeeCapExceeded);
    const r = await tm.submit("haltQuoting", TO, DATA, { critical: true });
    expect(r.status).toBe("success");
    chain.baseFee = 1000n * GWEI; // even a halt has a limit (3 x 300 gwei)
    await expect(tm.submit("haltQuoting", TO, DATA, { critical: true })).rejects.toBeInstanceOf(
      FeeCapExceeded,
    );
  });

  it("uses a given gas limit without estimating", async () => {
    const chain = new FakeChain();
    chain.failEstimate = true; // would fail if it estimated
    const tm = make(chain);
    const r = await tm.submit("haltQuoting", TO, DATA, { gas: 60_000n, critical: true });
    expect(r.gasLimit).toBe(60_000n);
  });

  it("a cancellation that mines frees the stuck nonce", async () => {
    const chain = new FakeChain();
    chain.behaviour = (req) => (req.gas === 21_000n ? 0 : Number.POSITIVE_INFINITY);
    const tm = make(chain);
    await expect(tm.submit("executeOrder", TO, DATA)).rejects.toBeInstanceOf(TxTimeout);
    expect(tm.nonces.pendingCount).toBe(0);
    chain.behaviour = () => 0;
    expect((await tm.submit("next", TO, DATA)).nonce).toBe(1);
  });

  it("a halt replaces a stuck transaction instead of queueing behind it", async () => {
    const chain = new FakeChain();
    // the executeOrder never mines; everything else mines at once
    chain.behaviour = (req) =>
      req.to === TO && req.data === DATA && req.gas !== 100_000n ? Number.POSITIVE_INFINITY : 0;
    const tm = new TxManager(
      chain,
      { ...cfg, maxReplacements: 5 },
      {
        now: () => chain.nowMs,
        sleep: async (ms) => {
          chain.nowMs += ms;
          await new Promise((r) => setImmediate(r)); // let the other call run
        },
      },
    );
    const stuck = tm.submit("executeOrder", TO, DATA);
    const settled = stuck.then(
      () => "mined",
      (e: unknown) => (e as Error).constructor.name,
    );
    await new Promise((r) => setImmediate(r));
    expect(tm.nonces.pendingCount).toBe(1);
    const halt = await tm.submit("haltQuoting", TO, "0x1234", {
      critical: true,
      supersede: true,
      gas: 100_000n,
    });
    expect(halt.status).toBe("success");
    expect(halt.nonce).toBe(0); // the same nonce: it replaced the stuck one
    const hs = chain.sent.find((r) => r.data === "0x1234") as TxRequest;
    const stuckSent = chain.sent.filter((r) => r.data === DATA);
    const maxStuck = stuckSent.reduce((a, r) => (r.maxFeePerGas > a ? r.maxFeePerGas : a), 0n);
    expect(hs.maxFeePerGas > maxStuck).toBe(true); // outbids whatever was sent there
    expect(await settled).toBe("TxSuperseded");
    expect(tm.nonces.pendingCount).toBe(0);
  });

  it("a halt with nothing in flight takes the next nonce as usual", async () => {
    const chain = new FakeChain();
    chain.chainNonce = 9;
    const tm = make(chain);
    const r = await tm.submit("haltQuoting", TO, DATA, { critical: true, gas: 100_000n });
    expect(r.nonce).toBe(9);
  });

  it("an unhalt is critical (fee) but never replaces a transaction in flight", async () => {
    const chain = new FakeChain();
    chain.behaviour = (req) => (req.data === DATA ? Number.POSITIVE_INFINITY : 0);
    const tm = new TxManager(
      chain,
      { ...cfg, maxReplacements: 5 },
      {
        now: () => chain.nowMs,
        sleep: async (ms) => {
          chain.nowMs += ms;
          await new Promise((r) => setImmediate(r));
        },
      },
    );
    void tm.submit("executeOrder", TO, DATA).catch(() => undefined);
    await new Promise((r) => setImmediate(r));
    const r = await tm.submit("unhaltQuoting", TO, "0x5678", { critical: true, gas: 100_000n });
    expect(r.nonce).toBe(1); // behind the executeOrder, not on top of it
  });

  it("a halt whose target nonce mined meanwhile takes the next one instead of failing", async () => {
    const chain = new FakeChain();
    chain.behaviour = (req) => (req.data === DATA ? Number.POSITIVE_INFINITY : 0);
    const tm = new TxManager(
      chain,
      { ...cfg, maxReplacements: 5 },
      {
        now: () => chain.nowMs,
        sleep: async (ms) => {
          chain.nowMs += ms;
          await new Promise((r) => setImmediate(r));
        },
      },
    );
    void tm.submit("executeOrder", TO, DATA).catch(() => undefined);
    await new Promise((r) => setImmediate(r));
    // the stuck one gets mined by someone else just before our replacement is accepted
    chain.failSend = (req, n) => {
      if (req.data === "0x1234" && req.nonce === 0 && n < 100) {
        chain.confirmed = 1;
        return new Error("nonce too low");
      }
      return null;
    };
    const halt = await tm.submit("haltQuoting", TO, "0x1234", {
      critical: true,
      supersede: true,
      gas: 100_000n,
    });
    expect(halt.nonce).toBe(1);
  });
});
