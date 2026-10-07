import { convergeVaultAbi, forwardVenueAbi } from "@converge/sdk";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Address } from "viem";
import { startAnvil, type Anvil } from "../support/anvil";
import { startProxy } from "../support/proxy";
import { counter, makeRig, testConfig, waitFor, type Rig } from "../support/rig";
import { deployStack, type Stack } from "../support/stack";

/**
 * Regression tests for the fail-open paths the Phase 5 hostile review found: a halt must survive a
 * restart, must not be undone before the price history exists, must not hammer a reverting call,
 * and the wallet must keep gas for a halt.
 */
describe("keeper safety", () => {
  let anvil: Anvil;
  let stack: Stack;
  let market: Address;
  const px = { v: 3000 };
  const rigs: Rig[] = [];
  const feeds: { stop: () => void }[] = [];

  beforeAll(async () => {
    anvil = await startAnvil();
    stack = await deployStack(anvil.url);
    await stack.fund(1000);
    market = (await stack.openRound(px.v)).market;
  }, 180_000);

  afterAll(async () => {
    for (const f of feeds) f.stop();
    for (const r of rigs) r.stop();
    await anvil?.stop();
  });

  const halted = () => stack.read<boolean>(stack.addrs.vault, convergeVaultAbi, "keeperHalt");
  const tradable = async () =>
    (
      await stack.read<{ tradable: boolean }>(stack.addrs.vault, convergeVaultAbi, "venueView", [
        market,
      ])
    ).tradable;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("an HTTP kill survives a restart; a restart without a price does not unhalt; unkill resumes", async () => {
    const killFile = join(tmpdir(), `keeper-kill-safety-${process.pid}`);
    const a = makeRig(stack, { killFile });
    rigs.push(a);
    const feedA = a.feed(() => px.v);
    await a.keeper.start();
    await waitFor(tradable, 40_000, "tradable");

    a.kill.setHttp(true); // what POST /kill does
    expect(existsSync(killFile)).toBe(true);
    await waitFor(halted, 10_000, "the kill to halt the vault");

    // the process dies and comes back: no feed yet, the kill file is still there
    feedA.stop();
    a.stop();
    const b = makeRig(stack, { killFile });
    rigs.push(b);
    await b.keeper.start();
    await sleep(6_000);
    expect(await halted()).toBe(true); // still killed, and no price: nothing may unhalt

    // an operator clears the kill, but the price is still missing: still halted
    b.kill.setHttp(false);
    expect(existsSync(killFile)).toBe(false);
    await sleep(5_000);
    expect(await halted()).toBe(true);

    // the price comes back: after the warm-up and the hysteresis it resumes by itself
    feeds.push(b.feed(() => px.v));
    await waitFor(async () => !(await halted()), 20_000, "the keeper to put quotes back");
    expect(await tradable()).toBe(true);
    b.stop();
  }, 120_000);

  it("a halt that keeps reverting backs off and raises an alert instead of hammering the node", async () => {
    // the owner replaces the keeper while the old process still runs
    const rig = makeRig(stack);
    rigs.push(rig);
    feeds.push(rig.feed(() => px.v));
    await rig.keeper.start();
    await waitFor(tradable, 40_000, "tradable");
    await stack.tx(stack.admin, {
      address: stack.addrs.vault,
      abi: convergeVaultAbi,
      functionName: "setKeeper",
      args: ["0x00000000000000000000000000000000000000aa"],
    });
    rig.kill.setHttp(true); // wants a halt, which can no longer succeed
    await sleep(8_000);
    const sent = await counter(rig.metrics, "keeper_tx_sent_total", {
      kind: "haltQuoting",
      result: "success",
    });
    const reverted = await counter(rig.metrics, "keeper_tx_sent_total", {
      kind: "haltQuoting",
      result: "reverted",
    });
    // 250 ms, 500 ms, 1 s, 2 s, 4 s ...: at most a handful in 8 s (it was one per block)
    expect(sent + reverted).toBeLessThanOrEqual(8);
    expect(rig.alerter.sent.some((x) => x.key === "halt-reverted")).toBe(true);
    rig.stop();
    // give the keeper role back for the next test
    await stack.tx(stack.admin, {
      address: stack.addrs.vault,
      abi: convergeVaultAbi,
      functionName: "setKeeper",
      args: [rig.clients.account.address],
    });
    rig.kill.setHttp(false);
  }, 120_000);

  it("below the wallet reserve only halts are sent", async () => {
    const rig = makeRig(stack, { cfg: testConfig({ reserveMon: 1_000_000_000 }) });
    rigs.push(rig);
    const feed = rig.feed(() => px.v);
    feeds.push(feed);
    await rig.keeper.start();
    await sleep(2_000);
    // an order that needs a transaction from the keeper: below the reserve it is not sent
    const id = await stack.placeOrder(market, 0, 1_000_000n, 900_000_000_000_000_000n);
    await sleep(8_000);
    const skipped =
      (await counter(rig.metrics, "keeper_tx_sent_total", {
        kind: "executeOrder",
        result: "reserve",
      })) +
      (await counter(rig.metrics, "keeper_tx_sent_total", {
        kind: "expireOrder",
        result: "reserve",
      }));
    expect(skipped).toBeGreaterThan(0);
    expect(
      Number(
        (
          await stack.read<readonly [Address, number, number]>(
            stack.addrs.venue,
            forwardVenueAbi,
            "orders",
            [id],
          )
        )[2],
      ),
    ).toBe(1); // still open: nothing was sent for it
    expect(rig.alerter.sent.some((x) => x.key === "reserve")).toBe(true);
    // a halt still goes out
    rig.kill.setHttp(true);
    await waitFor(halted, 10_000, "a halt under the reserve");
    rig.kill.setHttp(false);
    rig.stop();
  }, 120_000);

  it("pulls within 2 blocks of the trigger with 150 ms added to every RPC call (a real network)", async () => {
    const proxy = await startProxy(anvil.url);
    proxy.delayMs = 150;
    const rig = makeRig(stack, { rpcUrls: [proxy.url] });
    rigs.push(rig);
    const feed = rig.feed(() => px.v);
    feeds.push(feed);
    await rig.keeper.start();
    await waitFor(tradable, 40_000, "tradable");
    await waitFor(async () => !(await halted()), 20_000, "no halt before the trigger");
    const before = await stack.pub.getBlockNumber({ cacheTime: 0 });
    px.v = 3060; // +2% in one tick
    const ev = await waitFor(
      async () => {
        const e = await stack.pub.getContractEvents({
          address: stack.addrs.vault,
          abi: convergeVaultAbi,
          eventName: "QuotingHalted",
          fromBlock: before,
        });
        return e.length > 0 ? e[0] : null;
      },
      15_000,
      "QuotingHalted",
    );
    const lag = Number((ev?.blockNumber as bigint) - before);
    expect(lag).toBeLessThanOrEqual(2);
    px.v = 3000;
    rig.stop();
    await proxy.stop();
  }, 120_000);
});
