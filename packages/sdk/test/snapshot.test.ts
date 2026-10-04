import { describe, expect, it } from "vitest";
import { zeroAddress, type Address } from "viem";
import type { Call, CallResult, Reader } from "../src/calls";
import { assetIdOf, parseSeriesConfig } from "../src/config";
import { LENS_ORACLE_ERROR, readSnapshotViaLens } from "../src/lens";
import { plan } from "../src/planner";
import { BoundaryStatus, readSnapshot } from "../src/snapshot";

const config = parseSeriesConfig({
  lookaheadRounds: 1,
  recentLookbackSeconds: 900,
  deepLookbackSeconds: 900,
  lateAfterSeconds: 60,
  durations: [900],
  assets: [{ label: "BTC/USD", symbol: "BTC", resolver: "round" }],
  kuru: { enabled: false, reason: "test" },
});
const BTC = assetIdOf("BTC/USD");
const M = "0x00000000000000000000000000000000000000aa" as Address;
const R = "0x00000000000000000000000000000000000000bb" as Address;

/** Drives a reader with a fake executor keyed by function name. */
function drive<T>(r: Reader<T>, answer: (c: Call) => CallResult): T {
  let step = r.next(undefined as unknown as CallResult);
  while (!step.done) step = r.next(answer(step.value));
  return step.value;
}

describe("snapshot readers: oracle isolation", () => {
  it("lens: maps STATUS_ORACLE_ERROR to oracleError (no boundary) and passes truncated", () => {
    const lensSlot = (boundaryStatus: number) => ({
      assetId: BTC,
      duration: 900n,
      startTime: 9_000n,
      market: M,
      state: 0,
      resolver: R,
      boundary: 9_000n,
      boundaryStatus,
      proposalPending: false,
      finding: 0,
      roundId: 0n,
    });
    const snap = drive(readSnapshotViaLens({ lens: R, factory: R, config, now: 9_010n }), () => ({
      ok: true,
      value: [[lensSlot(LENS_ORACLE_ERROR), lensSlot(1)], true],
    }));
    expect(snap.truncated).toBe(true);
    expect(snap.slots[0]).toMatchObject({
      oracleError: true,
      boundary: null,
      boundaryStatus: null,
    });
    expect(snap.slots[1]).toMatchObject({ boundary: 9_000n, boundaryStatus: BoundaryStatus.FINAL });
    expect(snap.slots[1]!.oracleError).toBeUndefined();
    const p = plan(snap);
    expect(p.oracleErrors).toHaveLength(1);
    expect(p.actions).toHaveLength(1);
  });

  it("multi-call: a reverting or out-of-range priceAt flags only that slot", () => {
    for (const priceAt of [{ ok: false } as const, { ok: true, value: [7, 0n] } as const]) {
      const calls: string[] = [];
      const snap = drive(readSnapshot({ factory: R, config, now: 9_010n }), (c) => {
        calls.push(c.functionName);
        switch (c.functionName) {
          case "asset":
            return { ok: true, value: { resolver: R, enabled: true } };
          case "getMarket":
            return { ok: true, value: (c.args?.[2] as bigint) === 9_000n ? M : zeroAddress };
          case "state":
            return { ok: true, value: 0 };
          case "priceAt":
            expect(c.allowRevert).toBe(true);
            return priceAt;
          default:
            throw new Error(`unexpected ${c.functionName}`);
        }
      });
      const s = snap.slots.find((x) => x.startTime === 9_000n)!;
      expect(s).toMatchObject({ oracleError: true, boundary: null, boundaryStatus: null });
      expect(calls).toContain("priceAt");
      expect(plan(snap).oracleErrors).toHaveLength(1);
    }
  });
});
