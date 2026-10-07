"use client";
import { fromWire, type WireRound } from "@/lib/serialize";
import { RoundCard, phaseOf } from "@/components/round-card";
import { AppShell } from "@/components/shell";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui";
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

function Inner({ initial }: { initial: WireRound[] | null }) {
  const q = useRounds(initial ? initial.map(fromWire) : undefined);
  const now = useNow();
  const rounds = q.data ?? [];
  const live = rounds.filter((r) => phaseOf(r, now).phase === "LIVE");
  const soon = rounds.filter((r) => phaseOf(r, now).phase === "UPCOMING");
  const done = rounds
    .filter((r) => ["SETTLED", "RESOLVING"].includes(phaseOf(r, now).phase))
    .sort((a, b) => b.start - a.start)
    .slice(0, 4);

  return (
    <AppShell>
      <h1 className="text-2xl font-bold tracking-tight">Markets</h1>
      <p className="mt-1 text-sm text-muted">Pick a round. Up or Down, one tap.</p>

      {q.isLoading ? (
        <div className="mt-5 grid gap-3" aria-busy>
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : q.isError ? (
        <div className="mt-5">
          <ErrorState retry={() => q.refetch()} />
        </div>
      ) : rounds.length === 0 ? (
        <div className="mt-5">
          <EmptyState
            title="No rounds yet"
            body="A new 15-minute round opens on the quarter hour. Check back in a moment."
          />
        </div>
      ) : (
        <div className="mt-5 flex flex-col gap-6">
          <Group
            title="Live now"
            rounds={live}
            empty="Nothing is live this second. The next round opens soon."
          />
          {soon.length > 0 ? <Group title="Starting soon" rounds={soon} /> : null}
          {done.length > 0 ? <Group title="Just ended" rounds={done} /> : null}
        </div>
      )}
    </AppShell>
  );
}

function Group({
  title,
  rounds,
  empty,
}: {
  title: string;
  rounds: ReturnType<typeof useRounds>["data"] & object;
  empty?: string;
}) {
  return (
    <section aria-label={title}>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">{title}</h2>
      {rounds.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
          {empty}
        </p>
      ) : (
        <div className="grid gap-3">
          {rounds.map((r) => (
            <RoundCard key={r.address} round={r} />
          ))}
        </div>
      )}
    </section>
  );
}
