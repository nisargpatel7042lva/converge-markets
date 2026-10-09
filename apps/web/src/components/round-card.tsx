"use client";
import Link from "next/link";
import { roundPhase } from "@converge/sdk";
import { clock, price } from "@/lib/format";
import { useLiveMarket } from "@/lib/live";
import { usePrice } from "@/lib/prices";
import { useNow } from "@/lib/queries";
import type { Round } from "@/lib/data";
import { Sparkline } from "./charts";
import { AnimatedNumber, CountdownRing, OddsBar } from "./delight";
import { Pill } from "./ui";

export function phaseOf(r: Round, now: number) {
  return roundPhase({ state: r.state, start: r.start, end: r.end, now });
}

const GLYPH: Record<string, string> = { ETH: "Ξ", BTC: "₿", MON: "M" };

/** The asset's round badge: a coin-like circle, tinted by the asset. */
export function AssetBadge({ name, size = 40 }: { name: string; size?: number }) {
  const hue =
    name === "BTC"
      ? "from-[#ffb74d] to-[#f57c00]"
      : name === "MON"
        ? "from-[#a78bfa] to-[#6d28d9]"
        : "from-[#8da2ff] to-[#4f5bd5]";
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-full bg-gradient-to-br ${hue} font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]`}
      style={{ width: size, height: size, fontSize: size * 0.48 }}
    >
      {GLYPH[name] ?? name.slice(0, 1)}
    </span>
  );
}

const cents = (x: number | null) => (x === null ? "…" : `${Math.round(x * 100)}¢`);

export function RoundCard({ round }: { round: Round }) {
  const now = useNow();
  const phase = phaseOf(round, now);
  const live = useLiveMarket(phase.phase === "LIVE" ? round : undefined);
  const px = usePrice(round.series);
  const strike = round.strike > 0n ? Number(round.strike) / 1e18 : null;
  const prob = live.prob;
  const isLive = phase.phase === "LIVE";
  const canBet = isLive && !phase.closing && live.quoting && px.live;

  return (
    <div className="rise overflow-hidden rounded-[24px] border border-line/80 bg-surface shadow-[0_14px_30px_-18px_rgba(0,0,0,0.8)]">
      <Link
        href={`/market/${round.address}`}
        className="block p-4 pb-3 transition-colors hover:bg-raised/40"
        data-testid="round-card"
      >
        <div className="flex items-center gap-3">
          <AssetBadge name={round.series.name} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold leading-tight">
              {round.series.name} · {round.duration / 60} min
            </p>
            <p className="tabular mt-0.5 flex items-center gap-1.5 text-xs text-muted">
              {isLive ? (
                phase.closing ? (
                  <Pill tone="warn">Closing</Pill>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="live-dot" aria-hidden />
                    Live
                  </span>
                )
              ) : null}
              {phase.phase === "UPCOMING" ? `Opens in ${clock(phase.startsIn)}` : null}
              {phase.phase === "RESOLVING" ? "Settling the result…" : null}
              {phase.phase === "SETTLED" ? "Finished" : null}
            </p>
          </div>
          {isLive ? (
            <div className="relative grid place-items-center">
              <CountdownRing left={phase.endsIn} total={round.duration} size={46} />
              <span className="tabular absolute text-[10.5px] font-bold">
                {clock(phase.endsIn)}
              </span>
            </div>
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
          ) : phase.phase === "RESOLVING" ? (
            <Pill tone="warn">Settling</Pill>
          ) : (
            <Pill>Soon</Pill>
          )}
        </div>

        {isLive ? (
          <>
            <p className="mt-3 text-[17px] font-semibold leading-snug tracking-tight">
              Will {round.series.name} finish above{" "}
              <span className="text-brand">{strike ? `$${price(strike)}` : "its start price"}</span>
              ?
            </p>
            <div className="mt-3 flex items-end justify-between gap-3">
              <div>
                <p className="flex items-baseline gap-1.5">
                  <AnimatedNumber
                    value={prob === null ? null : prob * 100}
                    format={(n) => `${Math.round(n)}%`}
                    className="text-[34px] font-extrabold leading-none tracking-tight"
                  />
                  <span className="text-xs font-medium text-muted">chance of Up</span>
                </p>
                <p className="tabular mt-1.5 text-xs text-faint">
                  {px.price ? (
                    <>
                      <AnimatedNumber value={px.price} format={(n) => `$${price(n)}`} /> now
                    </>
                  ) : (
                    "Connecting to the price…"
                  )}
                </p>
              </div>
              <Sparkline points={px.history.slice(-90)} strike={strike} className="!h-11 !w-28" />
            </div>
            <div className="mt-3">
              <OddsBar up={prob} height={6} />
            </div>
          </>
        ) : null}
      </Link>

      {isLive ? (
        <div className="grid grid-cols-2 gap-2.5 px-4 pb-4">
          <BetLink
            round={round}
            side="UP"
            label="Up"
            value={cents(live.upAsk)}
            disabled={!canBet}
          />
          <BetLink
            round={round}
            side="DOWN"
            label="Down"
            value={cents(live.downAsk)}
            disabled={!canBet}
          />
        </div>
      ) : null}
    </div>
  );
}

function BetLink({
  round,
  side,
  label,
  value,
  disabled,
}: {
  round: Round;
  side: "UP" | "DOWN";
  label: string;
  value: string;
  disabled: boolean;
}) {
  const up = side === "UP";
  return (
    <Link
      href={`/market/${round.address}?bet=${side}`}
      aria-disabled={disabled}
      data-testid={`card-bet-${side.toLowerCase()}`}
      className={`flex min-h-12 items-center justify-between rounded-2xl px-4 text-sm font-bold transition-transform active:scale-[0.97] ${up ? "bg-up-soft text-up" : "bg-down-soft text-down"} ${disabled ? "pointer-events-none opacity-50" : ""}`}
    >
      <span>{label}</span>
      <span className="tabular text-base">{value}</span>
    </Link>
  );
}
