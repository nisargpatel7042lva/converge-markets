/** Round-proof evidence for ChainlinkRoundResolver (fetch-free: usable inside CRE workflows). */
import type { Address, Hex } from "viem";
import { chainlinkRoundResolverAbi } from "./abi/generated";
import { value, type Reader } from "./calls";
import { encodeRoundProof, findFirstRoundAtOrAfter, type RoundFinding } from "./rounds";

export type RoundEvidence =
  { evidence: Hex; finding: RoundFinding } | { evidence: null; finding: RoundFinding };

/** Generator: resolver -> feed -> first round at/after `boundary` -> abi-encoded proof. */
export function* roundProofEvidence(
  resolver: Address,
  assetId: Hex,
  boundary: bigint,
): Reader<RoundEvidence> {
  const cfg = value<readonly [Address, number]>(
    yield {
      to: resolver,
      abi: chainlinkRoundResolverAbi,
      functionName: "assetConfig",
      args: [assetId],
    },
  );
  const finding = yield* findFirstRoundAtOrAfter(cfg[0], boundary);
  if (finding.kind !== "found") return { evidence: null, finding };
  return { evidence: encodeRoundProof(finding.roundId), finding };
}
