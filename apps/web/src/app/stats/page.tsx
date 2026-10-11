"use client";
import { LineChart } from "@/components/charts";
import { AppShell } from "@/components/shell";
import { Card, ErrorState, Skeleton, Stat } from "@/components/ui";
import { deployment, env } from "@/config/deployment";
import { explorerAddress } from "@/lib/chain";
import { pct, usd } from "@/lib/format";
import {
  useIndexerStats,
  useJudgeStats,
  useStatus,
  useVault,
  type JudgeStats,
} from "@/lib/queries";

/** Public proof page: everything here is read from the chain (and the open indexer when connected), no login. */
export default function Stats() {
  const j = useJudgeStats();
  const ix = useIndexerStats();
  const status = useStatus();
  const vaultNow = useVault(undefined);
  const daily = [...(ix.data?.daily ?? [])].sort((a, b) => a.day - b.day);
  const d = j.data;

  return (
    <AppShell wide>
      <h1 className="font-display text-[30px] font-extrabold leading-tight md:text-[44px]">
        Live numbers
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Read straight from {deployment.name}
        {env.indexerUrl ? " and the open indexer" : ""}, with no login and nothing edited by hand.{" "}
        {deployment.testnet ? "This is a test network: the money has no value." : ""}
      </p>
      <StatusLine query={status} />

      {j.isLoading ? (
        <div className="mt-5 grid gap-3 md:grid-cols-4" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : j.isError || !d ? (
        <div className="mt-5 grid gap-3">
          <Card>
            <Stat
              label="Money in the vault"
              value={usd(vaultNow.data?.navLower ?? 0n)}
              sub={`cap ${usd(vaultNow.data?.tvlCap ?? 0n, 0)}`}
            />
          </Card>
          <ErrorState
            title="The full numbers aren't loading right now"
            body="The vault figure above is read directly from the chain."
            retry={() => j.refetch()}
          />
        </div>
      ) : (
        <Numbers d={d} />
      )}

      {daily.length > 1 ? (
        <Card className="mt-4">
          <p className="mb-2 text-sm font-semibold">Daily volume, last 30 days (indexer)</p>
          <LineChart
            label="Daily volume"
            values={daily.map((x) => ({ x: x.day, y: Number(x.volume) / 1e6 }))}
            format={(y) => `$${y.toFixed(0)}`}
          />
        </Card>
      ) : null}

      <Card className="mt-4">
        <p className="text-sm font-semibold">Check it yourself</p>
        <ul className="mt-2 grid gap-1.5 text-sm text-muted md:grid-cols-2">
          {[
            ["Vault", deployment.vault],
            ["Venue (where bets are placed and filled)", deployment.venue],
            ["Market factory (creates the rounds)", deployment.factory],
          ].map(([label, addr]) => (
            <li key={addr}>
              <a
                href={explorerAddress(addr!)}
                target="_blank"
                rel="noreferrer"
                className="text-brand underline underline-offset-4"
              >
                {label}
              </a>{" "}
              <span className="font-mono text-xs text-faint">
                {addr!.slice(0, 6)}…{addr!.slice(-4)}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </AppShell>
  );
}

function Numbers({ d }: { d: JudgeStats }) {
  const r = d.rounds;
  const v = d.vault;
  const shortSample = v.days < 7;
  const parts: [string, number, string][] = [
    ["Settled normally", r.resolved, "bg-up"],
    ["Cancelled (pays 50¢ a share)", r.invalid, "bg-warn"],
    ["Late or stuck", r.stuck, "bg-down"],
    ["Never created (scheduler off)", r.neverCreated, "bg-faint"],
    ["Still running", r.open, "bg-line"],
  ];
  return (
    <>
      <div className="mt-5 grid gap-3 md:grid-cols-4" data-testid="kpis">
        <Card>
          <Stat
            label="All-time volume"
            value={usd(BigInt(Math.round(d.volume.usd * 1e6)), 0)}
            sub={`${d.volume.trades.toLocaleString("en-US")} filled trades`}
          />
        </Card>
        <Card>
          <Stat
            label="Money in the vault"
            value={usd(BigInt(Math.round(v.navUsd * 1e6)), 0)}
            sub={`cap ${usd(BigInt(Math.round(v.capUsd * 1e6)), 0)}`}
          />
        </Card>
        <Card>
          <Stat
            label="Rounds settled"
            value={r.resolved.toLocaleString("en-US")}
            sub={`of ${r.total.toLocaleString("en-US")} played`}
          />
        </Card>
        <Card>
          <Stat
            label="Rounds on schedule"
            value={d.uptime === null ? "—" : pct(d.uptime, 0)}
            sub={`${r.resolved} of ${r.slots} 15-minute slots`}
          />
        </Card>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Card>
          <p className="text-sm font-semibold">Vault return since launch</p>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Stat label="Value of 1 share" value={`$${v.sharePrice.toFixed(4)}`} />
            <Stat
              label="Since launch"
              value={`${v.returnSinceLaunch >= 0 ? "+" : ""}${(v.returnSinceLaunch * 100).toFixed(2)}%`}
              sub={`${v.days.toFixed(1)} days`}
            />
            <Stat
              label="Yearly pace"
              value={shortSample || v.annualisedReturn === null ? "—" : pct(v.annualisedReturn, 0)}
              sub={shortSample ? "needs 7+ days" : "annualised"}
            />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-faint">
            Share value is the vault&apos;s money divided by its shares, starting at $1.00. A few
            days of test-network trading says nothing about future returns, so the yearly pace stays
            hidden until there are seven days of history.
          </p>
        </Card>

        <Card>
          <p className="text-sm font-semibold">How the rounds ended</p>
          <div
            className="mt-3 flex h-3 overflow-hidden rounded-full bg-raised"
            role="img"
            aria-label="Round outcomes"
          >
            {parts.map(([label, n, cls]) =>
              n > 0 ? (
                <span
                  key={label}
                  className={cls}
                  style={{ width: `${(n / Math.max(r.slots, 1)) * 100}%` }}
                />
              ) : null,
            )}
          </div>
          <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
            {parts.map(([label, n, cls]) => (
              <li key={label} className="flex items-center gap-2 text-muted">
                <span className={`size-2.5 shrink-0 rounded-full ${cls}`} />
                <span className="tabular font-semibold text-text">{n}</span>
                <span className="truncate">{label}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs leading-relaxed text-faint">
            Counted from the factory&apos;s first round ({new Date(r.since).toLocaleDateString()}).
            Every 15 minutes has one round; a round counts as late five minutes after it should have
            ended. Outages show up here: nothing is hidden.
          </p>
        </Card>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-faint" data-testid="how-measured">
        Volume is the money paid for shares in filled bets on the current venue, summed from its
        on-chain order events up to block {d.volume.scannedToBlock.toLocaleString("en-US")}
        {d.volume.behindBlocks > 600
          ? ` (about ${Math.round((d.volume.behindBlocks * 0.302) / 60)} minutes of the newest trades are not counted yet)`
          : ""}
        . Updated {new Date(d.asOf).toLocaleTimeString()}, block {d.block.toLocaleString("en-US")}.
      </p>
    </>
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
