import { NextResponse, type NextRequest } from "next/server";
import { regionDecision } from "@/lib/region";

/**
 * Region block at the edge: restricted jurisdictions get the explanation page (HTTP 451) for every
 * page and API call. Static assets and the block page itself stay reachable.
 */
export function middleware(req: NextRequest) {
  const country = req.headers.get("x-vercel-ip-country") ?? req.headers.get("cf-ipcountry");
  const region = req.headers.get("x-vercel-ip-country-region");
  const d = regionDecision(country, region, process.env.RESTRICTED_COUNTRIES);
  if (!d.blocked) return NextResponse.next();
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
