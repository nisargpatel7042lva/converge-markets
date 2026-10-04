/**
 * Pure planning: snapshot -> idempotent actions. Shared by the CRE workflow and the TS fallback.
 *
 * Every action is safe to repeat: creating an existing market reverts with MarketExists (skipped
 * by SchedulerReceiver / treated as success by the fallback), and open/resolve/invalidate are
 * no-ops or reverts once the market has moved on. The planner never chooses prices: open/resolve
 * carry only evidence that the market's resolver verifies onchain.
 */
import type { Hex } from "viem";
import { BoundaryStatus, MarketState, type SlotState, type Snapshot } from "./snapshot";

export enum ActionKind {
  CREATE = 0,
  OPEN = 1,
  RESOLVE = 2,
  INVALIDATE = 3,
}

export type PlannedAction = {
  kind: ActionKind;
  assetId: Hex;
  label: string;
  resolverKind: "streams" | "round";
  duration: bigint;
  startTime: bigint;
  /** Boundary whose price the action needs (start for OPEN, end for RESOLVE). */
  boundary: bigint | null;
  /** Evidence (round proof / signed report) must be fetched and attached. */
  needsEvidence: boolean;
  /** When the action became due (unix seconds). */
  dueAt: bigint;
};

export type Waiting = {
  slot: SlotState;
  reason: "streams-finalizing" | "round-pending";
  dueAt: bigint;
};

export type Plan = {
  actions: PlannedAction[];
  waiting: Waiting[];
  /** Rounds that already started without a market (a missed create: can no longer be fixed). */
  missed: SlotState[];
};

export function plan(snapshot: Snapshot): Plan {
  const { now, slots } = snapshot;
  const actions: PlannedAction[] = [];
  const waiting: Waiting[] = [];
  const missed: SlotState[] = [];
  for (const s of slots) {
    const base = {
      assetId: s.assetId,
      label: s.label,
      resolverKind: s.resolverKind,
      duration: s.duration,
      startTime: s.startTime,
    };
    if (s.market === null) {
      // Only future rounds can be created (the factory rejects past starts).
      if (s.startTime >= now) {
        actions.push({
          ...base,
          kind: ActionKind.CREATE,
          boundary: null,
          needsEvidence: false,
          dueAt: now, // due as soon as the round enters the lookahead window
        });
      } else {
        missed.push(s);
      }
      continue;
    }
    if (s.boundary === null || s.boundaryStatus === null) continue; // settled or not yet due
    const kind = s.state === MarketState.CREATED ? ActionKind.OPEN : ActionKind.RESOLVE;
    if (s.boundaryStatus === BoundaryStatus.UNRESOLVABLE) {
      actions.push({
        ...base,
        kind: ActionKind.INVALIDATE,
        boundary: s.boundary,
        needsEvidence: false,
        dueAt: s.boundary,
      });
    } else if (s.boundaryStatus === BoundaryStatus.FINAL) {
      actions.push({
        ...base,
        kind,
        boundary: s.boundary,
        needsEvidence: false,
        dueAt: s.boundary,
      });
    } else if (s.resolverKind === "streams" && s.proposalPending) {
      waiting.push({ slot: s, reason: "streams-finalizing", dueAt: s.boundary });
    } else {
      actions.push({ ...base, kind, boundary: s.boundary, needsEvidence: true, dueAt: s.boundary });
    }
  }
  return { actions, waiting, missed };
}

/** Late = an open/resolve/invalidate still outstanding `lateAfter` seconds after it was due, or
 *  a market not yet created less than one round before it starts. (Rounds that started without a
 *  market are reported separately as `missed`.) */
export function lateItems(p: Plan, now: bigint, lateAfter: bigint): PlannedAction[] {
  return p.actions.filter((a) =>
    a.kind === ActionKind.CREATE ? now > a.startTime - a.duration : now - a.dueAt > lateAfter,
  );
}

/** Streams boundaries whose finalization window is still running long after the boundary. */
export function lateWaiting(p: Plan, now: bigint, lateAfter: bigint): Waiting[] {
  return p.waiting.filter((w) => now - w.dueAt > lateAfter);
}

export function describe(a: PlannedAction): string {
  return `${ActionKind[a.kind]} ${a.label} ${a.duration}s @${a.startTime}`;
}

/** Narrowing helper for MarketState in logs. */
export function stateName(s: MarketState | null): string {
  return s === null ? "MISSING" : MarketState[s];
}
