import { convergeVaultAbi, createConvergeClient } from "@converge/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAnvil, type Anvil } from "../support/anvil";
import { makeRig, testConfig, waitFor, type Rig } from "../support/rig";
import { TEST_LABEL, deployStack, type Stack } from "../support/stack";

/**
 * A partner market is created at an arbitrary moment and its owner expects depth within a block or
 * two. With a slow tick of 5 seconds (12 blocks on Monad) only the keeper's per-block look at the
 * registry can do that: this test would fail without it.
 */
describe("partner market pickup does not wait for the slow tick", () => {
  let anvil: Anvil;
  let stack: Stack;
  let rig: Rig;
  let feed: ReturnType<Rig["feed"]>;

  beforeAll(async () => {
    anvil = await startAnvil();
    stack = await deployStack(anvil.url);
    await stack.fund(1000);
    rig = makeRig(stack, { cfg: testConfig({ slowTickMs: 5_000 }) });
    feed = rig.feed(() => 3000);
    await rig.keeper.start();
    await new Promise((r) => setTimeout(r, 6_000)); // a full slow tick: sigma set, state read
  }, 120_000);

  afterAll(async () => {
    feed?.stop();
    rig?.stop();
    await anvil?.stop();
  });

  it("quotes a new partner market within 3 blocks although the slow tick is 5 s", async () => {
    const sdk = createConvergeClient({
      publicClient: stack.pub,
      walletClient: stack.partner,
      addresses: {
        registry: stack.addrs.registry,
        vault: stack.addrs.vault,
        venue: stack.addrs.venue,
        collateral: stack.addrs.usdc,
      },
    });
    // wait until a slow tick has just finished so that the next one is ~5 s away
    await new Promise((r) => setTimeout(r, 1_000));
    const end = (await stack.now()) + 15 * 60 + 60;
    const created = await sdk.createPartnerMarket({ asset: TEST_LABEL, strike: 3000, end });
    let at = 0n;
    await waitFor(
      async () => {
        const v = await stack.read<{ tradable: boolean }>(
          stack.addrs.vault,
          convergeVaultAbi,
          "venueView",
          [created.market],
        );
        if (v.tradable) at = await stack.pub.getBlockNumber();
        return v.tradable;
      },
      4_000, // less than the slow tick: only the kick can make it
      "the vault to quote the new partner market before the next slow tick",
      40,
    );
    expect(Number(at - created.blockNumber)).toBeLessThanOrEqual(3);
  }, 60_000);
});
