import { NextResponse } from "next/server";

/**
 * Testnet only: the reference price the keeper and the scheduler use (the mean of Binance and Coinbase, from the
 * local relay). The page pins its live price to this level so the odds it shows match the oracle's basis even when
 * the browser can reach only one exchange. Disabled (404) unless REF_PRICE_URL is set, so a production build never
 * exposes it.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.REF_PRICE_URL;
  if (!url) return NextResponse.json({ error: "disabled" }, { status: 404 });
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500), cache: "no-store" });
    const j = (await r.json()) as { price?: number | null };
    if (typeof j.price !== "number" || !(j.price > 0))
      return NextResponse.json({ error: "no price" }, { status: 503 });
    return NextResponse.json({ price: j.price }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
