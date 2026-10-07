"use client";
import Link from "next/link";
import { useEffect } from "react";
import { track } from "@/lib/analytics";
import { useAccount } from "@/lib/use-account";

export function StartButton() {
  const { profile, ready } = useAccount();
  useEffect(() => track("landing_view"), []);
  const cls =
    "flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand px-6 text-base font-semibold text-[#0b0820] transition-colors hover:bg-[#9d8fff] active:bg-[#7a69f0]";
  if (ready && profile)
    return (
      <Link href="/markets" className={cls}>
        Open the markets
      </Link>
    );
  return (
    <Link href="/start" className={cls}>
      <svg
        aria-hidden
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <path d="M7 4.5A9 9 0 0121 12M3 12a9 9 0 013-6.7M7 20.5C5 18.3 4 15.4 4 12M12 21c-2.5-2.2-4-5.2-4-9a4 4 0 118 0c0 2 .4 3.6 1.2 5M12 12c0 3 .8 5.6 2.4 7.6" />
      </svg>
      Start with Face ID
    </Link>
  );
}
