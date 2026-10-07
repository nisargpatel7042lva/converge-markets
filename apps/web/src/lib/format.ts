/** Collateral base units (6 dp) as dollars: "$12.50". */
export function usd(units: bigint | number, dp = 2): string {
  const n = typeof units === "bigint" ? Number(units) / 1e6 : units / 1e6;
  const s = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
  return `${n < 0 ? "-" : ""}$${s}`;
}

export function signedUsd(units: bigint, dp = 2): string {
  return `${units > 0n ? "+" : ""}${usd(units, dp)}`;
}

export function pct(x: number, dp = 0): string {
  return `${(x * 100).toFixed(dp)}%`;
}

export function price(x: number, dp = 2): string {
  return x.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** 73 -> "1:13", 3725 -> "1:02:05". */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${m}:${String(ss).padStart(2, "0")}`;
}

export const short = (a: string, n = 4) => `${a.slice(0, 2 + n)}…${a.slice(-n)}`;

export function nativeAmount(wei: bigint, dp = 3): string {
  return (Number(wei) / 1e18).toFixed(dp);
}

export function timeOfDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
