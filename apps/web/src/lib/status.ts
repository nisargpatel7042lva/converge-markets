/**
 * The public status line: one honest sentence about whether rounds are being created, quoted and
 * settled, built from facts anyone can read from the chain and the open indexer. A pure function,
 * so every state is tested; the route in app/api/status/route.ts only gathers the inputs.
 */
export type StatusLevel = "ok" | "degraded" | "paused" | "down";

export type RoundSlot = {
  label: string;
  /** Seconds. */
  duration: number;
  /** Start of the round that should be running now (on the series' grid). */
  currentStart: number;
  /** Market.State of that round, null when it has not been created. */
  currentState: number | null;
  /** Market.State of the round before it (must be resolved a little after its end), null if none. */
  previousState: number | null;
};

export type StatusInput = {
  now: number;
  /** Timestamp of the latest block; null when the chain could not be read. */
  headTimestamp: number | null;
  vault: {
    quotingPaused: boolean;
    quotingHalted: boolean;
    /** The epoch that ended last: when, whether anyone asked for anything in it, whether it was settled. */
    previousEpoch: { end: number; hadRequests: boolean; settled: boolean } | null;
    /** When the vault was last re-valued (it quotes only if this is under 30 minutes old). */
    navUpdatedAt: number;
    /** When the keeper last set each enabled asset's volatility (0 = never); quotes need under 15 minutes. */
    sigmaUpdatedAt: number[];
  } | null;
  rounds: RoundSlot[];
  /** Rounds among the last few slots that ended long ago and are still not resolved (they block settlement). */
  staleOpenRounds: number;
  /** Blocks the indexer is behind; undefined when no indexer is configured, null when it is silent. */
  indexerLagBlocks: number | null | undefined;
};

export type StatusCheck = { id: string; ok: boolean; detail: string };
export type Status = {
  level: StatusLevel;
  headline: string;
  checks: StatusCheck[];
  updatedAt: number;
};

/** A round may take this long to appear / open after its slot starts (scheduler cadence + inclusion). */
export const CREATE_GRACE_SEC = 45;
/** A resolved round is expected within this long of its end (finalization window + scheduler). */
export const RESOLVE_GRACE_SEC = 180;
export const HEAD_STALE_SEC = 30;
export const EPOCH_SETTLE_GRACE_SEC = 300; // the settlement window is 10 minutes: a keeper normally does it in seconds
export const NAV_MAX_AGE_SEC = 1500; // the vault refuses to quote past 1800
export const SIGMA_MAX_AGE_SEC = 780; // the vault refuses to quote past 900
export const INDEXER_LAG_BLOCKS = 100;

const OPEN = 1;
const SETTLED_STATES = new Set([2, 3, 4]);

export function computeStatus(i: StatusInput): Status {
  const checks: StatusCheck[] = [];
  const done = (level: StatusLevel, headline: string): Status => ({
    level,
    headline,
    checks,
    updatedAt: i.now,
  });

  const headAge = i.headTimestamp === null ? null : i.now - i.headTimestamp;
  const chainOk = headAge !== null && headAge <= HEAD_STALE_SEC;
  checks.push({
    id: "chain",
    ok: chainOk,
    detail: headAge === null ? "chain unreachable" : `latest block ${Math.max(0, headAge)}s old`,
  });
  if (!chainOk)
    return done(
      "down",
      "We can't reach the network right now. Your money is safe; try again soon.",
    );

  if (!i.vault) {
    checks.push({ id: "vault", ok: false, detail: "vault unreadable" });
    return done("down", "We can't read the vault right now. Your money is safe; try again soon.");
  }
  if (i.vault.quotingPaused) {
    checks.push({ id: "quoting", ok: false, detail: "quoting paused by the team" });
    return done(
      "paused",
      "New bets are paused. You can still collect winnings and withdraw at any time.",
    );
  }
  checks.push({
    id: "quoting",
    ok: !i.vault.quotingHalted,
    detail: i.vault.quotingHalted ? "quotes pulled" : "quoting",
  });

  if (i.rounds.length === 0) {
    checks.push({ id: "rounds", ok: false, detail: "no rounds configured or readable" });
    return done("down", "We can't read the rounds right now. Your money is safe; try again soon.");
  }
  const problems: string[] = [];
  if (i.vault.quotingHalted) problems.push("prices are temporarily pulled");

  for (const r of i.rounds) {
    const sinceStart = i.now - r.currentStart;
    const slotOk = sinceStart <= CREATE_GRACE_SEC || r.currentState === OPEN;
    checks.push({
      id: `round:${r.label}:${r.duration}`,
      ok: slotOk,
      detail:
        r.currentState === null ? "not created yet" : r.currentState === OPEN ? "open" : "created",
    });
    if (!slotOk) problems.push(`${r.label} ${r.duration / 60} min round is late`);

    const prevEnd = r.currentStart; // the previous round ends where the current one starts
    const resolveOk =
      r.previousState === null ||
      SETTLED_STATES.has(r.previousState) ||
      i.now - prevEnd <= RESOLVE_GRACE_SEC;
    checks.push({
      id: `resolve:${r.label}:${r.duration}`,
      ok: resolveOk,
      detail: resolveOk ? "previous round settled" : "previous round not settled yet",
    });
    if (!resolveOk) problems.push(`${r.label} ${r.duration / 60} min settlement is late`);
  }

  const pe = i.vault.previousEpoch;
  const epochOk = !pe || !pe.hadRequests || pe.settled || i.now <= pe.end + EPOCH_SETTLE_GRACE_SEC;
  checks.push({
    id: "epoch",
    ok: epochOk,
    detail: epochOk
      ? "vault window on time"
      : `the last vault window ended ${i.now - pe!.end}s ago and is not settled`,
  });
  if (!epochOk) problems.push("vault deposits and withdrawals are being processed late");

  const navAge = i.now - i.vault.navUpdatedAt;
  const navOk = navAge <= NAV_MAX_AGE_SEC;
  checks.push({ id: "valuation", ok: navOk, detail: `vault valued ${Math.max(0, navAge)}s ago` });
  if (!navOk) problems.push("the vault's valuation is stale, so it may stop quoting");

  const sigmaOk =
    i.vault.sigmaUpdatedAt.length > 0 &&
    i.vault.sigmaUpdatedAt.every((t) => t > 0 && i.now - t <= SIGMA_MAX_AGE_SEC);
  checks.push({
    id: "volatility",
    ok: sigmaOk,
    detail: sigmaOk ? "volatility inputs fresh" : "volatility inputs missing or stale",
  });
  if (!sigmaOk) problems.push("prices are not being refreshed, so quoting may be off");

  checks.push({
    id: "unresolved",
    ok: i.staleOpenRounds === 0,
    detail: `${i.staleOpenRounds} old round(s) not yet resolved`,
  });
  if (i.staleOpenRounds > 0) problems.push("an earlier round is not resolved yet");

  if (i.indexerLagBlocks !== undefined) {
    const ok = i.indexerLagBlocks !== null && i.indexerLagBlocks <= INDEXER_LAG_BLOCKS;
    checks.push({
      id: "indexer",
      ok,
      detail: i.indexerLagBlocks === null ? "no answer" : `${i.indexerLagBlocks} blocks behind`,
    });
    if (!ok) problems.push("history and charts are behind");
  }

  if (problems.length === 0)
    return done("ok", "All systems working: rounds are opening, quoting and settling on time.");
  const text = problems.join("; ");
  return done(
    "degraded",
    `${text.charAt(0).toUpperCase()}${text.slice(1)}. You can still exit at any time.`,
  );
}
