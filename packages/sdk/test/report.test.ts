import { describe, expect, it } from "vitest";
import { decodeAbiParameters, keccak256, stringToHex } from "viem";
import { ActionKind } from "../src/planner";
import { encodeSchedulerReport, SCHEDULER_REPORT_PARAMS } from "../src/report";

describe("SchedulerReceiver report encoding", () => {
  it("round-trips through the receiver's ABI layout", () => {
    const assetId = keccak256(stringToHex("BTC/USD"));
    const hex = encodeSchedulerReport(10143n, 1_790_864_100n, [
      {
        kind: ActionKind.CREATE,
        assetId,
        duration: 900n,
        startTime: 1_790_865_000n,
        evidence: "0x",
      },
      {
        kind: ActionKind.RESOLVE,
        assetId,
        duration: 3600n,
        startTime: 1_790_863_200n,
        evidence: "0x1234",
      },
    ]);
    const [chainId, scheduled, actions] = decodeAbiParameters(SCHEDULER_REPORT_PARAMS, hex);
    expect(chainId).toBe(10143n);
    expect(scheduled).toBe(1_790_864_100n);
    expect(actions).toHaveLength(2);
    expect(actions[1]).toEqual({
      kind: 2,
      assetId,
      duration: 3600n,
      startTime: 1_790_863_200n,
      evidence: "0x1234",
    });
  });
});
