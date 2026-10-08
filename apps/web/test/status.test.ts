import { describe, expect, it } from "vitest";
import {
  CREATE_GRACE_SEC,
  EPOCH_GRACE_SEC,
  INDEXER_LAG_BLOCKS,
  RESOLVE_GRACE_SEC,
  computeStatus,
  type StatusInput,
} from "../src/lib/status";

const NOW = 1_800_000_000;
const slot = (over: Partial<StatusInput["rounds"][number]> = {}) => ({
  label: "BTC",
  duration: 900,
  currentStart: NOW - 400,
  currentState: 1,
  previousState: 2,
  ...over,
});
const healthy = (over: Partial<StatusInput> = {}): StatusInput => ({
  now: NOW,
  headTimestamp: NOW - 1,
  vault: { quotingPaused: false, quotingHalted: false, epochEnd: NOW + 300 },
  rounds: [slot(), slot({ label: "ETH" })],
  indexerLagBlocks: 2,
  ...over,
});

describe("public status line", () => {
  it("is ok when the chain is live, quoting, rounds are open and settled and the vault window is on time", () => {
    const s = computeStatus(healthy());
    expect(s.level).toBe("ok");
    expect(s.checks.every((c) => c.ok)).toBe(true);
    expect(s.updatedAt).toBe(NOW);
  });

  it("is down when the chain head is unreadable or stale, and says money is safe", () => {
    expect(computeStatus(healthy({ headTimestamp: null })).level).toBe("down");
    const stale = computeStatus(healthy({ headTimestamp: NOW - 31 }));
    expect(stale.level).toBe("down");
    expect(stale.headline).toMatch(/safe/);
  });

  it("is down when the vault cannot be read", () => {
    expect(computeStatus(healthy({ vault: null })).level).toBe("down");
  });

  it("is paused (and says exits stay open) when the team paused quoting", () => {
    const s = computeStatus(
      healthy({ vault: { quotingPaused: true, quotingHalted: false, epochEnd: NOW + 1 } }),
    );
    expect(s.level).toBe("paused");
    expect(s.headline).toMatch(/withdraw/);
  });

  it("is degraded when the keeper pulled quotes", () => {
    const s = computeStatus(
      healthy({ vault: { quotingPaused: false, quotingHalted: true, epochEnd: NOW + 1 } }),
    );
    expect(s.level).toBe("degraded");
    expect(s.headline).toMatch(/pulled/);
  });

  it("tolerates a round that is only just due, flags one that is late, and never hides a missing round", () => {
    const fresh = slot({ currentStart: NOW - CREATE_GRACE_SEC, currentState: null });
    expect(computeStatus(healthy({ rounds: [fresh] })).level).toBe("ok");
    const late = slot({ currentStart: NOW - CREATE_GRACE_SEC - 1, currentState: null });
    const s = computeStatus(healthy({ rounds: [late] }));
    expect(s.level).toBe("degraded");
    expect(s.headline).toMatch(/BTC 15 min round is late/);
    const created = slot({ currentStart: NOW - 200, currentState: 0 }); // created but never opened
    expect(computeStatus(healthy({ rounds: [created] })).level).toBe("degraded");
  });

  it("flags a previous round that stays unresolved past the grace period", () => {
    const ok = slot({ currentStart: NOW - RESOLVE_GRACE_SEC, previousState: 1 });
    expect(computeStatus(healthy({ rounds: [ok] })).level).toBe("ok");
    const bad = slot({ currentStart: NOW - RESOLVE_GRACE_SEC - 1, previousState: 1 });
    const s = computeStatus(healthy({ rounds: [bad] }));
    expect(s.level).toBe("degraded");
    expect(s.headline).toMatch(/settlement is late/);
    // INVALID (4) counts as settled: the holders can redeem
    expect(computeStatus(healthy({ rounds: [slot({ previousState: 4 })] })).level).toBe("ok");
  });

  it("flags an overdue vault window", () => {
    const vault = {
      quotingPaused: false,
      quotingHalted: false,
      epochEnd: NOW - EPOCH_GRACE_SEC - 1,
    };
    expect(computeStatus(healthy({ vault })).level).toBe("degraded");
    expect(
      computeStatus(healthy({ vault: { ...vault, epochEnd: NOW - EPOCH_GRACE_SEC } })).level,
    ).toBe("ok");
  });

  it("only checks the indexer when one is configured, and treats silence as lag", () => {
    expect(
      computeStatus(healthy({ indexerLagBlocks: undefined })).checks.some(
        (c) => c.id === "indexer",
      ),
    ).toBe(false);
    expect(computeStatus(healthy({ indexerLagBlocks: INDEXER_LAG_BLOCKS })).level).toBe("ok");
    expect(computeStatus(healthy({ indexerLagBlocks: INDEXER_LAG_BLOCKS + 1 })).level).toBe(
      "degraded",
    );
    expect(computeStatus(healthy({ indexerLagBlocks: null })).level).toBe("degraded");
  });

  it("lists every problem, not only the first, and always reminds that exits are open", () => {
    const s = computeStatus(
      healthy({
        rounds: [
          slot({ currentStart: NOW - 500, currentState: null }),
          slot({ label: "ETH", currentStart: NOW - 500, currentState: null }),
        ],
        indexerLagBlocks: null,
      }),
    );
    expect(s.level).toBe("degraded");
    expect(s.headline).toMatch(/BTC/);
    expect(s.headline).toMatch(/ETH/);
    expect(s.headline).toMatch(/history/);
    expect(s.headline).toMatch(/exit at any time/);
  });
});
