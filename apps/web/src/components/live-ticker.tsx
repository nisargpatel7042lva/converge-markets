"use client";
import Link from "next/link";
import { clock } from "@/lib/format";
import { useNow, useRounds } from "@/lib/queries";
import { Skeleton } from "./ui";

/** The live rounds, on the landing page. A skeleton while loading, a calm line if nothing is open. */
export function LiveTicker() {
  const rounds = useRounds();
  const now = useNow();
  if (rounds.isLoading) return <Skeleton className="h-24 w-full" />;
  const live = (rounds.data ?? []).filter((r) => r.state === 1 && now < r.end).slice(0, 3);
  if (rounds.isError || live.length === 0)
    return (
      <div className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted">
        {rounds.isError
          ? "Live rounds are loading slowly. "
          : "A new round opens every 15 minutes. "}
        <Link href="/markets" className="text-text underline underline-offset-4">
          See the markets
        </Link>
      </div>
    );
  return (
    <ul className="grid gap-2">
      {live.map((r) => (
        <li key={r.address}>
          <Link
            href={`/market/${r.address}`}
            className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4"
          >
            <div className="min-w-0">
              <p className="font-semibold">
                {r.series.name} next {r.duration / 60} min
              </p>
              <p className="tabular text-sm text-muted">Ends in {clock(r.end - now)}</p>
            </div>
            <span className="rounded-full bg-[#0d2a20] px-3 py-1.5 text-sm font-semibold text-up">
              Bet now
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
