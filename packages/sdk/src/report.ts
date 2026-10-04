/**
 * SchedulerReceiver report encoding (contracts/src/scheduler/SchedulerReceiver.sol):
 * abi.encode(uint256 chainId, uint64 scheduledTime, (uint8 kind, bytes32 assetId, uint64 duration,
 * uint64 startTime, bytes evidence)[] actions).
 */
import { encodeAbiParameters, type Hex } from "viem";
import type { Reader } from "./calls";
import { describe, type ActionKind, type Plan } from "./planner";
import { roundProofEvidence } from "./round-evidence";
import type { Snapshot } from "./snapshot";

export type ReceiverAction = {
  kind: ActionKind;
  assetId: Hex;
  duration: bigint;
  startTime: bigint;
  evidence: Hex;
};

export const SCHEDULER_REPORT_PARAMS = [
  { type: "uint256", name: "chainId" },
  { type: "uint64", name: "scheduledTime" },
  {
    type: "tuple[]",
    name: "actions",
    components: [
      { type: "uint8", name: "kind" },
      { type: "bytes32", name: "assetId" },
      { type: "uint64", name: "duration" },
      { type: "uint64", name: "startTime" },
      { type: "bytes", name: "evidence" },
    ],
  },
] as const;

export function encodeSchedulerReport(
  chainId: bigint,
  scheduledTime: bigint,
  actions: readonly ReceiverAction[],
): Hex {
  return encodeAbiParameters(SCHEDULER_REPORT_PARAMS, [
    chainId,
    scheduledTime,
    actions.map((a) => ({
      kind: a.kind,
      assetId: a.assetId,
      duration: a.duration,
      startTime: a.startTime,
      evidence: a.evidence,
    })),
  ]);
}

/**
 * Plan -> receiver actions with evidence, as a runtime-agnostic Reader (round-proof evidence is
 * read through the yielded calls; Data Streams reports come from the synchronous `streams`
 * callback: the CRE HTTP capability in the workflow, a test signer in tests).
 */
export function* buildReceiverActions(
  p: Plan,
  snapshot: Snapshot,
  maxActions: number,
  streams: (label: string, feedId: Hex | undefined, boundary: bigint) => Hex | null,
  feedIdOf: (label: string) => Hex | undefined,
  log: (msg: string) => void = () => {},
): Reader<ReceiverAction[]> {
  const out: ReceiverAction[] = [];
  for (const a of p.actions) {
    if (out.length >= maxActions) break;
    let evidence: Hex = "0x";
    if (a.needsEvidence && a.boundary !== null) {
      if (a.resolverKind === "round") {
        const slot = snapshot.slots.find(
          (s) =>
            s.assetId === a.assetId && s.startTime === a.startTime && s.duration === a.duration,
        );
        if (!slot) continue;
        const ev = yield* roundProofEvidence(slot.resolver, a.assetId, a.boundary);
        if (ev.evidence === null) {
          log(`waiting ${describe(a)}: ${ev.finding.kind}`);
          continue;
        }
        evidence = ev.evidence;
      } else {
        const report = streams(a.label, feedIdOf(a.label), a.boundary);
        if (report === null) {
          log(`waiting ${describe(a)}: no report`);
          continue;
        }
        evidence = report;
      }
    }
    out.push({
      kind: a.kind,
      assetId: a.assetId,
      duration: a.duration,
      startTime: a.startTime,
      evidence,
    });
  }
  return out;
}
