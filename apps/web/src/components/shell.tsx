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

/** The mark: a "C" whose gradient runs Up (mint) to Down (coral), closing on one dot: the converged price. */
export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24">
      <defs>
        <linearGradient id="cg" gradientUnits="userSpaceOnUse" x1="0" y1="4" x2="0" y2="20">
          <stop offset="0" stopColor="#5fe0b4" />
          <stop offset=".5" stopColor="#b6aaf6" />
          <stop offset="1" stopColor="#f58a9a" />
        </linearGradient>
      </defs>
      <path
        d="M18.1 7.6A7.4 7.4 0 1 0 18.1 16.4"
        fill="none"
        stroke="url(#cg)"
        strokeWidth="4.2"
        strokeLinecap="round"
      />
      <circle cx="18.6" cy="12" r="1.7" fill="#eef0f6" />
    </svg>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span
      className={`font-display inline-flex items-center gap-2 font-extrabold tracking-tight ${className}`}
    >
      <LogoMark size={28} />
      converge
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

export function AppShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const path = usePathname();
  const { handle, ready } = useAccount();
  const width = wide ? "md:max-w-6xl" : "md:max-w-3xl";
  return (
    <div className="flex min-h-dvh w-full flex-col">
      <header className="sticky top-0 z-30 backdrop-blur-xl [background:linear-gradient(to_bottom,rgba(15,18,24,0.94),rgba(15,18,24,0.66))]">
        <div className="mx-auto flex w-full max-w-md items-center justify-between gap-2 px-4 py-3 md:max-w-6xl md:px-8 md:py-4">
          <Link href="/markets" aria-label="Converge home">
            <Logo className="md:text-lg" />
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            {TABS.filter((t) => t.href !== "/account").map((t) => {
              const active = path === t.href || path.startsWith(`${t.href}/`);
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${active ? "bg-brand-soft text-brand" : "text-muted hover:text-text"}`}
                >
                  {t.label}
                </Link>
              );
            })}
            <Link
              href="/stats"
              aria-current={path === "/stats" ? "page" : undefined}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${path === "/stats" ? "bg-brand-soft text-brand" : "text-muted hover:text-text"}`}
            >
              Stats
            </Link>
          </nav>
          <div className="flex items-center gap-2">
            {deployment.testnet ? (
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-warn-soft px-2.5 py-1 text-xs font-semibold text-warn">
                <span className="h-1.5 w-1.5 rounded-full bg-warn" />
                <span className="sm:hidden">Test</span>
                <span className="hidden sm:inline">Test money</span>
              </span>
            ) : null}
            {ready && handle ? (
              <Link
                href="/account"
                className="inline-flex min-h-11 max-w-[7.5rem] min-w-0 items-center gap-2 rounded-full bg-raised py-1 pl-1.5 pr-3 text-xs font-semibold text-text sm:max-w-[9.5rem] md:max-w-[12rem] md:text-sm"
              >
                <Avatar name={handle} />
                <span className="truncate">{handle}</span>
              </Link>
            ) : ready ? (
              <Link
                href="/start"
                className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-xs font-bold text-[#15112e] md:text-sm"
              >
                Sign in
              </Link>
            ) : (
              <span aria-hidden className="inline-block h-11 w-24" />
            )}
          </div>
        </div>
      </header>
      <main
        id="main"
        className={`mx-auto w-full max-w-md flex-1 px-4 pb-32 pt-2 md:px-8 md:pb-20 md:pt-6 ${width}`}
      >
        {children}
      </main>
      <footer className="mx-auto hidden w-full max-w-6xl flex-wrap items-center justify-between gap-3 border-t border-line/70 px-8 py-6 text-xs text-faint md:flex">
        <span>Converge · bet Up or Down on 15-minute rounds. Trading involves risk of loss.</span>
        <span className="flex gap-5">
          <Link href="/legal/terms" className="hover:text-muted">
            Terms
          </Link>
          <Link href="/legal/risk" className="hover:text-muted">
            Risk disclosure
          </Link>
          <Link href="/legal/privacy" className="hover:text-muted">
            Privacy
          </Link>
        </span>
      </footer>
      <nav
        aria-label="Main"
        className="safe-bottom pointer-events-none fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md px-4 md:hidden"
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
