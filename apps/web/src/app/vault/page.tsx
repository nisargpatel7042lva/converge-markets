"use client";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import {
  approveTx,
  claimDepositTx,
  claimRedeemTx,
  parseUnits6,
  requestDepositTx,
  requestRedeemTx,
} from "@converge/sdk";
import { LineChart } from "@/components/charts";
import { AppShell } from "@/components/shell";
import { toast } from "@/components/toast";
import { Button, Card, EmptyState, ErrorState, Skeleton, Stat } from "@/components/ui";
import { deployment } from "@/config/deployment";
import { explainAccountError, withSigner } from "@/lib/account";
import { track } from "@/lib/analytics";
import { clock, pct, usd } from "@/lib/format";
import { useIndexerVault, useNow, useVault } from "@/lib/queries";
import { explainTxError, sendAll } from "@/lib/tx";
import { useAccount } from "@/lib/use-account";

export default function Vault() {
  const { profile } = useAccount();
  const v = useVault(profile?.address);
  const ix = useIndexerVault();
  const now = useNow();
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const d = v.data;
  const pps = d ? Number(d.ppsLower) / 1e18 : 1;
  const myShares = d?.user?.shares ?? 0n;
  const myValue = BigInt(Math.floor(Number(myShares) * pps));
  const windowLeft = d ? Math.max(0, d.epochEnd - now) : 0;
  const iv = ix.data?.vault ?? null;

  async function act(
    label: string,
    fn: (a: Parameters<Parameters<typeof withSigner>[1]>[0]) => Promise<unknown>,
  ) {
    if (!profile) return;
    setBusy(label);
    try {
      await withSigner(profile, fn);
      toast("Done.", "ok");
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

  const deposit = () =>
    act("deposit", async (account) => {
      const assets = parseUnits6(amount || "0");
      if (assets <= 0n) throw new Error("Enter an amount.");
      const steps = [
        ...((d?.user?.allowance ?? 0n) < assets
          ? [{ label: "Approve", tx: approveTx(deployment.usdc, deployment.vault, assets) }]
          : []),
        { label: "Deposit", tx: requestDepositTx(deployment.vault, assets) },
      ];
      await sendAll(account, steps);
      track("lp_deposit");
      setAmount("");
    });

  const redeem = (fraction: number) =>
    act("redeem", async (account) => {
      const shares = (myShares * BigInt(Math.round(fraction * 100))) / 100n;
      if (shares <= 0n) throw new Error("You have no shares to redeem.");
      await sendAll(account, [{ label: "Redeem", tx: requestRedeemTx(deployment.vault, shares) }]);
    });

  const claim = (epoch: bigint, kind: "deposit" | "redeem") =>
    act(`claim-${kind}-${epoch}`, (account) =>
      sendAll(account, [
        {
          label: "Claim",
          tx:
            kind === "deposit"
              ? claimDepositTx(deployment.vault, epoch, account.address)
              : claimRedeemTx(deployment.vault, epoch, account.address),
        },
      ]),
    );

  return (
    <AppShell>
      <h1 className="text-2xl font-bold tracking-tight">Earn from the spread</h1>
      <p className="mt-1 text-sm leading-relaxed text-muted">
        Add dollars to the shared vault that takes the other side of every bet. When it prices well,
        it earns the spread. When it prices badly, it loses. No token rewards: returns come from
        trading only.
      </p>

      {v.isLoading ? (
        <Skeleton className="mt-4 h-40" />
      ) : v.isError || !d ? (
        <div className="mt-4">
          <ErrorState retry={() => v.refetch()} />
        </div>
      ) : (
        <>
          <Card className="mt-4">
            <div className="grid grid-cols-2 gap-4">
              <Stat label="Vault value" value={usd(d.navLower)} sub={`cap ${usd(d.tvlCap, 0)}`} />
              <Stat
                label="Value of 1 share"
                value={`$${pps.toFixed(4)}`}
                sub="what you'd get now"
              />
              <Stat
                label="7-day return (APY)"
                value={iv?.apy7d != null ? pct(iv.apy7d, 1) : "—"}
                sub={iv?.apy7d != null ? "from past results" : "needs 7 days of history"}
              />
              <Stat
                label="30-day return (APY)"
                value={iv?.apy30d != null ? pct(iv.apy30d, 1) : "—"}
                sub={iv?.apy30d != null ? "from past results" : "needs 30 days of history"}
              />
            </div>
            {d.quotingPaused || d.quotingHalted ? (
              <p role="status" className="mt-3 rounded-xl bg-[#2e2410] px-3 py-2 text-xs text-warn">
                {d.quotingPaused
                  ? "Betting is paused by a safety switch."
                  : "Betting is briefly paused while the price settles."}{" "}
                Deposits and withdrawals still work.
              </p>
            ) : null}
          </Card>

          {ix.data?.nav && ix.data.nav.length > 1 ? (
            <Card className="mt-4">
              <p className="mb-2 text-sm font-semibold">Value of one share over time</p>
              <LineChart
                label="Vault share value over time"
                values={[...ix.data.nav]
                  .reverse()
                  .map((n) => ({ x: n.timestamp, y: Number(n.ppsLower) / 1e18 }))}
                format={(y) => `$${y.toFixed(4)}`}
              />
            </Card>
          ) : (
            <p className="mt-3 text-xs text-faint">
              {deployment.testnet
                ? "The performance chart appears once the indexer has history."
                : "The performance chart is loading."}
            </p>
          )}

          <Card className="mt-4">
            <p className="text-sm font-semibold">Next settlement window</p>
            <p data-testid="epoch-clock" className="tabular mt-1 text-2xl font-bold">
              {clock(windowLeft)}
            </p>
            <p className="mt-1 text-xs text-muted">
              Deposits and withdrawals are batched and settle together at the end of each window
              (about {Math.round(d.epochLength / 60)} minutes), at one fair price for everyone.
            </p>
          </Card>

          {!profile ? (
            <div className="mt-4">
              <EmptyState
                title="Sign in to add money"
                action={
                  <Link
                    href="/start"
                    className="rounded-xl bg-brand px-4 py-3 text-sm font-semibold text-[#0b0820]"
                  >
                    Start with Face ID
                  </Link>
                }
              />
            </div>
          ) : (
            <>
              <Card className="mt-4">
                <p className="text-sm font-semibold">Your share</p>
                <p data-testid="my-value" className="tabular mt-1 text-2xl font-bold">
                  {usd(myValue)}
                </p>
                <p className="tabular text-xs text-muted">
                  {(Number(myShares) / 1e6).toFixed(2)} shares · you have {usd(d.user?.usdc ?? 0n)}{" "}
                  to add
                </p>

                {d.user?.requests
                  .filter((r) => (r.deposit > 0n || r.redeem > 0n) && true)
                  .map((r) => {
                    const over = r.epoch < d.epoch;
                    return (
                      <div
                        key={String(r.epoch)}
                        className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-raised p-3 text-sm"
                      >
                        <div>
                          <p className="font-medium">
                            {r.deposit > 0n
                              ? `Deposit ${usd(r.deposit)}`
                              : `Withdraw ${(Number(r.redeem) / 1e6).toFixed(2)} shares`}
                          </p>
                          <p className="text-xs text-muted">
                            {over
                              ? r.rejected
                                ? "This window couldn't settle: your money is refundable"
                                : r.settled
                                  ? "Settled: ready to claim"
                                  : "Waiting for settlement"
                              : `Settles in ${clock(windowLeft)}`}
                          </p>
                        </div>
                        {over ? (
                          <Button
                            size="sm"
                            tone="up"
                            disabled={busy !== null}
                            onClick={() => claim(r.epoch, r.deposit > 0n ? "deposit" : "redeem")}
                          >
                            Claim
                          </Button>
                        ) : null}
                      </div>
                    );
                  })}
              </Card>

              <Card className="mt-4">
                <h2 className="text-base font-semibold">Add money to the vault</h2>
                <label htmlFor="dep" className="mt-3 block text-xs text-faint">
                  Amount in dollars
                </label>
                <div className="mt-1 flex items-center rounded-xl border border-line bg-raised px-3">
                  <span className="text-muted">$</span>
                  <input
                    id="dep"
                    data-testid="deposit-amount"
                    inputMode="decimal"
                    autoComplete="off"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                    placeholder="100"
                    className="tabular min-h-12 w-full bg-transparent px-2 text-base outline-none"
                  />
                </div>
                <label className="mt-3 flex items-start gap-3 text-sm text-muted">
                  <input
                    data-testid="ack"
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                    className="mt-1 h-5 w-5 accent-[#8b7bff]"
                  />
                  <span>
                    I understand I can lose some or all of this money, and that there are no rewards
                    beyond what the vault earns.
                  </span>
                </label>
                <Button
                  className="mt-3 w-full"
                  disabled={!ack || !amount || busy !== null}
                  onClick={deposit}
                  data-testid="deposit"
                >
                  {busy === "deposit" ? "Waiting for Face ID…" : "Request deposit"}
                </Button>
                {myShares > 0n ? (
                  <div className="mt-4 border-t border-line pt-4">
                    <h3 className="text-sm font-semibold">Take money out</h3>
                    <div className="mt-2 grid grid-cols-3 gap-2">
                      {[0.25, 0.5, 1].map((f) => (
                        <Button
                          key={f}
                          tone="quiet"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => redeem(f)}
                        >
                          {f === 1 ? "All" : pct(f)}
                        </Button>
                      ))}
                    </div>
                    <p className="mt-2 text-xs text-muted">
                      Withdrawals settle at the end of the window, at the lower of the vault&apos;s
                      fair value range.
                    </p>
                  </div>
                ) : null}
              </Card>
            </>
          )}

          <Card className="mt-4">
            <h2 className="text-base font-semibold">Read this before adding money</h2>
            <ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-relaxed text-muted">
              <li>
                <strong className="text-text">You can lose money.</strong> The vault takes the other
                side of bets. If the market moves against it faster than the spread pays, its value
                goes down, and so does yours.
              </li>
              <li>
                <strong className="text-text">How it makes money:</strong> it sells Up and Down at a
                small markup over fair value, and takes a performance fee of{" "}
                {d.performanceFeeBps / 100}% on gains. That is the only source of return. There are
                no token rewards.
              </li>
              <li>
                <strong className="text-text">Safety limits:</strong> each round and the whole vault
                have a loss ceiling, and a daily drop of 5% pauses new bets. You can always take
                your money out; a pause never blocks that.
              </li>
              <li>
                <strong className="text-text">Timing:</strong> deposits and withdrawals settle once
                per window, not instantly. Past results are not a promise.
              </li>
              <li>
                <strong className="text-text">It is new software.</strong>{" "}
                {deployment.testnet
                  ? "This is a test network with play money."
                  : "It is a capped launch (" +
                    usd(d.tvlCap, 0) +
                    ") because the contracts are new."}
              </li>
            </ul>
            <p className="mt-3 text-xs text-faint">
              Full details:{" "}
              <Link className="underline underline-offset-4" href="/legal/risk">
                Risk disclosure
              </Link>
              .
            </p>
          </Card>
        </>
      )}
    </AppShell>
  );
}
