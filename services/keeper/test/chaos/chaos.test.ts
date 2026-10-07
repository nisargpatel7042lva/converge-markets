import { convergeVaultAbi, forwardVenueAbi } from "@converge/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Address } from "viem";
import { startAnvil, type Anvil } from "../support/anvil";
import { startProxy } from "../support/proxy";
import { counter, histQuantile, makeRig, waitFor, type Rig } from "../support/rig";
import { deployStack, type Stack } from "../support/stack";

/**
 * Chaos: the keeper must pull its quotes within two blocks of a trigger and recover by itself.
 * Each scenario runs against the real contracts on anvil with 0.4 s blocks.
 */
describe("keeper chaos", () => {
  let anvil: Anvil;
  let stack: Stack;
  let market: Address;
  let end: number;
  const px = { v: 3000 };

  beforeAll(async () => {
    anvil = await startAnvil();
    stack = await deployStack(anvil.url);
    await stack.fund(1000);
    const r = await stack.openRound(px.v);
    market = r.market;
    end = r.end;
  }, 180_000);

  afterAll(async () => {
    await anvil?.stop();
  });

  const halted = () => stack.read<boolean>(stack.addrs.vault, convergeVaultAbi, "keeperHalt");
  const tradable = async () =>
    (
      await stack.read<{ tradable: boolean }>(stack.addrs.vault, convergeVaultAbi, "venueView", [
        market,
      ])
    ).tradable;
  // viem caches eth_blockNumber for a polling interval: ask for the real one
  const block = () => stack.pub.getBlockNumber({ cacheTime: 0 });

  async function haltEvents(fromBlock: bigint) {
    return stack.pub.getContractEvents({
      address: stack.addrs.vault,
      abi: convergeVaultAbi,
      eventName: "QuotingHalted",
      fromBlock,
    });
  }

  /** Brings a fresh keeper to the state "quoting": tradable, nothing halted. */
  async function quoting(rig: Rig) {
    await rig.keeper.start();
    await waitFor(tradable, 40_000, "the round to become tradable");
  }

  it("pulls on a 2% jump in one tick within 2 blocks, then recovers by itself", async () => {
    const rig = makeRig(stack);
    const feed = rig.feed(() => px.v);
    try {
      await quoting(rig);
      expect(await halted()).toBe(false);
      const blockAtJump = await block();
      px.v = 3060; // +2% in one tick, both sources
      const ev = await waitFor(
        async () => {
          const e = await haltEvents(blockAtJump);
          return e.length > 0 ? e[0] : null;
        },
        10_000,
        "QuotingHalted",
      );
      const lag = Number((ev!.blockNumber as bigint) - blockAtJump);
      expect(lag).toBeLessThanOrEqual(2);
      expect(await halted()).toBe(true);
      expect(await tradable()).toBe(false);
      // the two sources do not move in the same instant, so the first thing seen is a divergence
      const shockOrDivergence =
        (await counter(rig.metrics, "keeper_halts_total", { reason: "PRICE_SHOCK" })) +
        (await counter(rig.metrics, "keeper_halts_total", { reason: "SOURCE_DIVERGENCE" }));
      expect(shockOrDivergence).toBeGreaterThanOrEqual(1);
      // an order priced while halted is refunded, not filled
      const id = await stack.placeOrder(market, 0, 1_000_000n, 900_000_000_000_000_000n);
      const [, , status] = await waitFor(
        async () => {
          const o = await stack.read<readonly [Address, number, number]>(
            stack.addrs.venue,
            forwardVenueAbi,
            "orders",
            [id],
          );
          return Number(o[2]) === 2 ? o : null;
        },
        15_000,
        "the halted order to be closed",
      );
      expect(Number(status)).toBe(2);
      // the price stays at the new level: the shock ages out, the checks stay clean, quotes come back
      await waitFor(async () => !(await halted()), 40_000, "automatic unhalt");
      await waitFor(tradable, 20_000, "tradable again");
      expect(await counter(rig.metrics, "keeper_errors_total", { kind: "perform" })).toBe(0);
    } finally {
      feed.stop();
      rig.stop();
    }
  }, 150_000);

  it("pulls when a source goes stale (fewer than two healthy), within 2 blocks of noticing it, and recovers", async () => {
    px.v = 3060;
    const rig = makeRig(stack);
    const feed = rig.feed(() => px.v);
    try {
      await quoting(rig);
      const mutedAt = Date.now();
      const b0 = await block();
      feed.mute("coinbase");
      const ev = await waitFor(
        async () => {
          const e = await haltEvents(b0);
          return e.length > 0 ? e[0] : null;
        },
        12_000,
        "QuotingHalted",
      );
      const detectedAfterMs = Date.now() - mutedAt;
      expect(detectedAfterMs).toBeGreaterThanOrEqual(rig.cfg.price.staleMs - 200); // not before the threshold
      expect(Number((ev!.blockNumber as bigint) - b0)).toBeGreaterThan(0);
      // block distance between the instant the source became stale and the halt
      // (the metric is written when the receipt is seen, a poll after the event is visible)
      const lat = await waitFor(
        async () => {
          const l = await histQuantile(rig.metrics, "keeper_halt_latency_blocks", 1);
          return l.count >= 1 ? l : null;
        },
        5_000,
        "the halt latency metric",
      );
      expect(lat.value).toBeLessThanOrEqual(2); // detection to inclusion
      expect(await halted()).toBe(true);
      expect(
        await counter(rig.metrics, "keeper_halts_total", { reason: "FEW_SOURCES" }),
      ).toBeGreaterThanOrEqual(1);
      feed.unmute("coinbase");
      await waitFor(async () => !(await halted()), 30_000, "automatic unhalt");
    } finally {
      feed.stop();
      rig.stop();
    }
  }, 120_000);

  it("pulls when the sources disagree, and when the price leaves the on-chain Chainlink feed", async () => {
    const rig = makeRig(stack);
    let coinbase = px.v;
    const timer = setInterval(() => {
      rig.tick(px.v, ["binance"]);
      rig.tick(coinbase, ["coinbase"]);
    }, 100);
    try {
      await quoting(rig);
      coinbase = px.v * 1.015; // 150 bps apart: 75 bps each from the median
      await waitFor(halted, 8_000, "halt on divergence");
      expect(
        await counter(rig.metrics, "keeper_halts_total", { reason: "SOURCE_DIVERGENCE" }),
      ).toBeGreaterThanOrEqual(1);
      coinbase = px.v;
      await waitFor(async () => !(await halted()), 30_000, "unhalt after the sources agree again");
      // the sanity feed says the price is 3% lower than the exchanges
      rig.ref.setChainlink(px.v * 0.97, Date.now());
      await waitFor(halted, 8_000, "halt on a Chainlink mismatch");
      expect(
        await counter(rig.metrics, "keeper_halts_total", { reason: "CHAINLINK_MISMATCH" }),
      ).toBeGreaterThanOrEqual(1);
      rig.ref.setChainlink(px.v, Date.now());
      await waitFor(async () => !(await halted()), 30_000, "unhalt after the feed agrees");
    } finally {
      clearInterval(timer);
      rig.stop();
    }
  }, 180_000);

  it("survives an RPC endpoint dying mid-run (failover) and an outage of every endpoint (halts, then recovers)", async () => {
    const a = await startProxy(anvil.url);
    const b = await startProxy(anvil.url);
    const rig = makeRig(stack, { rpcUrls: [a.url, b.url] });
    const feed = rig.feed(() => px.v);
    try {
      await quoting(rig);
      // 1. the primary dies: the keeper carries on through the second endpoint
      a.enabled = false;
      const id = await stack.placeOrder(market, 0, 1_000_000n, 900_000_000_000_000_000n);
      await waitFor(
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
        "an order executed through the failover endpoint",
      );
      expect(await halted()).toBe(false);
      // 2. everything dies for a few seconds
      const b0 = await block();
      b.enabled = false;
      await new Promise((r) => setTimeout(r, 5_000));
      expect(rig.clients.rpcErrors.total).toBeGreaterThan(0);
      a.enabled = true;
      b.enabled = true;
      // the pull that could not be sent during the outage goes out on recovery, then quotes come back
      await waitFor(
        async () => (await haltEvents(b0)).length > 0,
        20_000,
        "the halt after the outage",
      );
      await waitFor(async () => !(await halted()), 40_000, "automatic unhalt");
      await waitFor(tradable, 20_000, "tradable again");
      // which check notices first depends on timing: five failed calls or five seconds without a block
      expect(
        (await counter(rig.metrics, "keeper_halts_total", { reason: "RPC_ERRORS" })) +
          (await counter(rig.metrics, "keeper_halts_total", { reason: "BLOCK_LAG" })),
      ).toBeGreaterThanOrEqual(1);
    } finally {
      feed.stop();
      rig.stop();
      await a.stop();
      await b.stop();
    }
  }, 180_000);

  it("floods of fills: every order is closed, the keeper pulls before the vault's ceiling and recovers after the round", async () => {
    px.v = 3000; // at the strike, so that both sides of the ladder are inside the price bounds
    const rig = makeRig(stack);
    const feed = rig.feed(() => px.v);
    try {
      await quoting(rig);
      const ids: bigint[] = [];
      // 30 buy orders of 3 shares at limit 0.95 in quick succession
      for (let i = 0; i < 30; i++) {
        ids.push(await stack.placeOrder(market, 0, 3_000_000n, 950_000_000_000_000_000n));
      }
      await waitFor(
        async () => {
          const rows = await Promise.all(
            ids.map((id) =>
              stack.read<readonly [Address, number, number]>(
                stack.addrs.venue,
                forwardVenueAbi,
                "orders",
                [id],
              ),
            ),
          );
          return rows.every((o) => Number(o[2]) === 2) ? true : null;
        },
        90_000,
        "every order closed (executed or expired)",
      );
      // the vault's own bound held: worst-case loss of the round <= 1% of the NAV (10 USDC)
      const [basis, cash] = await stack.read<readonly [bigint, bigint]>(
        stack.addrs.vault,
        convergeVaultAbi,
        "positionOf",
        [market],
      );
      const up = await stack.read<bigint>(
        await stack.read<Address>(
          market,
          [
            {
              type: "function",
              name: "up",
              stateMutability: "view",
              inputs: [],
              outputs: [{ type: "address" }],
            },
          ] as const,
          "up",
        ),
        [
          {
            type: "function",
            name: "balanceOf",
            stateMutability: "view",
            inputs: [{ type: "address" }],
            outputs: [{ type: "uint256" }],
          },
        ] as const,
        "balanceOf",
        [stack.addrs.vault],
      );
      const down = await stack.read<bigint>(
        await stack.read<Address>(
          market,
          [
            {
              type: "function",
              name: "down",
              stateMutability: "view",
              inputs: [],
              outputs: [{ type: "address" }],
            },
          ] as const,
          "down",
        ),
        [
          {
            type: "function",
            name: "balanceOf",
            stateMutability: "view",
            inputs: [{ type: "address" }],
            outputs: [{ type: "uint256" }],
          },
        ] as const,
        "balanceOf",
        [stack.addrs.vault],
      );
      const pairs = up < down ? up : down;
      const loss = Number(basis - cash - pairs) / 1e6;
      expect(loss).toBeLessThanOrEqual(10.000001);
      // and the keeper stopped at its own cap (90% of the ceiling), not at the vault's wall
      expect(loss).toBeLessThan(9.5);
      // the keeper pulled on its own inventory check (90% of the per-market ceiling)
      expect(
        await counter(rig.metrics, "keeper_halts_total", { reason: "INVENTORY_LOSS" }),
      ).toBeGreaterThanOrEqual(1);
      expect(await halted()).toBe(true);
      expect(await counter(rig.metrics, "keeper_errors_total", { kind: "perform" })).toBe(0);
      // the round ends and resolves: the keeper redeems it, the inventory is gone, quotes can return
      await stack.resolveRound(market, end, 3000);
      await waitFor(
        async () =>
          (await stack.read<boolean>(stack.addrs.vault, convergeVaultAbi, "isRegistered", [
            market,
          ])) === false,
        30_000,
        "redeemResolved",
      );
      await waitFor(async () => !(await halted()), 60_000, "automatic unhalt after the round");
    } finally {
      feed.stop();
      rig.stop();
    }
  }, 300_000);
});
