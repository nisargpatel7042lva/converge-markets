/**
 * Reads the onchain state the planner needs, as a runtime-agnostic generator (see calls.ts).
 */
import { zeroAddress, type Address, type Hex } from "viem";
import { dataStreamsResolverAbi, marketAbi, marketFactoryAbi } from "./abi/generated";
import { value, type Reader } from "./calls";
import { assetIdOf, type SeriesConfig } from "./config";
import type { RoundFinding } from "./rounds";
import { recentStarts, upcomingStarts } from "./time";

export enum MarketState {
  CREATED = 0,
  OPEN = 1,
  RESOLVED_UP = 2,
  RESOLVED_DOWN = 3,
  INVALID = 4,
}

export enum BoundaryStatus {
  PENDING = 0,
  FINAL = 1,
  UNRESOLVABLE = 2,
}

export type SlotState = {
  assetId: Hex;
  label: string;
  resolverKind: "streams" | "round";
  resolver: Address;
  duration: bigint;
  startTime: bigint;
  endTime: bigint;
  market: Address | null;
  state: MarketState | null;
  /** Boundary the market waits on (start if CREATED, end if OPEN) once it has passed. */
  boundary: bigint | null;
  boundaryStatus: BoundaryStatus | null;
  /** Data Streams only: a proposal for `boundary` already exists (finalization window running). */
  proposalPending: boolean;
  /** Round-proof only, when read through SchedulerLens: the onchain first-round search result. */
  roundFinding?: RoundFinding;
};

export type Snapshot = { now: bigint; slots: SlotState[] };

export type SnapshotOptions = {
  factory: Address;
  config: SeriesConfig;
  now: bigint;
  /** Use the deep lookback window (periodic sweep for long-unsettled markets). */
  deep?: boolean;
  /** Ignore rounds starting before this time (e.g. the scheduler's go-live), so rounds from
   *  before deployment are not reported as missed. */
  epoch?: bigint;
};

export function* readSnapshot(opts: SnapshotOptions): Reader<Snapshot> {
  const { factory, config, now } = opts;
  const lookback = BigInt(opts.deep ? config.deepLookbackSeconds : config.recentLookbackSeconds);
  const slots: SlotState[] = [];
  for (const asset of config.assets) {
    const assetId = assetIdOf(asset.label);
    const info = value<{ resolver: Address; enabled: boolean }>(
      yield { to: factory, abi: marketFactoryAbi, functionName: "asset", args: [assetId] },
    );
    for (const d of asset.durations ?? config.durations) {
      const duration = BigInt(d);
      const starts = [
        ...upcomingStarts(now, duration, config.lookaheadRounds),
        ...recentStarts(now, duration, lookback),
      ];
      for (const startTime of starts) {
        if (opts.epoch !== undefined && startTime < opts.epoch) continue;
        const market = value<Address>(
          yield {
            to: factory,
            abi: marketFactoryAbi,
            functionName: "getMarket",
            args: [assetId, duration, startTime],
          },
        );
        const slot: SlotState = {
          assetId,
          label: asset.label,
          resolverKind: asset.resolver,
          resolver: info.resolver,
          duration,
          startTime,
          endTime: startTime + duration,
          market: market === zeroAddress ? null : market,
          state: null,
          boundary: null,
          boundaryStatus: null,
          proposalPending: false,
        };
        if (slot.market) {
          slot.state = Number(
            value<number>(yield { to: slot.market, abi: marketAbi, functionName: "state" }),
          ) as MarketState;
          const b =
            slot.state === MarketState.CREATED
              ? startTime
              : slot.state === MarketState.OPEN
                ? slot.endTime
                : null;
          if (b !== null && now >= b) {
            slot.boundary = b;
            const [status] = value<readonly [number, bigint]>(
              yield {
                to: info.resolver,
                abi: dataStreamsResolverAbi, // priceAt has the same signature on both resolvers
                functionName: "priceAt",
                args: [assetId, b],
              },
            );
            slot.boundaryStatus = Number(status) as BoundaryStatus;
            if (asset.resolver === "streams" && slot.boundaryStatus === BoundaryStatus.PENDING) {
              const p = value<{ firstProposedAt: bigint }>(
                yield {
                  to: info.resolver,
                  abi: dataStreamsResolverAbi,
                  functionName: "proposal",
                  args: [assetId, b],
                },
              );
              slot.proposalPending = p.firstProposedAt !== 0n;
            }
          }
        }
        slots.push(slot);
      }
    }
  }
  return { now, slots };
}
