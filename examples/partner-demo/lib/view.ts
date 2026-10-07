/**
 * Pure presentation helpers for the demo page: no network, no React, so they are easy to test.
 * Everything that talks to Converge goes through `@converge/sdk`; this file only formats.
 */
import type { MarketView, Quotes } from "@converge/sdk";

const pad = (n: number) => String(n).padStart(2, "0");

/** "20:00 UTC", or "Oct 8, 20:00 UTC" when it is not today (in UTC). */
export function formatEnd(endTime: number, now: number): string {
  const d = new Date(endTime * 1000);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  const sameDay = new Date(now * 1000).toISOString().slice(0, 10) === d.toISOString().slice(0, 10);
  if (sameDay) return hm;
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${month} ${d.getUTCDate()}, ${hm}`;
}

/** "$3,200" or "$0.0315" (a price, not an amount of money you hold). */
export function formatPrice(x: number): string {
  const digits = x >= 100 ? 0 : x >= 1 ? 2 : 4;
  return `$${x.toLocaleString("en-US", { maximumFractionDigits: digits })}`;
}

/** The headline a partner would put above the widget. */
export function question(asset: string, strike: number, endTime: number, now: number): string {
  return `Will ${asset} be at or above ${formatPrice(strike)} at ${formatEnd(endTime, now)}?`;
}

/** "3h 12m", "4m 05s", "12s". */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s % 60)}s`;
  return `${s}s`;
}

/** A price of 0.55 shown as "55¢". */
export const cents = (price: number): string => `${Math.round(price * 100)}¢`;

/** Shares are 6-decimal collateral units; each share pays $1 if it wins. */
export const sharesToUsd = (shares: bigint): number => Number(shares) / 1e6;

/** What a user sees in the status line under the question. */
export function statusLine(m: MarketView, now: number): string {
  switch (m.phase.phase) {
    case "UPCOMING":
      return "Not started yet";
    case "LIVE":
      return m.phase.closing
        ? `Closing: ${countdown(m.endTime - now)} left`
        : `Ends in ${countdown(m.endTime - now)}`;
    case "RESOLVING":
      return "Ended: waiting for the oracle price";
    case "SETTLED":
      return m.phase.outcome === "INVALID"
        ? "Settled: no valid oracle price, every share pays 50¢"
        : `Settled: ${m.phase.outcome === "UP" ? "YES (above)" : "NO (below)"} won`;
  }
}

export type Side = "UP" | "DOWN";

/** The two buy buttons: the ask and the depth behind it, or why there is none. */
export function sideCard(
  q: Quotes | null,
  side: Side,
): { label: string; price: string; depth: string; enabled: boolean } {
  const label = side === "UP" ? "Yes" : "No";
  const ask = q ? (side === "UP" ? q.up.ask : q.down.ask) : null;
  if (!ask) return { label, price: "–", depth: "no depth right now", enabled: false };
  const usd = sharesToUsd(ask.size) * ask.price;
  return {
    label,
    price: cents(ask.price),
    depth: `$${Math.floor(usd).toLocaleString("en-US")} available`,
    enabled: true,
  };
}

/** The probability bar: the vault's implied chance of YES, in whole percent. */
export const chanceYes = (q: Quotes | null): number | null =>
  q && q.quoting ? Math.round(q.fair * 100) : null;

/** What a winning bet pays, net of the redeem fee, for the "you win" line. */
export function winText(amountUsd: number, price: number, redeemFeeBps: number): string {
  if (!(amountUsd > 0) || !(price > 0)) return "";
  const shares = amountUsd / price;
  const payout = shares * (1 - redeemFeeBps / 10_000);
  return `Win $${payout.toFixed(2)} if you are right (profit $${(payout - amountUsd).toFixed(2)})`;
}
