import type { NextConfig } from "next";
import testnet from "./src/config/testnet.json" with { type: "json" };

const rpcUrl = (
  process.env.NEXT_PUBLIC_DEPLOYMENT_JSON
    ? JSON.parse(process.env.NEXT_PUBLIC_DEPLOYMENT_JSON)
    : testnet
).rpcUrl as string;
const origin = (u: string | undefined) => {
  try {
    return u ? new URL(u).origin : "";
  } catch {
    return "";
  }
};

// Where the browser may connect: the chain RPC, the exchange price feeds, the indexer and analytics.
// Scripts need 'unsafe-inline' (Next inlines its bootstrap); everything else is closed.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src ${["'self'", origin(rpcUrl), "https://api.binance.com", "wss://stream.binance.com:9443", "wss://ws-feed.exchange.coinbase.com", origin(process.env.NEXT_PUBLIC_INDEXER_URL), origin(process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.i.posthog.com")].filter(Boolean).join(" ")}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

// The e2e price mock and the test relayer are for test builds only: a production build refuses them.
if (process.env.NEXT_PUBLIC_APP_ENV === "production" && process.env.NEXT_PUBLIC_MOCK_PRICES) {
  throw new Error("NEXT_PUBLIC_MOCK_PRICES must not be set in a production build");
}

const config: NextConfig = {
  // The e2e build goes to its own directory so it never clobbers a normal build.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@converge/sdk", "@converge/strategy"],
  typedRoutes: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          ...(process.env.NODE_ENV === "production"
            ? [
                { key: "Content-Security-Policy", value: csp },
                { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
              ]
            : []),
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value:
              "publickey-credentials-get=(self), publickey-credentials-create=(self), camera=(), microphone=(), geolocation=()",
          },
        ],
      },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
    ];
  },
};

export default config;
