"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo } from "@/components/shell";
import { Button } from "@/components/ui";
import { createAccount, explainAccountError, restoreAccount } from "@/lib/account";
import { track } from "@/lib/analytics";
import { handleOf } from "@/lib/handle";
import { useAccount } from "@/lib/use-account";

const MERA_DOCS = "https://mera.category.xyz/";
const MERA_EXPORT = "https://docs.monad.xyz/guides/mera";

export default function Start() {
  const router = useRouter();
  const { profile, handle, ready } = useAccount();
  const [busy, setBusy] = useState<"create" | "restore" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const [justCreated, setJustCreated] = useState(false);

  useEffect(() => {
    setSupported(
      typeof window !== "undefined" && "PublicKeyCredential" in window && window.isSecureContext,
    );
  }, []);

  async function run(kind: "create" | "restore") {
    setBusy(kind);
    setError(null);
    try {
      const p = kind === "create" ? await createAccount() : await restoreAccount();
      setJustCreated(true);
      track("account_created", { restored: kind === "restore" });
      void handleOf(p.address);
    } catch (e) {
      setError(explainAccountError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pb-10 pt-6">
      <header className="flex items-center justify-between">
        <Link href="/" aria-label="Back to the start page">
          <Logo className="text-lg" />
        </Link>
      </header>
      <main id="main" className="flex flex-1 flex-col justify-center gap-6 py-8">
        {ready && profile && justCreated ? (
          <section className="pop flex flex-col gap-5" aria-live="polite">
            <div>
              <p className="text-sm text-faint">Your account is ready</p>
              <h1 data-testid="handle" className="mt-1 text-3xl font-bold tracking-tight">
                {handle}
              </h1>
            </div>
            <div className="rounded-2xl border border-line bg-surface p-4 text-sm leading-relaxed text-muted">
              <p className="font-semibold text-text">It is yours, not ours.</p>
              <p className="mt-1">
                Your account is built from your passkey on this device. We never see it, and we
                can&apos;t recover or freeze it. You can export it to MetaMask or Rabby at any time
                from the Account tab (
                <a
                  className="underline underline-offset-4"
                  href={MERA_EXPORT}
                  target="_blank"
                  rel="noreferrer"
                >
                  how that works
                </a>
                ).
              </p>
            </div>
            <Button onClick={() => router.push("/fund")}>Add money to start</Button>
          </section>
        ) : (
          <section className="flex flex-col gap-5">
            <div>
              <h1 className="text-3xl font-bold leading-tight tracking-tight">
                Create your account
              </h1>
              <p className="mt-3 text-base leading-relaxed text-muted">
                One Face ID or fingerprint prompt. No password, no seed phrase to write down.
              </p>
            </div>
            {!supported ? (
              <div
                role="alert"
                className="rounded-2xl border border-down-deep bg-[#1e0d14] p-4 text-sm text-muted"
              >
                This browser can&apos;t create a passkey account. Open Converge in Safari (iPhone,
                iOS 18 or newer), Chrome on Android, or use a password manager passkey such as
                1Password.
              </div>
            ) : null}
            <Button
              onClick={() => run("create")}
              disabled={busy !== null || !supported}
              aria-busy={busy === "create"}
            >
              {busy === "create" ? "Waiting for your passkey…" : "Create account with Face ID"}
            </Button>
            <Button
              tone="ghost"
              size="md"
              onClick={() => run("restore")}
              disabled={busy !== null || !supported}
            >
              {busy === "restore" ? "Waiting for your passkey…" : "I already have an account"}
            </Button>
            {error ? (
              <p
                role="alert"
                className="rounded-xl border border-down-deep bg-[#1e0d14] px-4 py-3 text-sm text-[#ffd6de]"
              >
                {error}
              </p>
            ) : null}
            <p className="text-xs leading-relaxed text-faint">
              Accounts are powered by{" "}
              <a
                className="underline underline-offset-4"
                href={MERA_DOCS}
                target="_blank"
                rel="noreferrer"
              >
                Mera
              </a>
              : your passkey makes the key, and the key never leaves your device.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
