import { NextResponse } from "next/server";
import { RelayerError, drip } from "@/server/relayer";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "unknown";
  try {
    const body = (await req.json().catch(() => ({}))) as { address?: unknown };
    const out = await drip(body.address, ip, { faucet: true });
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    if (e instanceof RelayerError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json(
      { error: "Something went wrong. Try again in a minute." },
      { status: 500 },
    );
  }
}
