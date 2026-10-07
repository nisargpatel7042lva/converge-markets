import type { NextConfig } from "next";

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
