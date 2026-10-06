import { convergeVaultAbi, forwardVenueAbi } from "@converge/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAnvil, type Anvil } from "../support/anvil";
import { counter, makeRig, waitFor, type Rig } from "../support/rig";
import { KEYS, deployStack, type Stack } from "../support/stack";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, type Address } from "viem";

/**
 * Dry-run and paper mode never send a transaction: the vault is prepared by a live keeper, which is
 * then stopped, and the other modes are run against the prepared round.
 */
describe("dry-run and paper mode", () => {
  let anvil: Anvil;
  let stack: Stack;
  let market: Address;
  const px = 3000;
  const rigs: Rig[] = [];
  const feeds: { stop: () => void }[] = [];

  const keeperNonce = async () =>
    createPublicClient({ transport: http(stack.url) }).getTransactionCount({
      address: privateKeyToAccount(KEYS.keeper).address,
    });

  const orderStatus = async (id: bigint) =>
    Number(
      (
        await stack.read<readonly [Address, number, number]>(
          stack.addrs.venue,
          forwardVenueAbi,
          "orders",
          [id],
        )
      )[2],
    );

  beforeAll(async () => {
    anvil = await startAnvil();
    stack = await deployStack(anvil.url);
    await stack.fund(1000);
    market = (await stack.openRound(px)).market;
    const live = makeRig(stack);
    const f = live.feed(() => px);
    await live.keeper.start();
    await waitFor(
      async () =>
        (
          await stack.read<{ tradable: boolean }>(
            stack.addrs.vault,
            convergeVaultAbi,
            "venueView",
            [market],
          )
        ).tradable,
      40_000,
      "the live keeper to prepare the round",
    );
    f.stop();
    live.stop();
  }, 120_000);

  afterAll(async () => {
    for (const f of feeds) f.stop();
    for (const r of rigs) r.stop();
    await anvil?.stop();
  });

  it("dry-run: logs what it would execute and sends nothing", async () => {
    const before = await keeperNonce();
    const r = makeRig(stack, { mode: "dry-run" });
    rigs.push(r);
    feeds.push(r.feed(() => px));
    await r.keeper.start();
    const id = await stack.placeOrder(market, 0, 1_000_000n, 900_000_000_000_000_000n);
    await new Promise((res) => setTimeout(res, 5_000));
    expect(await orderStatus(id)).toBe(1); // still open
    expect(await keeperNonce()).toBe(before);
    expect(await counter(r.metrics, "keeper_fills_total", { outcome: "filled" })).toBe(0);
    r.stop();
  }, 60_000);

  it("paper: simulates the fill against the live book, never sends", async () => {
    const before = await keeperNonce();
    const r = makeRig(stack, { mode: "paper" });
    rigs.push(r);
    feeds.push(r.feed(() => px));
    await r.keeper.start();
    const id = await stack.placeOrder(market, 0, 2_000_000n, 900_000_000_000_000_000n);
    await waitFor(async () => (r.keeper.paper.fills >= 1 ? true : null), 20_000, "a paper fill");
    expect(r.keeper.paper.premiumUsd).toBeGreaterThan(0.5);
    expect(await orderStatus(id)).toBe(1); // untouched on chain
    expect(await keeperNonce()).toBe(before);
    expect(
      await counter(r.metrics, "keeper_fills_total", { outcome: "simulated" }),
    ).toBeGreaterThanOrEqual(1);
    r.stop();
  }, 60_000);
});
