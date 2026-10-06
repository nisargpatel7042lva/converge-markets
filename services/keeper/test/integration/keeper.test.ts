import { convergeVaultAbi, forwardVenueAbi } from "@converge/sdk";
import { fairUp } from "../../src/inventory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Address } from "viem";
import { startAnvil, type Anvil } from "../support/anvil";
import { counter, histQuantile, makeRig, waitFor, type Rig } from "../support/rig";
import { deployStack, type Stack } from "../support/stack";

/**
 * The keeper against the Phase 4 contracts on a local anvil (0.4 s blocks): it prepares the vault
 * (sigma, inventory, NAV), executes orders within blocks of their pricing time, and the fills are
 * accounted on chain.
 */
describe("keeper on anvil", () => {
  let anvil: Anvil;
  let stack: Stack;
  let rig: Rig;
  let market: Address;
  let end: number;
  let feed: ReturnType<Rig["feed"]>;
  const px = { v: 3000 };

  beforeAll(async () => {
    anvil = await startAnvil();
    stack = await deployStack(anvil.url);
    await stack.fund(1000);
    const r = await stack.openRound(px.v);
    market = r.market;
    end = r.end;
    rig = makeRig(stack);
    feed = rig.feed(() => px.v);
    await rig.keeper.start();
  }, 120_000);

  afterAll(async () => {
    feed?.stop();
    rig?.stop();
    await anvil?.stop();
  });

  const view = () =>
    stack.read<{ tradable: boolean }>(stack.addrs.vault, convergeVaultAbi, "venueView", [market]);

  it("makes an eligible round tradable by itself: sigma, inventory, NAV", async () => {
    await waitFor(async () => (await view()).tradable, 30_000, "the round to become tradable");
    const [sigma] = await Promise.all([
      stack.read<readonly [boolean, string, bigint, bigint, bigint, bigint]>(
        stack.addrs.vault,
        convergeVaultAbi,
        "assetCfg",
        [(await import("../support/stack")).ASSET_ID],
      ),
    ]);
    expect(sigma[2]).toBeGreaterThan(0n);
    const reg = await stack.read<boolean>(stack.addrs.vault, convergeVaultAbi, "isRegistered", [
      market,
    ]);
    expect(reg).toBe(true);
    // inventory is the target share of the NAV (5% of 1000), split into pairs
    const [basis] = await stack.read<readonly [bigint, bigint]>(
      stack.addrs.vault,
      convergeVaultAbi,
      "positionOf",
      [market],
    );
    expect(Number(basis) / 1e6).toBeGreaterThan(40);
    expect(Number(basis) / 1e6).toBeLessThanOrEqual(50);
  }, 60_000);

  it("executes a taker's order within two blocks and the fill is accounted on chain", async () => {
    await waitFor(async () => (await view()).tradable, 30_000, "tradable");
    const id = await stack.placeOrder(market, 0, 2_000_000n, 900_000_000_000_000_000n); // BUY_UP 2 shares, limit 0.90
    const row = await waitFor(
      async () => {
        const o = await stack.read<readonly [Address, number, number]>(
          stack.addrs.venue,
          forwardVenueAbi,
          "orders",
          [id],
        );
        return Number(o[2]) === 2 ? o : null;
      },
      20_000,
      "the order to be executed",
    );
    expect(Number(row[2])).toBe(2);
    const [, cash] = await stack.read<readonly [bigint, bigint]>(
      stack.addrs.vault,
      convergeVaultAbi,
      "positionOf",
      [market],
    );
    expect(Number(cash) / 1e6).toBeGreaterThan(0.9); // premium received for 2 UP at about 0.5 to 0.6
    expect(Number(cash) / 1e6).toBeLessThan(1.4);
    // the keeper counts the fill when its own receipt poll sees the mined transaction
    await waitFor(
      async () => (await counter(rig.metrics, "keeper_fills_total", { outcome: "filled" })) >= 1,
      5_000,
      "the fill to be counted",
    );
    const age = await histQuantile(rig.metrics, "keeper_quote_age_blocks", 0.95);
    expect(age.count).toBeGreaterThanOrEqual(1);
    expect(age.value).toBeLessThanOrEqual(2);
  }, 60_000);

  it("prices the fill at the fair value of the price at the order's second", async () => {
    const sigma =
      Number(
        (
          await stack.read<readonly [boolean, string, bigint]>(
            stack.addrs.vault,
            convergeVaultAbi,
            "assetCfg",
            [(await import("../support/stack")).ASSET_ID],
          )
        )[2],
      ) / 1e18;
    const st = await stack.read<bigint>(
      market,
      [
        {
          type: "function",
          name: "strike",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "int256" }],
        },
      ] as const,
      "strike",
    );
    const now = await stack.now();
    const fair = fairUp(px.v, Number(st) / 1e18, sigma, end - now);
    expect(fair).toBeGreaterThan(0.3);
    expect(fair).toBeLessThan(0.7);
    const q = await stack.read<{
      quoting: boolean;
      fair: bigint;
      bids: readonly { price: bigint }[];
      asks: readonly { price: bigint }[];
    }>(stack.addrs.venue, forwardVenueAbi, "quoteAt", [
      market,
      BigInt(Math.round(px.v * 1e8)) * 10n ** 10n,
      BigInt(now + 2),
    ]);
    expect(q.quoting).toBe(true);
    expect(Math.abs(Number(q.fair) / 1e18 - fair)).toBeLessThan(0.01);
    expect(Number(q.asks[0]!.price) / 1e18).toBeGreaterThan(fair);
    expect(Number(q.bids[0]!.price) / 1e18).toBeLessThan(fair);
  }, 30_000);

  it("never saw a crossed, off-grid or out-of-bounds ladder, and nothing went wrong", async () => {
    expect(rig.keeper.violationLog).toEqual([]);
    expect(await counter(rig.metrics, "keeper_quote_violations_total")).toBe(0);
    expect(await counter(rig.metrics, "keeper_errors_total", { kind: "mirror_mismatch" })).toBe(0);
    expect(await counter(rig.metrics, "keeper_errors_total", { kind: "perform" })).toBe(0);
    expect(await counter(rig.metrics, "keeper_errors_total", { kind: "unhandled_rejection" })).toBe(
      0,
    );
    expect(rig.keeper.status().halted).toBe(false);
  });
});
