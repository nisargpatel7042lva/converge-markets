/**
 * Finds the evidence ChainlinkRoundResolver accepts: the FIRST round of the proxy's CURRENT phase
 * with updatedAt >= T, whose same-phase predecessor has updatedAt < T
 * (contracts/src/resolvers/ChainlinkRoundResolver.sol, ADR-002).
 *
 * Proxy round ids encode (phaseId << 64) | aggregatorRoundId. Within a phase, aggregator round
 * ids are contiguous and updatedAt is non-decreasing, so a binary search over
 * [1, latestAggregatorRound] is valid. Missing rounds (proxy reverts) are treated as a broken
 * feed and reported, never skipped.
 */
import { encodeAbiParameters, type Address, type Hex } from "viem";
import { aggregatorV3Abi } from "./abi/generated";
import type { Reader } from "./calls";

const PHASE_SHIFT = 64n;
const AGG_MASK = (1n << 64n) - 1n;

export function phaseOf(roundId: bigint): bigint {
  return roundId >> PHASE_SHIFT;
}

export function aggRoundOf(roundId: bigint): bigint {
  return roundId & AGG_MASK;
}

export function makeRoundId(phase: bigint, aggRound: bigint): bigint {
  return (phase << PHASE_SHIFT) | aggRound;
}

export type RoundFinding =
  | { kind: "found"; roundId: bigint; updatedAt: bigint; answer: bigint }
  /** No round at or after T yet in the current phase (wait). */
  | { kind: "not-yet"; latestUpdatedAt: bigint }
  /** First qualifying round is round 1 of the current phase: no provable predecessor. */
  | { kind: "first-of-phase"; roundId: bigint }
  /** A round inside the current phase is missing (proxy reverted): feed is broken. */
  | { kind: "missing-round"; roundId: bigint };

type RoundData = readonly [bigint, bigint, bigint, bigint, bigint];

function* roundAt(feed: Address, roundId: bigint): Reader<RoundData | undefined> {
  const r = yield {
    to: feed,
    abi: aggregatorV3Abi,
    functionName: "getRoundData",
    args: [roundId],
    allowRevert: true,
  };
  if (!r.ok) return undefined;
  const data = r.value as RoundData;
  return data[3] === 0n ? undefined : data;
}

/** Generator: first round of the current phase with updatedAt >= t. */
export function* findFirstRoundAtOrAfter(feed: Address, t: bigint): Reader<RoundFinding> {
  const latestRes = yield { to: feed, abi: aggregatorV3Abi, functionName: "latestRoundData" };
  if (!latestRes.ok) throw new Error("latestRoundData reverted");
  const latest = latestRes.value as RoundData;
  const latestId = latest[0];
  const latestUpdatedAt = latest[3];
  if (latestUpdatedAt < t) return { kind: "not-yet", latestUpdatedAt };

  const phase = phaseOf(latestId);
  let lo = 1n;
  let hi = aggRoundOf(latestId); // invariant: round `hi` has updatedAt >= t
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const id = makeRoundId(phase, mid);
    const r = yield* roundAt(feed, id);
    if (r === undefined) return { kind: "missing-round", roundId: id };
    if (r[3] >= t) hi = mid;
    else lo = mid + 1n;
  }
  const firstId = makeRoundId(phase, hi);
  const first = yield* roundAt(feed, firstId);
  if (first === undefined) return { kind: "missing-round", roundId: firstId };
  if (hi === 1n) return { kind: "first-of-phase", roundId: firstId };
  return { kind: "found", roundId: firstId, updatedAt: first[3], answer: first[1] };
}

/** Resolver evidence for ChainlinkRoundResolver: abi.encode(uint80 roundId). */
export function encodeRoundProof(roundId: bigint): Hex {
  return encodeAbiParameters([{ type: "uint80" }], [roundId]);
}
