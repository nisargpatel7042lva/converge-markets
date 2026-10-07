"use client";
import Link from "next/link";
import { use, useState } from "react";
import type { Address } from "viem";
import { askFromLadder, impliedUp, redeemTx, roundPhase, type Side } from "@converge/sdk";
import { PriceChart } from "@/components/charts";
import { AppShell } from "@/components/shell";
import { toast } from "@/components/toast";
import { TradeSheet } from "@/components/trade-sheet";
import { Button, Card, ErrorState, Pill, Skeleton } from "@/components/ui";
import { deployment } from "@/config/deployment";
import { explainAccountError, withSigner } from "@/lib/account";
import { clock, pct, price, usd } from "@/lib/format";
import { usePrice } from "@/lib/prices";
import { useHoldings, useLadder, useNow, useRound } from "@/lib/queries";
import { explainTxError, sendAll } from "@/lib/tx";
import { useAccount } from "@/lib/use-account";
import { useExitOnly } from "@/lib/exit-only";
import { useQueryClient } from "@tanstack/react-query";

export default function MarketPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  const round = useRound(/^0x[0-9a-fA-F]{40}$/.test(address) ? (address as Address) : undefined);
  const r = round.data;
  const now = useNow();
  const px = usePrice(r?.series);
  const { profile } = useAccount();
  const exitOnly = useExitOnly();
  const phase = r ? roundPhase({ state: r.state, start: r.start, end: r.end, now }) : null;
  const ladder = useLadder(r, phase?.phase === "LIVE" ? px.price : null);
  const holdings = useHoldings(profile?.address, r ? [r] : undefined);
  const qc = useQueryClient();
  const [side, setSide] = useState<Side | null>(null);
  const [collecting, setCollecting] = useState(false);

  if (round.isLoading)
    return (
      <AppShell>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-4 h-40 w-full" />
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
  const prob = ladder.data?.quoting ? impliedUp(ladder.data) : null;
  const upAsk = ladder.data ? askFromLadder("UP", ladder.data) : null;
  const downAsk = ladder.data ? askFromLadder("DOWN", ladder.data) : null;
  const paused = phase.phase === "LIVE" && ladder.isSuccess && !ladder.data?.quoting;
  const holding = holdings.data?.[0];
  // no bets on a stale price feed (the odds shown would be wrong) and none in exit-only mode
  const canBet =
    phase.phase === "LIVE" && !phase.closing && ladder.data?.quoting && px.live && !exitOnly;
  const winnerShares =
    phase.phase === "SETTLED" && holding
      ? phase.outcome === "UP"
        ? holding.up
        : phase.outcome === "DOWN"
          ? holding.down
          : (holding.up + holding.down) / 2n
      : 0n;

  async function collect() {
    if (!profile || !r) return;
    setCollecting(true);
    try {
      await withSigner(profile, (account) =>
        sendAll(account, [{ label: "Collect", tx: redeemTx(r.address) }]),
      );
      toast("Collected. The money is in your account.", "ok");
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
    <AppShell>
      <Link href="/markets" className="text-sm text-muted underline-offset-4 hover:underline">
        ← Markets
      </Link>
      <div className="mt-2 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {r.series.name} · {r.duration / 60} min
          </h1>
          <p className="tabular mt-1 text-sm text-muted" data-testid="phase">
            {phase.phase === "LIVE" ? `Ends in ${clock(phase.endsIn)}` : null}
            {phase.phase === "UPCOMING" ? `Starts in ${clock(phase.startsIn)}` : null}
            {phase.phase === "RESOLVING" ? "Settling: the final price is being confirmed" : null}
            {phase.phase === "SETTLED"
              ? `Round over: ${phase.outcome === "INVALID" ? "cancelled" : `${phase.outcome === "UP" ? "Up" : "Down"} won`}`
              : null}
          </p>
        </div>
        {phase.phase === "LIVE" ? (
          <Pill tone={phase.closing ? "warn" : "up"}>{phase.closing ? "Closing" : "Live"}</Pill>
        ) : null}
      </div>

      <Card className="mt-4">
        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs text-faint">{r.series.pair} now</p>
            <p data-testid="price" className="tabular text-3xl font-bold">
              {px.price ? `$${price(px.price)}` : "…"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-faint">Start price</p>
            <p className="tabular text-base font-semibold">{strike ? `$${price(strike)}` : "—"}</p>
          </div>
        </div>
        <div className="mt-3">
          <PriceChart
            points={px.history}
            strike={strike}
            label={`${r.series.pair} price this round`}
          />
        </div>
        {!px.live && px.price !== null ? (
          <p className="mt-2 text-xs text-warn">The live price feed is reconnecting.</p>
        ) : null}
      </Card>

      {phase.phase === "LIVE" ? (
        <>
          <Card className="mt-4">
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-up">Up {prob !== null ? pct(prob) : "…"}</span>
              <span className="text-xs text-faint">fair odds right now</span>
              <span className="font-semibold text-down">
                Down {prob !== null ? pct(1 - prob) : "…"}
              </span>
            </div>
            <div
              className="mt-2 flex h-2 overflow-hidden rounded-full bg-raised"
              role="img"
              aria-label="Probability bar"
            >
              <div className="bg-up" style={{ width: `${(prob ?? 0.5) * 100}%` }} />
              <div className="bg-down" style={{ width: `${(1 - (prob ?? 0.5)) * 100}%` }} />
            </div>
          </Card>

          {exitOnly ? (
            <p
              role="status"
              data-testid="exit-only"
              className="mt-4 rounded-2xl border border-line bg-raised px-4 py-3 text-sm text-muted"
            >
              New bets aren&apos;t available in your region. You can still collect winnings and take
              your money out from My bets and Earn.
            </p>
          ) : !px.live ? (
            <p
              role="status"
              data-testid="feed-down"
              className="mt-4 rounded-2xl border border-line bg-[#2e2410] px-4 py-3 text-sm text-warn"
            >
              The live price feed is reconnecting. Betting is paused until it is back, so you never
              bet on a stale price.
            </p>
          ) : null}
          {paused ? (
            <p
              role="status"
              data-testid="paused"
              className="mt-4 rounded-2xl border border-line bg-[#2e2410] px-4 py-3 text-sm text-warn"
            >
              Betting is paused for this round for a moment (the price moved fast or the market is
              balancing). It comes back by itself.
            </p>
          ) : phase.closing ? (
            <p
              role="status"
              className="mt-4 rounded-2xl border border-line bg-raised px-4 py-3 text-sm text-muted"
            >
              Betting closes in the last minute of a round. The next round opens right after.
            </p>
          ) : null}

          <div className="mt-4 grid grid-cols-2 gap-3">
            <Button
              data-testid="bet-up"
              tone="up"
              disabled={!canBet}
              onClick={() => setSide("UP")}
              className="flex-col !gap-0 py-2"
            >
              <span>Up</span>
              <span className="tabular text-xs font-medium opacity-80">
                {upAsk
                  ? `${price(Number(upAsk.priceWad) / 1e18)} per share`
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
              className="flex-col !gap-0 py-2"
            >
              <span>Down</span>
              <span className="tabular text-xs font-medium opacity-80">
                {downAsk
                  ? `${price(Number(downAsk.priceWad) / 1e18)} per share`
                  : canBet === false
                    ? "unavailable"
                    : "…"}
              </span>
            </Button>
          </div>
          <p className="mt-3 text-center text-xs text-faint">
            Each share pays $1 if you&apos;re right and $0 if you&apos;re wrong. You can lose what
            you bet.
          </p>
        </>
      ) : null}

      {phase.phase === "UPCOMING" ? (
        <p className="mt-4 rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
          This round hasn&apos;t started. You can bet as soon as it opens in {clock(phase.startsIn)}
          .
        </p>
      ) : null}

      {holding ? (
        <Card className="mt-4">
          <p className="text-sm font-semibold">Your bet on this round</p>
          <p className="tabular mt-1 text-sm text-muted">
            {holding.up > 0n ? `Up: ${usd(holding.up)} if right` : ""}{" "}
            {holding.down > 0n ? `Down: ${usd(holding.down)} if right` : ""}
          </p>
          {phase.phase === "SETTLED" ? (
            winnerShares > 0n ? (
              <Button
                data-testid="collect"
                tone="up"
                className="mt-3 w-full"
                onClick={collect}
                disabled={collecting}
              >
                {collecting
                  ? "Collecting…"
                  : `Collect ${usd(winnerShares - (winnerShares * BigInt(r.redeemFeeBps)) / 10_000n)}`}
              </Button>
            ) : (
              <p className="mt-2 text-sm text-muted">
                This one didn&apos;t win. Better luck next round.
              </p>
            )
          ) : null}
        </Card>
      ) : null}
      <p className="mt-6 text-center text-xs text-faint">Network: {deployment.name}</p>

      {side ? (
        <TradeSheet
          round={r}
          side={side}
          ladder={ladder.data}
          profile={profile}
          onClose={() => setSide(null)}
        />
      ) : null}
    </AppShell>
  );
}
