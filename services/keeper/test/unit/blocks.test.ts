import pino from "pino";
import type { PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { BlockSource, type Head } from "../../src/chain/blocks";

const log = pino({ level: "silent" });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("block source over HTTP polling", () => {
  it("emits each new block once, in order, and survives RPC failures", async () => {
    let n = 100n;
    let fail = false;
    let calls = 0;
    const pub = {
      getBlock: async () => {
        calls += 1;
        if (fail) throw new Error("rpc down");
        return { number: n, timestamp: n * 2n };
      },
    } as unknown as PublicClient;
    const heads: Head[] = [];
    const src = new BlockSource(pub, (h) => heads.push(h), log, { pollMs: 20, stallMs: 1000 });
    src.start();
    await wait(120); // the same block again and again: one emission
    expect(heads.map((h) => h.number)).toEqual([100n]);
    n = 101n;
    await wait(80);
    fail = true;
    await wait(80); // errors are swallowed and retried
    n = 103n; // a skipped number is fine; going backwards is not
    fail = false;
    await wait(80);
    n = 102n;
    await wait(80);
    src.stop();
    expect(heads.map((h) => h.number)).toEqual([100n, 101n, 103n]);
    expect(src.latest?.number).toBe(103n);
    expect(src.mode).toBe("poll");
    expect(calls).toBeGreaterThan(5);
    expect(src.byNumber.get(101n)?.timestamp).toBe(202n);
  });
});
