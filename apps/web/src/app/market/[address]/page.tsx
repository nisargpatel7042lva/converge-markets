"use client";
import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { redeemTx, roundPhase, type Side } from "@converge/sdk";
import { PriceChart } from "@/components/charts";
import { AssetBadge } from "@/components/round-card";
import {
  AnimatedNumber,
  Confetti,
  CountdownRing,
  OddsBar,
  Mascot,
  haptic,
} from "@/components/delight";
import { AppShell } from "@/components/shell";
import { toast } from "@/components/toast";
import { KuruPanel } from "@/components/kuru-panel";
import { TradeSheet } from "@/components/trade-sheet";
import { Button, Card, ErrorState, Pill, Skeleton } from "@/components/ui";
import { deployment } from "@/config/deployment";
import { explainAccountError, withSigner } from "@/lib/account";
import { clock, price, usd } from "@/lib/format";
import { useLiveMarket } from "@/lib/live";
import { usePrice } from "@/lib/prices";
import { useHoldings, useNow, useRound } from "@/lib/queries";
import { explainTxError, sendAll } from "@/lib/tx";
import { useAccount } from "@/lib/use-account";
import { useExitOnly } from "@/lib/exit-only";
import { useQueryClient } from "@tanstack/react-query";

type Range = "round" | "5m" | "1m";
const RANGES: [Range, string][] = [
  ["round", "Round"],
  ["5m", "5 min"],
  ["1m", "1 min"],
];
const cents = (x: number | null) => (x === null ? "…" : `${Math.round(x * 100)}¢`);

export default function MarketPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  const round = useRound(/^0x[0-9a-fA-F]{40}$/.test(address) ? (address as Address) : undefined);
  const r = round.data;
  const now = useNow();
  const px = usePrice(r?.series);
  const { profile } = useAccount();
  const exitOnly = useExitOnly();
  const phase = r ? roundPhase({ state: r.state, start: r.start, end: r.end, now }) : null;
  const live = useLiveMarket(r && phase?.phase === "LIVE" ? r : undefined);
  const holdings = useHoldings(profile?.address, r ? [r] : undefined);
  const qc = useQueryClient();
  const [side, setSide] = useState<Side | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const [range, setRange] = useState<Range>("round");

  // /market/0x…?bet=UP (the buttons on the feed cards) opens the bet sheet straight away
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("bet");
    if (q === "UP" || q === "DOWN") setSide(q);
  }, []);

  const points = useMemo(() => {
    const all = px.history;
    if (!r) return all;
    const cutoff =
      range === "1m"
        ? Date.now() - 60_000
        : range === "5m"
          ? Date.now() - 300_000
          : Math.max(r.start * 1000 - 5000, Date.now() - 3_600_000);
    const cut = all.filter((p) => p.t >= cutoff);
    return cut.length >= 2 ? cut : all.slice(-120);
  }, [px.history, r, range]);

  if (round.isLoading)
    return (
      <AppShell>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-4 h-52 w-full" />
        <Skeleton className="mt-4 h-24 w-full" />
      </AppShell>
    );
  if (round.isError || !r || !phase)
    return (
      <AppShell>
        <ErrorState
          title="We can't find that market"
          body="It may not exist on this network."
          retry={() => round.refetch()}
        />
        <Link
          href="/markets"
          className="mt-4 block text-center text-sm underline underline-offset-4"
        >
          Back to markets
        </Link>
      </AppShell>
    );

  const strike = r.strike > 0n ? Number(r.strike) / 1e18 : null;
  const prob = live.prob;
  const isLive = phase.phase === "LIVE";
  const paused = isLive && live.ladderReady && !live.quoting;
  const holding = holdings.data?.[0];
  // no bets on a stale price feed (the odds shown would be wrong) and none in exit-only mode
  const canBet = isLive && !phase.closing && live.quoting && px.live && !exitOnly;
  const winnerShares =
    phase.phase === "SETTLED" && holding
      ? phase.outcome === "UP"
        ? holding.up
        : phase.outcome === "DOWN"
          ? holding.down
          : (holding.up + holding.down) / 2n
      : 0n;
  const payout = winnerShares - (winnerShares * BigInt(r.redeemFeeBps)) / 10_000n;
  const delta = px.price !== null && strike !== null ? px.price - strike : null;

  async function collect() {
    if (!profile || !r) return;
    setCollecting(true);
    try {
      await withSigner(profile, (account) =>
        sendAll(account, [{ label: "Collect", tx: redeemTx(r.address) }]),
      );
      toast(`Collected ${usd(payout)}. It's in your account.`, "ok");
      setCelebrate(true);
      haptic([18, 40, 18]);
      await qc.invalidateQueries();
    } catch (e) {
      toast(
        /passkey|Mera|PRF|NotAllowed/i.test(String(e)) ? explainAccountError(e) : explainTxError(e),
        "error",
      );
    } finally {
      setCollecting(false);
    }
  }

  return (
    <AppShell wide>
      {celebrate ? <Confetti onDone={() => setCelebrate(false)} /> : null}
      <div className="lg:grid lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:items-start lg:gap-10">
        <div className="min-w-0">
          <div className="flex items-center justify-between">
            <Link
              href="/markets"
              aria-label="Back to markets"
              className="grid h-10 w-10 place-items-center rounded-full bg-raised text-lg text-muted"
            >
              ‹
            </Link>
            <div className="flex items-center gap-2">
              {isLive ? (
                <Pill tone={phase.closing ? "warn" : "up"}>
                  {phase.closing ? (
                    "Closing"
                  ) : (
                    <>
                      <span className="live-dot" aria-hidden /> Live
                    </>
                  )}
                </Pill>
              ) : null}
            </div>
          </div>

          <div className="mt-3 flex items-center gap-3">
            <AssetBadge name={r.series.name} size={44} />
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-[24px] font-semibold leading-tight md:text-[30px]">
                {r.series.name} · {r.duration / 60} min
              </h1>
              <p className="tabular mt-0.5 text-sm text-muted" data-testid="phase">
                {phase.phase === "LIVE" ? `Ends in ${clock(phase.endsIn)}` : null}
                {phase.phase === "UPCOMING" ? `Starts in ${clock(phase.startsIn)}` : null}
                {phase.phase === "RESOLVING"
                  ? "Settling: the final price is being confirmed"
                  : null}
                {phase.phase === "SETTLED"
                  ? `Round over: ${phase.outcome === "INVALID" ? "cancelled" : `${phase.outcome === "UP" ? "Up" : "Down"} won`}`
                  : null}
              </p>
            </div>
            {isLive ? (
              <div className="relative grid place-items-center">
                <CountdownRing left={phase.endsIn} total={r.duration} size={56} />
                <span className="tabular absolute text-xs font-bold">{clock(phase.endsIn)}</span>
              </div>
            ) : null}
          </div>

          <p className="mt-4 text-[19px] font-bold leading-snug tracking-tight">
            Will {r.series.name} finish above{" "}
            <span className="text-brand">{strike ? `$${price(strike)}` : "its start price"}</span>?
          </p>

          <Card className="mt-3 !p-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-faint">{r.series.pair} now</p>
                <p className="text-[34px] font-extrabold leading-none tracking-tight">
                  {px.price ? (
                    <AnimatedNumber
                      testId="price"
                      value={px.price}
                      format={(n) => `$${price(n)}`}
                    />
                  ) : (
                    <span data-testid="price">…</span>
                  )}
                </p>
                {delta !== null ? (
                  <p
                    className={`tabular mt-1.5 text-sm font-semibold ${delta >= 0 ? "text-up" : "text-down"}`}
                  >
                    {delta >= 0 ? "▲" : "▼"} ${price(Math.abs(delta))}{" "}
                    <span className="font-medium text-muted">
                      {delta >= 0 ? "above" : "below"} the start
                    </span>
                  </p>
                ) : null}
              </div>
              <div className="text-right">
                <p className="text-xs font-medium text-faint">Start price</p>
                <p className="tabular text-base font-semibold">
                  {strike ? `$${price(strike)}` : "—"}
                </p>
              </div>
            </div>
            <div className="-mx-1 mt-3">
              <PriceChart
                points={points}
                strike={strike}
                label={`${r.series.pair} price this round`}
              />
            </div>
            <div className="mt-2 flex items-center justify-between">
              <div className="flex gap-1.5" role="group" aria-label="Chart range">
                {RANGES.map(([k, label]) => (
                  <button
                    key={k}
                    aria-pressed={range === k}
                    onClick={() => setRange(k)}
                    className={`min-h-8 whitespace-nowrap rounded-full px-3 text-xs font-semibold ${range === k ? "bg-text text-ink" : "bg-raised text-muted"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-2 text-[11px] text-faint">
              {px.live
                ? `Live price · ${px.source}`
                : px.price !== null
                  ? "Price feed reconnecting…"
                  : ""}
            </p>
          </Card>
        </div>
        <div className="min-w-0 lg:sticky lg:top-24">
          {isLive ? (
            <>
              <Card className="mt-3.5 !p-4">
                <div className="flex items-end justify-between">
                  <div>
                    <p className="text-xs font-medium text-faint">Chance of Up</p>
                    <p className="text-[30px] font-extrabold leading-none text-up">
                      <AnimatedNumber
                        value={prob === null ? null : prob * 100}
                        format={(n) => `${Math.round(n)}%`}
                      />
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-medium text-faint">Chance of Down</p>
                    <p className="text-[30px] font-extrabold leading-none text-down">
                      <AnimatedNumber
                        value={prob === null ? null : (1 - prob) * 100}
                        format={(n) => `${Math.round(n)}%`}
                      />
                    </p>
                  </div>
                </div>
                <div className="mt-3">
                  <OddsBar up={prob} />
                </div>
              </Card>

              {exitOnly ? (
                <p
                  role="status"
                  data-testid="exit-only"
                  className="mt-3.5 rounded-2xl border border-line bg-raised px-4 py-3 text-sm text-muted"
                >
                  New bets aren&apos;t available in your region. You can still collect winnings and
                  take your money out from My bets and Earn.
                </p>
              ) : !px.live ? (
                <p
                  role="status"
                  data-testid="feed-down"
                  className="mt-3.5 rounded-2xl border border-line bg-warn-soft px-4 py-3 text-sm text-warn"
                >
                  The live price feed is reconnecting. Betting is paused until it is back, so you
                  never bet on a stale price.
                </p>
              ) : null}
              {paused ? (
                <p
                  role="status"
                  data-testid="paused"
                  className="mt-3.5 rounded-2xl border border-line bg-warn-soft px-4 py-3 text-sm text-warn"
                >
                  Betting is paused for this round for a moment (the price moved fast or the market
                  is balancing). It comes back by itself.
                </p>
              ) : phase.closing ? (
                <p
                  role="status"
                  className="mt-3.5 rounded-2xl border border-line bg-raised px-4 py-3 text-sm text-muted"
                >
                  Betting closes in the last minute of a round. The next round opens right after.
                </p>
              ) : null}
              <p className="mt-3 text-center text-xs text-faint">
                Each share pays $1 if you&apos;re right and $0 if you&apos;re wrong. You can lose
                what you bet.
              </p>
            </>
          ) : null}

          {phase.phase === "UPCOMING" ? (
            <div className="mt-4">
              <div className="flex flex-col items-center gap-2 rounded-[22px] border border-dashed border-line px-6 py-7 text-center">
                <Mascot mood="think" size={64} />
                <p className="text-sm text-muted">
                  This round hasn&apos;t started. You can bet as soon as it opens in{" "}
                  <span className="tabular font-semibold text-text">{clock(phase.startsIn)}</span>.
                </p>
              </div>
            </div>
          ) : null}

          {holding ? (
            <Card
              className={`mt-3.5 ${phase.phase === "SETTLED" && winnerShares > 0n ? "!border-up-deep !bg-up-soft" : ""}`}
            >
              {phase.phase === "SETTLED" ? (
                winnerShares > 0n ? (
                  <div className="flex items-center gap-3">
                    <Mascot mood="happy" size={52} />
                    <div>
                      <p className="text-lg font-extrabold text-up">You called it!</p>
                      <p className="tabular text-sm text-muted">
                        {usd(payout)} is waiting for you.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <Mascot mood="calm" size={52} />
                    <div>
                      <p className="text-base font-bold">Not this time</p>
                      <p className="text-sm text-muted">
                        {r.series.name} finished the other way. That&apos;s how it goes: the next
                        round is a fresh start.
                      </p>
                    </div>
                  </div>
                )
              ) : (
                <>
                  <p className="text-sm font-semibold">Your bet on this round</p>
                  <p className="tabular mt-1 text-sm text-muted">
                    {holding.up > 0n ? `Up: ${usd(holding.up)} if right` : ""}{" "}
                    {holding.down > 0n ? `Down: ${usd(holding.down)} if right` : ""}
                  </p>
                </>
              )}
              {phase.phase === "SETTLED" && winnerShares > 0n ? (
                <Button
                  data-testid="collect"
                  tone="up"
                  className="mt-3 w-full"
                  onClick={collect}
                  disabled={collecting}
                >
                  {collecting ? "Collecting…" : `Collect ${usd(payout)}`}
                </Button>
              ) : null}
              {phase.phase === "SETTLED" && winnerShares === 0n ? (
                <Link
                  href="/markets"
                  className="mt-3 flex min-h-12 items-center justify-center rounded-2xl bg-raised text-sm font-semibold"
                >
                  See the next round
                </Link>
              ) : null}
            </Card>
          ) : null}
          <KuruPanel round={r} vaultUpAsk={live.upAsk} />
          <p className="mt-6 text-center text-xs text-faint">Network: {deployment.name}</p>

          {isLive ? (
            <>
              <div aria-hidden className="h-36 md:h-8 lg:hidden" />
              <div className="pointer-events-none fixed inset-x-0 bottom-[84px] z-20 mx-auto max-w-md px-4 md:bottom-6 lg:pointer-events-auto lg:static lg:z-auto lg:mt-4 lg:max-w-none lg:px-0">
                <div className="pointer-events-auto grid grid-cols-2 gap-3 rounded-[26px] border border-line/80 bg-surface/90 p-2.5 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.8)] backdrop-blur-xl">
                  <Button
                    data-testid="bet-up"
                    tone="up"
                    disabled={!canBet}
                    onClick={() => setSide("UP")}
                    className="!min-h-14 flex-col !gap-0 !py-2"
                  >
                    <span className="text-[15px]">Up</span>
                    <span className="tabular text-xs font-semibold opacity-80">
                      {live.upAsk !== null
                        ? `${cents(live.upAsk)} per share`
                        : canBet === false
                          ? "unavailable"
                          : "…"}
                    </span>
                  </Button>
                  <Button
                    data-testid="bet-down"
                    tone="down"
                    disabled={!canBet}
                    onClick={() => setSide("DOWN")}
                    className="!min-h-14 flex-col !gap-0 !py-2"
                  >
                    <span className="text-[15px]">Down</span>
                    <span className="tabular text-xs font-semibold opacity-80">
                      {live.downAsk !== null
                        ? `${cents(live.downAsk)} per share`
                        : canBet === false
                          ? "unavailable"
                          : "…"}
                    </span>
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {side ? (
        <TradeSheet
          round={r}
          side={side}
          live={live}
          profile={profile}
          onClose={() => setSide(null)}
        />
      ) : null}
    </AppShell>
  );
}
