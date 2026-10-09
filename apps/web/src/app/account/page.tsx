"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/shell";
import { toast } from "@/components/toast";
import { Button, Card, EmptyState } from "@/components/ui";
import { deployment } from "@/config/deployment";
import { explainAccountError, forgetAccount, revealRecoveryPhrase } from "@/lib/account";
import { explorerAddress } from "@/lib/chain";
import { nativeAmount, short, usd } from "@/lib/format";
import { useBalances } from "@/lib/queries";
import { useAccount } from "@/lib/use-account";

export default function Account() {
  const { profile, handle, ready } = useAccount();
  const bal = useBalances(profile?.address);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  // the phrase never stays on screen: it hides itself after a minute
  useEffect(() => {
    if (!phrase) return;
    const t = setTimeout(() => setPhrase(null), 60_000);
    return () => clearTimeout(t);
  }, [phrase]);

  if (ready && !profile)
    return (
      <AppShell>
        <EmptyState
          title="No account on this device"
          body="Create one with Face ID, or restore the one you already have."
          action={
            <Link
              href="/start"
              className="rounded-xl bg-brand px-4 py-3 text-sm font-semibold text-[#15112e]"
            >
              Get started
            </Link>
          }
        />
      </AppShell>
    );

  async function reveal() {
    if (!profile) return;
    setBusy(true);
    try {
      setPhrase(await revealRecoveryPhrase(profile));
    } catch (e) {
      toast(explainAccountError(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <h1 className="text-2xl font-bold tracking-tight">Account</h1>
      <Card className="mt-4">
        <p className="text-xs text-faint">You are</p>
        <p data-testid="account-handle" className="text-2xl font-bold">
          {handle ?? "…"}
        </p>
        {profile ? (
          <p className="mt-2 break-all font-mono text-xs text-muted">
            {profile.address}{" "}
            {explorerAddress(profile.address) ? (
              <a
                className="underline"
                target="_blank"
                rel="noreferrer"
                href={explorerAddress(profile.address)}
              >
                {short(profile.address)} ↗
              </a>
            ) : null}
          </p>
        ) : null}
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-faint">Dollars</p>
            <p className="tabular font-semibold">{usd(bal.data?.usdc ?? 0n)}</p>
          </div>
          <div>
            <p className="text-xs text-faint">Gas money</p>
            <p className="tabular font-semibold">
              {nativeAmount(bal.data?.native ?? 0n)} {deployment.nativeSymbol}
            </p>
          </div>
        </div>
        <Link href="/fund" className="mt-3 inline-block text-sm underline underline-offset-4">
          Add money
        </Link>
      </Card>

      <Card className="mt-4">
        <h2 className="text-base font-semibold">Your account is self-custodial</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          The key is made from your passkey on your device. We never have it and can&apos;t reset or
          freeze it. If you lose every device that holds the passkey and never exported it, nobody
          can recover the account, including us.
        </p>
        <h3 className="mt-4 text-sm font-semibold">Use it in MetaMask or Rabby</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          Show your recovery phrase and import it into MetaMask or Rabby: you get the same address
          and the same money. Anyone who sees the phrase controls the account, so do it in private
          and never share it.{" "}
          <a
            className="underline underline-offset-4"
            target="_blank"
            rel="noreferrer"
            href="https://docs.monad.xyz/guides/mera"
          >
            How export works
          </a>
          .
        </p>
        {phrase ? (
          <div className="mt-3 rounded-xl border border-warn/40 bg-warn-soft p-3">
            <p data-testid="phrase" className="font-mono text-sm leading-relaxed">
              {phrase}
            </p>
            <Button tone="quiet" size="sm" className="mt-3" onClick={() => setPhrase(null)}>
              Hide
            </Button>
          </div>
        ) : (
          <Button tone="ghost" size="md" className="mt-3 w-full" onClick={reveal} disabled={busy}>
            {busy ? "Waiting for Face ID…" : "Show my recovery phrase"}
          </Button>
        )}
      </Card>

      <Card className="mt-4">
        <h2 className="text-base font-semibold">Install the app</h2>
        <p className="mt-1 text-sm text-muted">
          On iPhone: Share, then Add to Home Screen. On Android: menu, then Install app. It opens
          full screen and keeps the last screen if you go offline.
        </p>
      </Card>

      <Card className="mt-4">
        <h2 className="text-base font-semibold">Sign out of this device</h2>
        <p className="mt-1 text-sm text-muted">
          Your passkey and your money stay where they are. You can sign back in with &ldquo;I
          already have an account&rdquo;.
        </p>
        {confirmForget ? (
          <div className="mt-3 flex gap-2">
            <Button
              tone="down"
              size="md"
              className="flex-1"
              onClick={() => {
                forgetAccount();
                setConfirmForget(false);
                toast("Signed out on this device.");
              }}
            >
              Yes, sign out
            </Button>
            <Button
              tone="quiet"
              size="md"
              className="flex-1"
              onClick={() => setConfirmForget(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            tone="ghost"
            size="md"
            className="mt-3 w-full"
            onClick={() => setConfirmForget(true)}
          >
            Sign out
          </Button>
        )}
      </Card>

      <p className="mt-6 flex flex-wrap justify-center gap-x-4 gap-y-1 text-center text-xs text-faint">
        <Link href="/legal/terms">Terms</Link>
        <Link href="/legal/risk">Risk disclosure</Link>
        <Link href="/legal/privacy">Privacy</Link>
        <Link href="/stats">Live stats</Link>
      </p>
    </AppShell>
  );
}
