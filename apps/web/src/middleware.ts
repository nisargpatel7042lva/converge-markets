import { NextResponse, type NextRequest } from "next/server";
import { regionDecision } from "@/lib/region";

/**
 * Region block at the edge: restricted jurisdictions get the explanation page (HTTP 451) for every
 * page and API call. Static assets and the block page itself stay reachable.
 */
export function middleware(req: NextRequest) {
  const country = req.headers.get("x-vercel-ip-country") ?? req.headers.get("cf-ipcountry");
  const region = req.headers.get("x-vercel-ip-country-region");
  const d = regionDecision(country, region, process.env.RESTRICTED_COUNTRIES_EXTRA);
  if (!d.blocked) return NextResponse.next();

  // Optional reviewer bypass (DECISION NEEDED, see config/regions.json): only exists when the
  // operator sets REGION_BYPASS_TOKEN; ?region_bypass=<token> sets a cookie for a week.
  const token = process.env.REGION_BYPASS_TOKEN;
  if (token && token.length >= 16) {
    if (req.cookies.get("region_ok")?.value === token) return NextResponse.next();
    if (req.nextUrl.searchParams.get("region_bypass") === token) {
      const clean = req.nextUrl.clone();
      clean.searchParams.delete("region_bypass");
      const res = NextResponse.redirect(clean);
      res.cookies.set("region_ok", token, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 7 * 86400,
        path: "/",
      });
      return res;
    }
  }
  // Exit-only mode: the pages for collecting, withdrawing and exporting stay open (the contracts
  // never block an exit, so the app must not either); new bets and deposits are closed in the UI.
  const exit = ["/account", "/positions", "/vault", "/stats", "/legal", "/fund"].some(
    (p) => req.nextUrl.pathname === p || req.nextUrl.pathname.startsWith(`${p}/`),
  );
  if (exit && !req.nextUrl.pathname.startsWith("/api/")) {
    const res = NextResponse.next();
    res.cookies.set("exit_only", "1", {
      path: "/",
      sameSite: "lax",
      secure: req.nextUrl.protocol === "https:",
      maxAge: 3600,
    });
    return res;
  }

  const url = req.nextUrl.clone();
  if (url.pathname.startsWith("/api/"))
    return NextResponse.json({ error: "Not available in your region" }, { status: 451 });
  url.pathname = "/blocked";
  url.search = "";
  return NextResponse.rewrite(url, { status: 451 });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|icons/|favicon.ico|manifest.webmanifest|sw.js|blocked).*)",
  ],
};
