/**
 * Snapshot through SchedulerLens: ONE eth_call returns every actionable slot, including the
 * round-proof search for round-resolver boundaries. Required for Chainlink CRE (15 EVM reads per
 * execution, docs.chain.link/cre/service-quotas); also used by the fallback so both runtimes see
 * identical data. The multi-call `readSnapshot` remains as an independent cross-check in tests.
 */
import { zeroAddress, type Address, type Hex } from "viem";
import { schedulerLensAbi } from "./abi/generated";
import { value, type Reader } from "./calls";
import { assetIdOf, type SeriesConfig } from "./config";
import type { RoundFinding } from "./rounds";
import { BoundaryStatus, MarketState, type SlotState, type Snapshot } from "./snapshot";

export type LensOptions = {
  lens: Address;
  factory: Address;
  config: SeriesConfig;
  now: bigint;
  /** Unsettled markets are scanned back this far (use the deep lookback: the lens omits settled slots). */
  lookbackSeconds?: number;
  epoch?: bigint;
};

type LensSlot = {
  assetId: Hex;
  duration: bigint;
  startTime: bigint;
  market: Address;
  state: number;
  resolver: Address;
  boundary: bigint;
  boundaryStatus: number;
  proposalPending: boolean;
  finding: number;
  roundId: bigint;
};

const FINDING = ["none", "found", "not-yet", "first-of-phase", "missing-round"] as const;

export function durationsOf(config: SeriesConfig, label: string): number[] {
  return config.assets.find((a) => a.label === label)?.durations ?? config.durations;
}

export function* readSnapshotViaLens(o: LensOptions): Reader<Snapshot> {
  const assets = o.config.assets.map((a) => ({
    assetId: assetIdOf(a.label),
    kind: a.resolver === "streams" ? 0 : 1,
    durations: durationsOf(o.config, a.label).map(BigInt),
  }));
  const slots = value<readonly LensSlot[]>(
    yield {
      to: o.lens,
      abi: schedulerLensAbi,
      functionName: "snapshot",
      args: [
        {
          factory: o.factory,
          assets,
          now_: o.now,
          lookahead: o.config.lookaheadRounds,
          lookback: BigInt(o.lookbackSeconds ?? o.config.deepLookbackSeconds),
          epoch: o.epoch ?? 0n,
        },
      ],
    },
  );
  const byId = new Map(o.config.assets.map((a) => [assetIdOf(a.label), a]));
  return {
    now: o.now,
    slots: slots.map((s): SlotState => {
      const a = byId.get(s.assetId)!;
      const missing = s.market === zeroAddress;
      const due = s.boundary !== 0n;
      const slot: SlotState = {
        assetId: s.assetId,
        label: a.label,
        resolverKind: a.resolver,
        resolver: s.resolver,
        duration: s.duration,
        startTime: s.startTime,
        endTime: s.startTime + s.duration,
        market: missing ? null : s.market,
        state: missing ? null : (s.state as MarketState),
        boundary: due ? s.boundary : null,
        boundaryStatus: due ? (s.boundaryStatus as BoundaryStatus) : null,
        proposalPending: s.proposalPending,
      };
      if (a.resolver === "round" && due && s.boundaryStatus === BoundaryStatus.PENDING) {
        slot.roundFinding = lensFinding(s.finding, s.roundId, s.boundary);
      }
      return slot;
    }),
  };
}

function lensFinding(code: number, roundId: bigint, boundary: bigint): RoundFinding {
  switch (FINDING[code]) {
    case "found":
      return { kind: "found", roundId, updatedAt: boundary, answer: 0n }; // updatedAt/answer not returned by the lens
    case "first-of-phase":
      return { kind: "first-of-phase", roundId };
    case "missing-round":
      return { kind: "missing-round", roundId };
    default:
      return { kind: "not-yet", latestUpdatedAt: 0n };
  }
}
