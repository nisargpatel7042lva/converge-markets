"use client";
import { useState } from "react";
import { fromWire, type WireRound } from "@/lib/serialize";
import { RoundCard, phaseOf } from "@/components/round-card";
import { AppShell } from "@/components/shell";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui";
import { clock } from "@/lib/format";
import { NowSeed, useNow, useRounds } from "@/lib/queries";

export function MarketsView({
  initial,
  serverNow,
}: {
  initial: WireRound[] | null;
  serverNow: number;
}) {
  return (
    <NowSeed.Provider value={serverNow}>
      <Inner initial={initial} />
    </NowSeed.Provider>
  );
}

type Tab = "live" | "soon" | "ended";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Still up?" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function Inner({ initial }: { initial: WireRound[] | null }) {
  const q = useRounds(initial ? initial.map(fromWire) : undefined);
  const now = useNow();
  const [tab, setTab] = useState<Tab>("live");
  const rounds = q.data ?? [];
  const live = rounds.filter((r) => phaseOf(r, now).phase === "LIVE");
  const soon = rounds.filter((r) => phaseOf(r, now).phase === "UPCOMING");
  const done = rounds
    .filter((r) => ["SETTLED", "RESOLVING"].includes(phaseOf(r, now).phase))
    .sort((a, b) => b.start - a.start)
    .slice(0, 6);
  const next = soon
    .map((r) => r.start - now)
    .filter((s) => s > 0)
    .sort((a, b) => a - b)[0];
  const shown = tab === "live" ? live : tab === "soon" ? soon : done;

  const tabs: [Tab, string, number][] = [
    ["live", "Live", live.length],
    ["soon", "Soon", soon.length],
    ["ended", "Ended", done.length],
  ];

  return (
    <AppShell wide>
      <p className="text-sm font-medium text-muted" suppressHydrationWarning>
        {greeting()}
      </p>
      <h1 className="font-display mt-0.5 text-[30px] font-semibold leading-tight md:text-[44px]">
        Markets
      </h1>
      <p className="mt-1 text-sm text-muted">
        {live.length > 0
          ? `${live.length} round${live.length > 1 ? "s" : ""} live right now. Up or Down, one tap.`
          : next !== undefined
            ? `The next round opens in ${clock(next)}.`
            : "A new round opens every 15 minutes."}
      </p>

      <div className="mt-4 flex gap-2" role="tablist" aria-label="Round status">
        {tabs.map(([k, label, n]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`inline-flex min-h-10 items-center gap-1.5 rounded-full px-4 text-sm font-semibold ${tab === k ? "bg-text text-ink" : "bg-raised text-muted"}`}
          >
            {label}
            <span
              className={`tabular rounded-full px-1.5 text-xs ${tab === k ? "bg-ink/15" : "bg-line"}`}
            >
              {n}
            </span>
          </button>
        ))}
      </div>

      {q.isLoading ? (
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-busy>
          <Skeleton className="h-52" />
          <Skeleton className="h-52" />
        </div>
      ) : q.isError ? (
        <div className="mt-5">
          <ErrorState retry={() => q.refetch()} />
        </div>
      ) : rounds.length === 0 ? (
        <div className="mt-5">
          <EmptyState
            mood="think"
            title="No rounds yet"
            body="A new 15-minute round opens on the quarter hour. Check back in a moment."
          />
        </div>
      ) : shown.length === 0 ? (
        <div className="mt-5">
          <EmptyState
            mood={tab === "live" ? "think" : "calm"}
            title={
              tab === "live"
                ? "Nothing is live this second"
                : tab === "soon"
                  ? "Nothing scheduled yet"
                  : "No finished rounds yet"
            }
            body={
              tab === "live" && next !== undefined
                ? `Take a breath: the next round opens in ${clock(next)}.`
                : "New rounds appear here on their own."
            }
          />
        </div>
      ) : (
        <div className="mt-4 grid gap-3.5 md:mt-6 md:grid-cols-2 md:gap-5 xl:grid-cols-3">
          {shown.map((r) => (
            <RoundCard key={r.address} round={r} />
          ))}
        </div>
      )}
    </AppShell>
  );
}
