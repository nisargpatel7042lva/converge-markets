"use client";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { redeemTx, roundPhase } from "@converge/sdk";
import { AppShell } from "@/components/shell";
import { toast } from "@/components/toast";
import { Button, Card, EmptyState, ErrorState, Pill, Skeleton } from "@/components/ui";
import { explainAccountError, withSigner } from "@/lib/account";
import { indexerClient, type Holding } from "@/lib/data";
import { clock, signedUsd, usd } from "@/lib/format";
import { useHoldings, useNow, useRounds } from "@/lib/queries";
import { explainTxError, sendAll } from "@/lib/tx";
import { useAccount } from "@/lib/use-account";
import { useQuery } from "@tanstack/react-query";

function payoutOf(h: Holding, outcome: "UP" | "DOWN" | "INVALID") {
  const gross = outcome === "UP" ? h.up : outcome === "DOWN" ? h.down : (h.up + h.down) / 2n;
  return gross - (gross * BigInt(h.round.redeemFeeBps)) / 10_000n;
}

export default function Positions() {
  const { profile, ready } = useAccount();
  const rounds = useRounds();
  const holdings = useHoldings(profile?.address, rounds.data);
  const now = useNow();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const pnl = useQuery({
    queryKey: ["ix-pos", profile?.address],
    queryFn: async () => {
      const c = indexerClient();
      return c && profile ? c.userPositions(profile.address.toLowerCase()) : null;
    },
    enabled: Boolean(profile),
    refetchInterval: 20000,
    retry: 0,
  });

  if (ready && !profile)
    return (
      <AppShell>
        <EmptyState
          title="Sign in to see your bets"
          action={
            <Link
              href="/start"
              className="rounded-xl bg-brand px-4 py-3 text-sm font-semibold text-[#0b0820]"
            >
              Start with Face ID
            </Link>
          }
        />
      </AppShell>
    );

  const items = (holdings.data ?? []).map((h) => ({
    h,
    phase: roundPhase({ state: h.round.state, start: h.round.start, end: h.round.end, now }),
  }));
  const open = items.filter(
    (x) =>
      x.phase.phase === "LIVE" || x.phase.phase === "UPCOMING" || x.phase.phase === "RESOLVING",
  );
  const settled = items.filter((x) => x.phase.phase === "SETTLED");
  const claimable = settled.filter(
    (x) => x.phase.phase === "SETTLED" && payoutOf(x.h, x.phase.outcome) > 0n,
  );
  const claimTotal = claimable.reduce(
    (s, x) => s + (x.phase.phase === "SETTLED" ? payoutOf(x.h, x.phase.outcome) : 0n),
    0n,
  );
  const realized = (pnl.data ?? []).reduce((s, p) => s + p.realizedPnl, 0n);

  async function collectAll() {
    if (!profile) return;
    setBusy(true);
    try {
      await withSigner(profile, (account) =>
        sendAll(
          account,
          claimable.map((x) => ({ label: "Collect", tx: redeemTx(x.h.round.address) })),
        ),
      );
      toast(`Collected ${usd(claimTotal)}.`, "ok");
      await qc.invalidateQueries();
    } catch (e) {
      toast(
        /passkey|Mera|PRF|NotAllowed/i.test(String(e)) ? explainAccountError(e) : explainTxError(e),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <h1 className="text-2xl font-bold tracking-tight">My bets</h1>

      {claimable.length > 0 ? (
        <Card className="mt-4 border-up-deep bg-[#0d2a20]">
          <p className="text-sm text-up">A round you won has finished</p>
          <p data-testid="claim-total" className="tabular mt-1 text-2xl font-bold">
            {usd(claimTotal)} ready to collect
          </p>
          <Button
            data-testid="collect-all"
            tone="up"
            className="mt-3 w-full"
            onClick={collectAll}
            disabled={busy}
          >
            {busy ? "Collecting…" : "Collect now"}
          </Button>
        </Card>
      ) : null}

      {pnl.data && pnl.data.length > 0 ? (
        <p className="tabular mt-3 text-sm text-muted">
          Profit and loss so far:{" "}
          <span className={realized >= 0n ? "text-up" : "text-down"}>{signedUsd(realized)}</span>
        </p>
      ) : null}

      {holdings.isLoading || rounds.isLoading ? (
        <div className="mt-5 grid gap-3" aria-busy>
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : holdings.isError ? (
        <div className="mt-5">
          <ErrorState retry={() => holdings.refetch()} />
        </div>
      ) : items.length === 0 ? (
        <div className="mt-5">
          <EmptyState
            title="No bets yet"
            body="When you bet Up or Down it shows up here, with a one-tap collect when you win."
            action={
              <Link
                href="/markets"
                className="rounded-xl bg-brand px-4 py-3 text-sm font-semibold text-[#0b0820]"
              >
                Find a market
              </Link>
            }
          />
        </div>
      ) : (
        <div className="mt-5 flex flex-col gap-5">
          <Section title="In play" items={open.map((x) => ({ ...x, tone: "brand" as const }))} />
          <Section
            title="Finished"
            items={settled.map((x) => ({ ...x, tone: "neutral" as const }))}
          />
        </div>
      )}
    </AppShell>
  );
}

function Section({
  title,
  items,
}: {
  title: string;
  items: { h: Holding; phase: ReturnType<typeof roundPhase>; tone: "brand" | "neutral" }[];
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label={title}>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">{title}</h2>
      <ul className="grid gap-3">
        {items.map(({ h, phase }) => {
          const won = phase.phase === "SETTLED" ? payoutOf(h, phase.outcome) : 0n;
          return (
            <li key={h.round.address}>
              <Link
                href={`/market/${h.round.address}`}
                className="block rounded-2xl border border-line bg-surface p-4"
                data-testid="position"
              >
                <div className="flex items-center justify-between">
                  <p className="font-semibold">
                    {h.round.series.name} · {h.round.duration / 60} min
                  </p>
                  {phase.phase === "SETTLED" ? (
                    won > 0n ? (
                      <Pill tone="up">Won</Pill>
                    ) : phase.outcome === "INVALID" ? (
                      <Pill>Cancelled</Pill>
                    ) : (
                      <Pill tone="down">Lost</Pill>
                    )
                  ) : phase.phase === "LIVE" ? (
                    <Pill tone="up">{clock(phase.endsIn)} left</Pill>
                  ) : (
                    <Pill tone="warn">Waiting</Pill>
                  )}
                </div>
                <p className="tabular mt-1 text-sm text-muted">
                  {h.up > 0n ? `Up · ${usd(h.up)} if right` : null}
                  {h.up > 0n && h.down > 0n ? " · " : null}
                  {h.down > 0n ? `Down · ${usd(h.down)} if right` : null}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
