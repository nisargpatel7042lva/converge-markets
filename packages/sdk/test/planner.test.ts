import { describe, expect, it } from "vitest";
import { zeroAddress, type Address, type Hex } from "viem";
import { ActionKind, lateItems, lateWaiting, plan } from "../src/planner";
import { BoundaryStatus, MarketState, type SlotState, type Snapshot } from "../src/snapshot";

const A = "0x0000000000000000000000000000000000000001" as Hex;
const M = "0x00000000000000000000000000000000000000aa" as Address;

function slot(p: Partial<SlotState>): SlotState {
  return {
    assetId: A,
    label: "BTC/USD",
    resolverKind: "round",
    resolver: zeroAddress,
    duration: 900n,
    startTime: 9_000n,
    endTime: 9_900n,
    market: null,
    state: null,
    boundary: null,
    boundaryStatus: null,
    proposalPending: false,
    ...p,
  };
}

describe("planner", () => {
  it("creates missing future markets and reports missing past ones as missed", () => {
    const p = plan({
      now: 8_000n,
      slots: [slot({ startTime: 9_000n }), slot({ startTime: 7_200n })],
    });
    expect(p.actions.map((a) => a.kind)).toEqual([ActionKind.CREATE]);
    expect(p.missed.map((s) => s.startTime)).toEqual([7_200n]);
  });

  it("opens/resolves with evidence while PENDING, without evidence once FINAL", () => {
    const base = { market: M, boundary: 9_000n };
    const snap: Snapshot = {
      now: 9_010n,
      slots: [
        slot({ ...base, state: MarketState.CREATED, boundaryStatus: BoundaryStatus.PENDING }),
        slot({ ...base, state: MarketState.CREATED, boundaryStatus: BoundaryStatus.FINAL }),
        slot({
          ...base,
          state: MarketState.OPEN,
          boundary: 9_900n,
          boundaryStatus: BoundaryStatus.PENDING,
        }),
      ],
    };
    const p = plan(snap);
    expect(p.actions.map((a) => [a.kind, a.needsEvidence])).toEqual([
      [ActionKind.OPEN, true],
      [ActionKind.OPEN, false],
      [ActionKind.RESOLVE, true],
    ]);
  });

  it("invalidates UNRESOLVABLE boundaries and waits while a streams proposal finalizes", () => {
    const p = plan({
      now: 10_000n,
      slots: [
        slot({
          market: M,
          state: MarketState.OPEN,
          boundary: 9_900n,
          boundaryStatus: BoundaryStatus.UNRESOLVABLE,
        }),
        slot({
          resolverKind: "streams",
          market: M,
          state: MarketState.OPEN,
          boundary: 9_900n,
          boundaryStatus: BoundaryStatus.PENDING,
          proposalPending: true,
        }),
      ],
    });
    expect(p.actions.map((a) => a.kind)).toEqual([ActionKind.INVALIDATE]);
    expect(p.waiting).toHaveLength(1);
    expect(lateWaiting(p, 10_000n, 60n)).toHaveLength(1);
  });

  it("is idempotent: settled markets and not-yet-due boundaries produce no actions", () => {
    const p = plan({
      now: 9_100n,
      slots: [
        slot({ market: M, state: MarketState.RESOLVED_UP }),
        slot({ market: M, state: MarketState.INVALID }),
        slot({ market: M, state: MarketState.OPEN }), // end not reached -> boundary null
      ],
    });
    expect(p.actions).toEqual([]);
    // Re-planning the same snapshot yields the same plan.
    const snap: Snapshot = {
      now: 9_010n,
      slots: [
        slot({
          market: M,
          state: MarketState.CREATED,
          boundary: 9_000n,
          boundaryStatus: BoundaryStatus.PENDING,
        }),
      ],
    };
    expect(plan(snap)).toEqual(plan(snap));
  });

  it("flags late actions", () => {
    const p = plan({
      now: 9_070n,
      slots: [
        slot({
          market: M,
          state: MarketState.CREATED,
          boundary: 9_000n,
          boundaryStatus: BoundaryStatus.PENDING,
        }),
        slot({ startTime: 9_900n }), // create: less than one round before start
        slot({ startTime: 11_700n }), // create: plenty of time
      ],
    });
    expect(lateItems(p, 9_070n, 60n).map((a) => a.kind)).toEqual([
      ActionKind.OPEN,
      ActionKind.CREATE,
    ]);
    expect(lateItems(p, 9_050n, 60n).map((a) => a.kind)).toEqual([ActionKind.CREATE]);
  });
});
