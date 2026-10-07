"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { Address } from "viem";
import { expireOrderTx, redeemTx, roundPhase } from "@converge/sdk";
import { AppShell } from "@/components/shell";
import { toast } from "@/components/toast";
import { Button, Card, EmptyState, ErrorState, Pill, Skeleton } from "@/components/ui";
import { deployment } from "@/config/deployment";
import { forgetOrder, marketsOf, ordersOf } from "@/lib/activity";
import { explainAccountError, withSigner } from "@/lib/account";
import {
  indexerClient,
  readHoldings,
  readOpenOrders,
  readRoundsByAddress,
  type Holding,
  type Round,
} from "@/lib/data";
import { clock, signedUsd, usd } from "@/lib/format";
import { nowSec as clockNow } from "@/lib/clock";
import { useNow, useRounds } from "@/lib/queries";
import { explainTxError, sendAll } from "@/lib/tx";
import { useAccount } from "@/lib/use-account";

function payoutOf(h: Holding, outcome: "UP" | "DOWN" | "INVALID") {
  const gross = outcome === "UP" ? h.up : outcome === "DOWN" ? h.down : (h.up + h.down) / 2n;
  return gross - (gross * BigInt(h.round.redeemFeeBps)) / 10_000n;
}

export default function Positions() {
  const { profile, ready } = useAccount();
  const rounds = useRounds();
  const now = useNow();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const user = profile?.address;

  // Markets to look at: the live window, plus every market this device traded and every market the
  // indexer knows the user in, so a win from yesterday is still listed and collectable.
  const pnl = useQuery({
    queryKey: ["ix-pos", user],
    queryFn: async () => {
      const c = indexerClient();
      return c && user ? c.userPositions(user.toLowerCase()) : null;
    },
    enabled: Boolean(user),
    refetchInterval: 20000,
    retry: 0,
  });
  const extraAddrs = useMemo(() => {
    if (!user) return [] as Address[];
    const set = new Set<string>(marketsOf(user));
    for (const p of pnl.data ?? []) set.add(p.marketId.toLowerCase());
    for (const r of rounds.data ?? []) set.delete(r.address.toLowerCase());
    return [...set] as Address[];
  }, [user, pnl.data, rounds.data]);
  const extra = useQuery({
    queryKey: ["extra-rounds", extraAddrs.join(",")],
    queryFn: () => readRoundsByAddress(extraAddrs),
    enabled: extraAddrs.length > 0,
  });
  const allRounds: Round[] = useMemo(
    () => [...(rounds.data ?? []), ...(extra.data ?? [])],
    [rounds.data, extra.data],
  );
  const holdings = useQuery({
    queryKey: ["holdings", user, allRounds.map((r) => r.address).join(",")],
    queryFn: () => readHoldings(user as Address, allRounds),
    enabled: Boolean(user) && !rounds.isLoading,
    refetchInterval: 5000,
  });
  const orderIds = useMemo(
    () => (user ? ordersOf(user).map((o) => BigInt(o.id)) : []),
    [user, holdings.dataUpdatedAt],
  );
  const open = useQuery({
    queryKey: ["open-orders", user, orderIds.join(",")],
    queryFn: async () => {
      const list = await readOpenOrders(orderIds, clockNow());
      // an order that is no longer open needs no more tracking
      for (const id of orderIds)
        if (!list.some((o) => o.id === id) && user) forgetOrder(user, id.toString());
      return list;
    },
    enabled: Boolean(user) && orderIds.length > 0,
    refetchInterval: 4000,
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
  const playing = items.filter((x) => x.phase.phase !== "SETTLED");
  const settled = items.filter((x) => x.phase.phase === "SETTLED");
  const claimable = settled.filter(
    (x) => x.phase.phase === "SETTLED" && payoutOf(x.h, x.phase.outcome) > 0n,
  );
  const winners = claimable.filter(
    (x) => x.phase.phase === "SETTLED" && x.phase.outcome !== "INVALID",
  );
  const claimTotal = claimable.reduce(
    (s, x) => s + (x.phase.phase === "SETTLED" ? payoutOf(x.h, x.phase.outcome) : 0n),
    0n,
  );
  const realized = (pnl.data ?? []).reduce((s, p) => s + p.realizedPnl, 0n);

  async function run(label: string, fn: Parameters<typeof withSigner>[1], done: string) {
    if (!profile) return;
    setBusy(label);
    try {
      await withSigner(profile, fn);
      toast(done, "ok");
      await qc.invalidateQueries();
    } catch (e) {
      toast(
        /passkey|Mera|PRF|NotAllowed/i.test(String(e)) ? explainAccountError(e) : explainTxError(e),
        "error",
      );
    } finally {
      setBusy(null);
    }
  }

  const collectAll = () =>
    run(
      "collect",
      (account) =>
        sendAll(
          account,
          claimable.map((x) => ({ label: "Collect", tx: redeemTx(x.h.round.address) })),
        ),
      `Collected ${usd(claimTotal)}.`,
    );

  const refund = (id: bigint) =>
    run(
      `refund-${id}`,
      async (account) => {
        await sendAll(account, [{ label: "Cancel", tx: expireOrderTx(deployment.venue, id) }]);
        if (user) forgetOrder(user, id.toString());
      },
      "Cancelled. Your money is back in your account.",
    );

  const nothing = !holdings.isLoading && items.length === 0 && (open.data ?? []).length === 0;

  return (
    <AppShell>
      <h1 className="text-2xl font-bold tracking-tight">My bets</h1>

      {claimable.length > 0 ? (
        <Card className={`mt-4 ${winners.length > 0 ? "border-up-deep bg-[#0d2a20]" : ""}`}>
          <p className={`text-sm ${winners.length > 0 ? "text-up" : "text-muted"}`}>
            {winners.length > 0
              ? "A round you won has finished"
              : "A round was cancelled: your money is refundable"}
          </p>
          <p data-testid="claim-total" className="tabular mt-1 text-2xl font-bold">
            {usd(claimTotal)} ready to collect
          </p>
          <Button
            data-testid="collect-all"
            tone="up"
            className="mt-3 w-full"
            onClick={collectAll}
            disabled={busy !== null}
          >
            {busy === "collect" ? "Collecting…" : "Collect now"}
          </Button>
        </Card>
      ) : null}

      {(open.data ?? []).length > 0 ? (
        <section aria-label="Waiting to be filled" className="mt-4">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">
            Waiting to be filled
          </h2>
          <ul className="grid gap-3">
            {(open.data ?? []).map((o) => (
              <li
                key={String(o.id)}
                data-testid="open-order"
                className="rounded-2xl border border-line bg-surface p-4"
              >
                <p className="font-semibold">
                  {o.kind === 0 || o.kind === 1 ? "Up" : "Down"} · {usd(o.shares)} if right
                </p>
                {o.expired ? (
                  <>
                    <p className="mt-1 text-sm text-muted">
                      This bet was not filled in time. Cancel it to get the money you put in back
                      (the network fee you paid is not refunded).
                    </p>
                    <Button
                      data-testid="refund"
                      tone="quiet"
                      size="md"
                      className="mt-3 w-full"
                      disabled={busy !== null}
                      onClick={() => refund(o.id)}
                    >
                      {busy === `refund-${o.id}` ? "Cancelling…" : "Cancel and get my money back"}
                    </Button>
                  </>
                ) : (
                  <p className="mt-1 text-sm text-muted">
                    Placed. It is filled or cancelled within seconds.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
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
      ) : nothing ? (
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
          <Section title="In play" items={playing} />
          <Section title="Finished" items={settled} />
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
  items: { h: Holding; phase: ReturnType<typeof roundPhase> }[];
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
                    phase.outcome === "INVALID" ? (
                      <Pill>Cancelled · 50¢ back per share</Pill>
                    ) : won > 0n ? (
                      <Pill tone="up">Won</Pill>
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
