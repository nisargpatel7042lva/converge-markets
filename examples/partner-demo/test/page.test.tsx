import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarketEmbed } from "../app/MarketEmbed";
import { readConfig } from "../lib/config";

const env = {
  NEXT_PUBLIC_REGISTRY: "0x0000000000000000000000000000000000000001",
  NEXT_PUBLIC_VAULT: "0x0000000000000000000000000000000000000002",
  NEXT_PUBLIC_VENUE: "0x0000000000000000000000000000000000000003",
  NEXT_PUBLIC_COLLATERAL: "0x0000000000000000000000000000000000000004",
};

describe("the embed renders on the server", () => {
  it("tells the integrator what to do when no market is configured", () => {
    const html = renderToString(<MarketEmbed cfg={readConfig(env)} />);
    expect(html).toContain("No market is configured");
    expect(html).toContain("NEXT_PUBLIC_MARKET");
  });

  it("shows a loading state while the market is read, with no crash and no secrets", () => {
    const html = renderToString(
      <MarketEmbed
        cfg={readConfig({
          ...env,
          NEXT_PUBLIC_MARKET: "0x00000000000000000000000000000000000000aa",
        })}
      />,
    );
    expect(html).toContain("Loading the market");
    expect(html).not.toMatch(/private/i);
  });
});
