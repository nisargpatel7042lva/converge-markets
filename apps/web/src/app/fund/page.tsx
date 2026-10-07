"use client";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/shell";
import { toast } from "@/components/toast";
import { Button, Card, EmptyState, Skeleton } from "@/components/ui";
import { deployment } from "@/config/deployment";
import { env } from "@/config/deployment";
import { track } from "@/lib/analytics";
import { explorerAddress } from "@/lib/chain";
import { nativeAmount, short, usd } from "@/lib/format";
import { useBalances } from "@/lib/queries";
import { useAccount } from "@/lib/use-account";

const MIN_GAS = 5n * 10n ** 15n; // below 0.005 MON an account can't send a couple of transactions

export default function Fund() {
  const { profile, handle, ready } = useAccount();
  const bal = useBalances(profile?.address);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const dripAsked = useRef(false);

  const usdc = bal.data?.usdc ?? 0n;
  const native = bal.data?.native ?? 0n;
  const funded = usdc > 0n;
  const hasGas = native >= MIN_GAS;

  useEffect(() => {
    if (funded) track("funded", { gas: hasGas });
  }, [funded, hasGas]);

  // A new account gets one small gas top-up after its first deposit (ADR-007), never before.
  useEffect(() => {
    if (!profile || !funded || hasGas || dripAsked.current || deployment.testnet) return;
    dripAsked.current = true;
    void fetch("/api/gas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: profile.address }),
    })
      .then(async (r) => {
        if (r.ok) toast("A little gas money was added to your account.", "ok");
        void bal.refetch();
      })
      .catch(() => undefined);
  }, [profile, funded, hasGas, bal]);

  async function faucet() {
    if (!profile) return;
    setBusy(true);
    try {
      const r = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: profile.address }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? "The test faucet is busy. Try again in a minute.");
      toast("Test money added.", "ok");
      await bal.refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : "The test faucet is busy.", "error");
    } finally {
      setBusy(false);
    }
  }

  if (ready && !profile)
    return (
      <AppShell>
        <EmptyState
          title="Create your account first"
          body="You need an account before you can add money."
          action={
            <Link
              href="/start"
              className="rounded-xl bg-brand px-4 py-3 text-sm font-semibold text-[#0b0820]"
            >
              Create account
            </Link>
          }
        />
      </AppShell>
    );

  return (
    <AppShell>
      <h1 className="text-2xl font-bold tracking-tight">Add money</h1>
      <p className="mt-2 text-sm text-muted">
        {deployment.testnet
          ? "This is a test network: the money is free and has no value."
          : "Send dollars (USDC) to your account address on Monad."}
      </p>

      <Card className="mt-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-faint">Balance</p>
            {bal.isLoading ? (
              <Skeleton className="mt-1 h-8 w-24" />
            ) : (
              <p data-testid="usdc-balance" className="tabular text-3xl font-bold">
                {usd(usdc)}
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="text-xs text-faint">Gas money</p>
            <p data-testid="native-balance" className="tabular text-sm text-muted">
              {nativeAmount(native)} {deployment.nativeSymbol}
            </p>
          </div>
        </div>

        {deployment.testnet && env.faucetEnabled ? (
          <Button
            data-testid="faucet"
            className="mt-4 w-full"
            onClick={faucet}
            disabled={busy || !profile}
          >
            {busy ? "Adding test money…" : "Get free test money"}
          </Button>
        ) : null}
        {funded ? (
          <Link
            href="/markets"
            data-testid="to-markets"
            className="mt-3 flex min-h-14 w-full items-center justify-center rounded-2xl bg-up text-base font-semibold text-[#04251a]"
          >
            You&apos;re ready: pick a market
          </Link>
        ) : null}
      </Card>

      <Card className="mt-4 flex flex-col items-center gap-3 text-center">
        <p className="text-sm font-semibold">
          {handle ? `Your address (${handle})` : "Your address"}
        </p>
        {profile ? (
          <>
            <div className="rounded-2xl bg-white p-3">
              <QRCodeSVG
                value={profile.address}
                size={168}
                marginSize={0}
                title="Your account address"
              />
            </div>
            <p data-testid="address" className="break-all font-mono text-xs text-muted">
              {profile.address}
            </p>
            <div className="flex gap-2">
              <Button
                tone="quiet"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard?.writeText(profile.address).catch(() => undefined);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "Copied" : "Copy address"}
              </Button>
              {explorerAddress(profile.address) ? (
                <a
                  href={explorerAddress(profile.address)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-10 items-center rounded-2xl border border-line px-4 text-sm"
                >
                  {short(profile.address)} ↗
                </a>
              ) : null}
            </div>
            <p className="text-xs text-faint">
              Only send {deployment.testnet ? "test " : ""}USDC on {deployment.name}. Anything else
              may be lost.
            </p>
          </>
        ) : (
          <Skeleton className="h-52 w-52" />
        )}
      </Card>
    </AppShell>
  );
}
