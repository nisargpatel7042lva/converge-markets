"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAccount } from "@/lib/use-account";
import { deployment } from "@/config/deployment";

const TABS = [
  { href: "/markets", label: "Markets", icon: "M4 18V8m6 10V4m6 14v-7m6 7V9" },
  { href: "/positions", label: "My bets", icon: "M5 7h14M5 12h14M5 17h9" },
  {
    href: "/vault",
    label: "Earn",
    icon: "M12 3v18M7 8c0-2 2-3 5-3s5 1 5 3-2 3-5 3-5 1-5 3 2 3 5 3 5-1 5-3",
  },
  { href: "/account", label: "Account", icon: "M12 12a4 4 0 100-8 4 4 0 000 8zm-8 9a8 8 0 0116 0" },
] as const;

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <svg aria-hidden width="22" height="22" viewBox="0 0 24 24">
        <path d="M3 5l9 7-9 7V5z" fill="#35e0a1" />
        <path d="M21 5l-9 7 9 7V5z" fill="#ff6b86" opacity=".92" />
      </svg>
      Converge
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { handle, ready } = useAccount();
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-ink/90 px-4 py-3 backdrop-blur">
        <Link href="/markets" aria-label="Converge home">
          <Logo />
        </Link>
        <div className="flex items-center gap-2">
          {deployment.testnet ? (
            <span className="rounded-full bg-[#2e2410] px-2.5 py-1 text-xs font-medium text-warn">
              Test money
            </span>
          ) : null}
          {ready && handle ? (
            <Link
              href="/account"
              className="inline-flex min-h-11 items-center rounded-full bg-raised px-3 text-xs font-medium text-muted"
            >
              {handle}
            </Link>
          ) : ready ? (
            <Link
              href="/start"
              className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-xs font-semibold text-[#0b0820]"
            >
              Sign in
            </Link>
          ) : (
            <span aria-hidden className="inline-block h-11 w-24" />
          )}
        </div>
      </header>
      <main id="main" className="flex-1 px-4 pb-28 pt-4">
        {children}
      </main>
      <nav
        aria-label="Main"
        className="safe-bottom fixed inset-x-0 bottom-0 z-30 mx-auto grid max-w-md grid-cols-4 border-t border-line bg-ink/95 pt-2 backdrop-blur"
      >
        {TABS.map((t) => {
          const active = path === t.href || path.startsWith(`${t.href}/`);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-12 flex-col items-center justify-center gap-1 text-xs ${active ? "text-text" : "text-faint"}`}
            >
              <svg
                aria-hidden
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke={active ? "#8b7bff" : "currentColor"}
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={t.icon} />
              </svg>
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
