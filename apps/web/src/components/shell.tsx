"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAccount } from "@/lib/use-account";
import { deployment } from "@/config/deployment";

const TABS = [
  {
    href: "/markets",
    label: "Markets",
    icon: "M3 17l5-5 4 4 8-9M15 7h5v5",
  },
  {
    href: "/positions",
    label: "My bets",
    icon: "M7 4h10a2 2 0 012 2v14l-4-2-3 2-3-2-4 2V6a2 2 0 012-2zM9 9h6M9 13h4",
  },
  {
    href: "/vault",
    label: "Earn",
    icon: "M12 3v18M16.5 7.5C16.5 6 14.5 5 12 5S7.5 6 7.5 8s2 2.8 4.5 3.2 4.5 1.2 4.5 3.3S14.5 18 12 18s-4.5-1-4.5-2.5",
  },
  {
    href: "/account",
    label: "Account",
    icon: "M12 12a4 4 0 100-8 4 4 0 000 8zm-8 9a8 8 0 0116 0",
  },
] as const;

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-bold tracking-tight ${className}`}>
      <svg aria-hidden width="24" height="24" viewBox="0 0 24 24">
        <path d="M3 5l9 7-9 7V5z" fill="#34d99c" />
        <path d="M21 5l-9 7 9 7V5z" fill="#ff6f82" opacity=".94" />
      </svg>
      Converge
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-brand to-brand-deep text-[11px] font-bold text-[#15112e]"
    >
      {name.replace(/^@/, "").slice(0, 1).toUpperCase()}
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { handle, ready } = useAccount();
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
      <header className="sticky top-0 z-30 flex items-center justify-between px-4 py-3 backdrop-blur-xl [background:linear-gradient(to_bottom,rgba(18,18,21,0.92),rgba(18,18,21,0.6))]">
        <Link href="/markets" aria-label="Converge home">
          <Logo />
        </Link>
        <div className="flex items-center gap-2">
          {deployment.testnet ? (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-warn-soft px-2.5 py-1 text-xs font-semibold text-warn">
              <span className="h-1.5 w-1.5 rounded-full bg-warn" />
              Test money
            </span>
          ) : null}
          {ready && handle ? (
            <Link
              href="/account"
              className="inline-flex min-h-11 max-w-[9.5rem] items-center gap-2 rounded-full bg-raised py-1 pl-1.5 pr-3 text-xs font-semibold text-text"
            >
              <Avatar name={handle} />
              <span className="truncate">{handle}</span>
            </Link>
          ) : ready ? (
            <Link
              href="/start"
              className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-xs font-bold text-[#15112e]"
            >
              Sign in
            </Link>
          ) : (
            <span aria-hidden className="inline-block h-11 w-24" />
          )}
        </div>
      </header>
      <main id="main" className="flex-1 px-4 pb-32 pt-2">
        {children}
      </main>
      <nav
        aria-label="Main"
        className="safe-bottom pointer-events-none fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md px-4"
      >
        <div className="pointer-events-auto grid grid-cols-4 rounded-[26px] border border-line/80 bg-surface/90 p-1.5 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.7)] backdrop-blur-xl">
          {TABS.map((t) => {
            const active = path === t.href || path.startsWith(`${t.href}/`);
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-[20px] text-[11px] font-semibold transition-colors ${active ? "bg-brand-soft text-brand" : "text-faint"}`}
              >
                <svg
                  aria-hidden
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={t.icon} />
                </svg>
                {t.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
