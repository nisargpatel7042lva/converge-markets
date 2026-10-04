/**
 * SchedulerReceiver report encoding (contracts/src/scheduler/SchedulerReceiver.sol):
 * abi.encode(uint256 chainId, uint64 scheduledTime, (uint8 kind, bytes32 assetId, uint64 duration,
 * uint64 startTime, bytes evidence)[] actions).
 */
import { encodeAbiParameters, type Hex } from "viem";
import type { Reader } from "./calls";
import { ActionKind, describe, type Plan, type PlannedAction } from "./planner";
import { encodeRoundProof } from "./rounds";
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
/** Time-critical first: settlement (RESOLVE, OPEN, INVALIDATE) before creation, soonest first. */
export function prioritize(actions: readonly PlannedAction[]): PlannedAction[] {
  const rank = (k: ActionKind) => (k === ActionKind.CREATE ? 1 : 0);
  return [...actions].sort(
    (x, y) =>
      rank(x.kind) - rank(y.kind) ||
      (x.dueAt < y.dueAt ? -1 : x.dueAt > y.dueAt ? 1 : 0) ||
      (x.startTime < y.startTime ? -1 : x.startTime > y.startTime ? 1 : 0),
  );
}

/**
 * Plan -> receiver actions with evidence, as a runtime-agnostic Reader. Round-proof evidence
 * comes from the lens finding when available (zero extra reads), otherwise from the yielded
 * round-finder calls. Data Streams reports come from the synchronous `streams` callback (the CRE
 * HTTP capability in the workflow, a test signer in tests). Settlement actions go first and at
 * most `maxCreates` creations are included, so a report fits the receiver's gas budget.
 */
export function* buildReceiverActions(
  p: Plan,
  snapshot: Snapshot,
  maxActions: number,
  streams: (label: string, feedId: Hex | undefined, boundary: bigint) => Hex | null,
  feedIdOf: (label: string) => Hex | undefined,
  log: (msg: string) => void = () => {},
  maxCreates = maxActions,
): Reader<ReceiverAction[]> {
  const out: ReceiverAction[] = [];
  let creates = 0;
  for (const a of prioritize(p.actions)) {
    if (out.length >= maxActions) break;
    if (a.kind === ActionKind.CREATE) {
      if (creates >= maxCreates) continue;
      creates += 1;
    }
    let evidence: Hex = "0x";
    if (a.needsEvidence && a.boundary !== null) {
      if (a.resolverKind === "round") {
        const slot = snapshot.slots.find(
          (s) =>
            s.assetId === a.assetId && s.startTime === a.startTime && s.duration === a.duration,
        );
        if (!slot) continue;
        const finding =
          slot.roundFinding ??
          (yield* roundProofEvidence(slot.resolver, a.assetId, a.boundary)).finding;
        if (finding.kind !== "found") {
          log(`waiting ${describe(a)}: ${finding.kind}`);
          continue;
        }
        evidence = encodeRoundProof(finding.roundId);
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
