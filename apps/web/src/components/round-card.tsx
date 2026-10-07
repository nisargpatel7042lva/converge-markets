"use client";
import Link from "next/link";
import { roundPhase } from "@converge/sdk";
import { askFromLadder, impliedUp } from "@converge/sdk";
import { clock, pct, price } from "@/lib/format";
import { usePrice } from "@/lib/prices";
import { useLadder, useNow } from "@/lib/queries";
import type { Round } from "@/lib/data";
import { Sparkline } from "./charts";
import { Pill } from "./ui";

export function phaseOf(r: Round, now: number) {
  return roundPhase({ state: r.state, start: r.start, end: r.end, now });
}

export function RoundCard({ round }: { round: Round }) {
  const now = useNow();
  const px = usePrice(round.series);
  const phase = phaseOf(round, now);
  const strike = round.strike > 0n ? Number(round.strike) / 1e18 : null;
  const ladder = useLadder(round, phase.phase === "LIVE" ? px.price : null);
  const prob = ladder.data?.quoting ? impliedUp(ladder.data) : null;
  void askFromLadder;
  return (
    <Link
      href={`/market/${round.address}`}
      className="block rounded-2xl border border-line bg-surface p-4 transition-colors hover:bg-raised"
      data-testid="round-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold">
            {round.series.name} · next {round.duration / 60} min
          </p>
          <p className="tabular mt-0.5 text-sm text-muted">
            {phase.phase === "LIVE" ? `Ends in ${clock(phase.endsIn)}` : null}
            {phase.phase === "UPCOMING" ? `Starts in ${clock(phase.startsIn)}` : null}
            {phase.phase === "RESOLVING" ? "Settling…" : null}
            {phase.phase === "SETTLED"
              ? `Result: ${phase.outcome === "INVALID" ? "cancelled" : phase.outcome}`
              : null}
          </p>
        </div>
        {phase.phase === "LIVE" ? (
          phase.closing ? (
            <Pill tone="warn">Closing</Pill>
          ) : (
            <Pill tone="up">Live</Pill>
          )
        ) : phase.phase === "UPCOMING" ? (
          <Pill>Soon</Pill>
        ) : phase.phase === "SETTLED" ? (
          <Pill
            tone={phase.outcome === "UP" ? "up" : phase.outcome === "DOWN" ? "down" : "neutral"}
          >
            {phase.outcome === "INVALID"
              ? "Cancelled"
              : phase.outcome === "UP"
                ? "Up won"
                : "Down won"}
          </Pill>
        ) : (
          <Pill tone="warn">Settling</Pill>
        )}
      </div>
      {phase.phase === "LIVE" ? (
        <div className="mt-3 flex items-end justify-between gap-3">
          <div>
            <p className="tabular text-xl font-semibold">
              {px.price ? `$${price(px.price)}` : "…"}
            </p>
            <p className="tabular text-xs text-faint">
              {strike ? `started at $${price(strike)}` : ""}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Sparkline points={px.history.slice(-60)} strike={strike} />
            <p className="tabular text-xs text-muted">
              {prob !== null ? `Up ${pct(prob)} · Down ${pct(1 - prob)}` : "Odds updating…"}
            </p>
          </div>
        </div>
      ) : null}
    </Link>
  );
}
