"use client";
import Link from "next/link";
import { LineChart } from "@/components/charts";
import { Logo } from "@/components/shell";
import { Card, ErrorState, Skeleton, Stat } from "@/components/ui";
import { deployment, env } from "@/config/deployment";
import { pct, usd } from "@/lib/format";
import { useIndexerStats, useStatus, useVault } from "@/lib/queries";

/** Public proof page: everything here is read from the chain or the open indexer, no login. */
export default function Stats() {
  const ix = useIndexerStats();
  const status = useStatus();
  const v = useVault(undefined);
  const p = ix.data?.protocol ?? null;
  const vault = ix.data?.vault ?? null;
  const lag = ix.data?.status?.[0]
    ? ix.data.status[0].sourceBlock - ix.data.status[0].progressBlock
    : null;
  const daily = [...(ix.data?.daily ?? [])].sort((a, b) => a.day - b.day);

  return (
    <div className="mx-auto min-h-dvh w-full max-w-md px-4 pb-16 pt-5">
      <header className="flex items-center justify-between">
        <Link href="/" aria-label="Converge home">
          <Logo />
        </Link>
        <Link href="/markets" className="text-sm text-muted underline-offset-4 hover:underline">
          Open the app
        </Link>
      </header>
      <main id="main">
        <h1 className="mt-6 text-2xl font-bold tracking-tight">Live numbers</h1>
        <p className="mt-1 text-sm text-muted">
          Read straight from {deployment.name}
          {env.indexerUrl ? " and the open indexer" : ""}.{" "}
          {deployment.testnet ? "This is a test network: the money has no value." : ""}
        </p>

        <StatusLine query={status} />

        <Card className="mt-4">
          {v.isLoading ? (
            <Skeleton className="h-16" />
          ) : v.isError ? (
            <ErrorState retry={() => v.refetch()} />
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <Stat
                label="Money in the vault"
                value={usd(v.data?.navLower ?? 0n)}
                sub={`cap ${usd(v.data?.tvlCap ?? 0n, 0)}`}
              />
              <Stat
                label="Value of 1 share"
                value={`$${(Number(v.data?.ppsLower ?? 10n ** 18n) / 1e18).toFixed(4)}`}
              />
            </div>
          )}
        </Card>

        {ix.isLoading ? (
          <Skeleton className="mt-4 h-40" />
        ) : p ? (
          <>
            <Card className="mt-4">
              <div className="grid grid-cols-2 gap-4">
                <Stat label="Total traded" value={usd(p.totalVolume, 0)} />
                <Stat
                  label="Trades filled"
                  value={p.totalTrades.toLocaleString("en-US")}
                  sub="one per price level hit"
                />
                <Stat label="Rounds played" value={String(p.totalMarkets)} />
                <Stat label="Rounds settled" value={String(p.totalMarketsResolved)} />
                <Stat label="People" value={String(p.totalUsers)} />
                <Stat label="Fees earned" value={usd(p.totalFeesPerformance + p.totalFeesRedeem)} />
              </div>
            </Card>
            <Card className="mt-4">
              <p className="text-sm font-semibold">Vault performance</p>
              <div className="mt-2 grid grid-cols-3 gap-3">
                <Stat label="7 days" value={vault?.apy7d != null ? pct(vault.apy7d, 1) : "—"} />
                <Stat label="30 days" value={vault?.apy30d != null ? pct(vault.apy30d, 1) : "—"} />
                <Stat
                  label="Since start"
                  value={vault?.apySinceInception != null ? pct(vault.apySinceInception, 1) : "—"}
                />
              </div>
              <p className="mt-2 text-xs text-faint">
                Annualised from past results; short histories are noisy. Past results are not a
                promise.
              </p>
            </Card>
            {daily.length > 1 ? (
              <Card className="mt-4">
                <p className="mb-2 text-sm font-semibold">Daily volume, last 30 days</p>
                <LineChart
                  label="Daily volume"
                  values={daily.map((d) => ({ x: d.day, y: Number(d.volume) / 1e6 }))}
                  format={(y) => `$${y.toFixed(0)}`}
                />
              </Card>
            ) : null}
            {lag !== null ? (
              <p className="mt-3 text-xs text-faint">
                Data is {lag <= 1 ? "up to date" : `${lag} blocks behind`}.
              </p>
            ) : null}
          </>
        ) : (
          <Card className="mt-4 text-sm text-muted">
            {env.indexerUrl && ix.isError
              ? "The stats service isn't answering right now. The vault numbers above come directly from the chain."
              : "Volume, rounds and performance history come from the indexer, which isn't connected to this deployment yet. The vault numbers above are read directly from the chain."}
          </Card>
        )}
      </main>
    </div>
  );
}

const DOT = {
  ok: "bg-emerald-500",
  degraded: "bg-amber-500",
  paused: "bg-amber-500",
  down: "bg-red-500",
} as const;

/** One sentence on whether rounds are opening, quoting and settling; never hides a problem. */
function StatusLine({ query }: { query: ReturnType<typeof useStatus> }) {
  const s = query.data;
  const text = s
    ? s.headline
    : query.isError
      ? "Status is unavailable right now. Your money is safe; you can always collect and withdraw."
      : "Checking status…";
  return (
    <p
      role="status"
      data-testid="status-line"
      data-level={s?.level ?? "unknown"}
      className="mt-3 flex items-start gap-2 rounded-xl border border-line px-3 py-2 text-sm"
    >
      <span
        aria-hidden
        className={`mt-1.5 size-2 shrink-0 rounded-full ${s ? DOT[s.level] : "bg-zinc-400"}`}
      />
      <span>{text}</span>
    </p>
  );
}
