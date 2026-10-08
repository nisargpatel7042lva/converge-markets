import {
  TestSignerStreamsSource,
  convergeVaultAbi,
  createConvergeClient,
  partnerRegistryAbi,
  type ConvergeClient,
  type Fill,
} from "@converge/sdk";
import { createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAnvil, type Anvil } from "../support/anvil";
import { counter, makeRig, waitFor, type Rig } from "../support/rig";
import { ASSET_ID, KEYS, TEST_LABEL, U, deployStack, type Stack } from "../support/stack";

/**
 * Liquidity-as-a-service end to end on a local anvil (0.4 s blocks): the real contracts (vault v4,
 * PartnerRegistry), the real keeper, and every user action through the PUBLIC SDK only
 * (createPartnerMarket, getMarket, getQuotes, buy, sell, waitForFill, subscribeFills, resolve,
 * redeem). Ledger of what it proves: ADR-008 / docs/partners.md.
 */
describe("partner markets on anvil (public SDK, real keeper)", () => {
  let anvil: Anvil;
  let stack: Stack;
  let rig: Rig;
  let feed: ReturnType<Rig["feed"]>;
  let partnerSdk: ConvergeClient;
  let takerSdk: ConvergeClient;
  const px = { v: 3000 };
  const fills: Fill[] = [];
  let stopFills: () => void = () => undefined;
  let m1: Address;
  let m1End: number;
  let m2: Address;
  let m4: Address;

  const view = (m: Address) =>
    stack.read<{ tradable: boolean }>(stack.addrs.vault, convergeVaultAbi, "venueView", [m]);
  const tryUntilExecuted = async (
    place: () => Promise<{ orderId: bigint; blockNumber: bigint }>,
  ) => {
    for (let attempt = 1; ; attempt++) {
      const order = await place();
      const r = await takerSdk.waitForFill(order.orderId, {
        timeoutMs: 30_000,
        fromBlock: order.blockNumber,
      });
      if (r.status === "EXECUTED" || attempt >= 3) return r;
      console.log(
        `order ${order.orderId} expired unexecuted (attempt ${attempt}): placing it again`,
      );
    }
  };
  const basisOf = async (m: Address) =>
    (
      await stack.read<readonly [bigint, bigint]>(
        stack.addrs.vault,
        convergeVaultAbi,
        "positionOf",
        [m],
      )
    )[0];

  beforeAll(async () => {
    anvil = await startAnvil();
    stack = await deployStack(anvil.url);
    await stack.fund(1000);
    rig = makeRig(stack, { log: Boolean(process.env.RIG_LOG) });
    feed = rig.feed(() => px.v);
    await rig.keeper.start();

    const addresses = {
      registry: stack.addrs.registry,
      vault: stack.addrs.vault,
      venue: stack.addrs.venue,
      collateral: stack.addrs.usdc,
    };
    partnerSdk = createConvergeClient({
      publicClient: stack.pub,
      walletClient: stack.partner,
      addresses,
    });
    takerSdk = createConvergeClient({
      publicClient: stack.pub,
      walletClient: createWalletClient({
        account: privateKeyToAccount(KEYS.taker),
        chain: stack.chain,
        transport: http(stack.url),
      }),
      addresses,
    });
    // the taker has funds and gas
    await stack.tx(stack.admin, {
      address: stack.addrs.usdc,
      abi: [
        {
          type: "function",
          name: "mint",
          stateMutability: "nonpayable",
          inputs: [{ type: "address" }, { type: "uint256" }],
          outputs: [],
        },
      ] as const,
      functionName: "mint",
      args: [stack.taker.account.address, 100n * U],
    });
    // give the keeper a few seconds to set sigma and settle its first state
    await new Promise((r) => setTimeout(r, 3_000));
  }, 120_000);

  afterAll(async () => {
    stopFills();
    feed?.stop();
    rig?.stop();
    await anvil?.stop();
  });

  it("a partner creates a market with the SDK and the vault quotes it within a few blocks", async () => {
    const now = await stack.now();
    m1End = now + 15 * 60 + 40;
    const created = await partnerSdk.createPartnerMarket({
      asset: TEST_LABEL,
      strike: px.v,
      end: m1End,
    });
    m1 = created.market;
    const createdAtBlock = created.blockNumber;
    expect(created.strike).toBe(BigInt(px.v) * 10n ** 18n);

    let tradableAt = 0n;
    await waitFor(
      async () => {
        if ((await view(m1)).tradable) {
          tradableAt = await stack.pub.getBlockNumber();
          return true;
        }
        return false;
      },
      30_000,
      "the vault to quote the partner market",
      50,
    );
    const blocks = Number(tradableAt - createdAtBlock);
    // recorded in the Phase 8 evidence; the bound here is loose so that a slow CI box does not flake
    console.log(`partner market quoted ${blocks} blocks after creation`);
    expect(blocks).toBeLessThanOrEqual(3);

    const m = await partnerSdk.getMarket(m1);
    expect(m).toMatchObject({
      address: m1,
      status: "OPEN",
      strikeNumber: px.v,
      partner: stack.partner.account.address,
      active: true,
      quoting: true,
      redeemFeeBps: 50,
    });
    expect(m.phase.phase).toBe("LIVE");
  }, 60_000);

  it("each market gets a third of the partner's cap (40 USD), the total never passes it, a fourth market waits", async () => {
    const third = (40n * U) / 3n;
    expect(await basisOf(m1)).toBe(third);
    const make = async (strikeOffset: number) =>
      (
        await partnerSdk.createPartnerMarket({
          asset: TEST_LABEL,
          strike: px.v + strikeOffset,
          end: (await stack.now()) + 2 * 3600,
        })
      ).market;
    m2 = await make(100);
    const m3 = await make(200);
    await waitFor(
      async () => (await view(m2)).tradable && (await view(m3)).tradable,
      20_000,
      "the second and third market to be quoted",
    );
    expect(await basisOf(m2)).toBe(third);
    expect(await basisOf(m3)).toBe(third);
    // a fourth market: the partner holds three registry slots and its cap is spoken for
    m4 = await make(300);
    await new Promise((r) => setTimeout(r, 4_000));
    expect(await basisOf(m4)).toBe(0n);
    expect((await view(m4)).tradable).toBe(false);
    const p = await stack.read<{ exposureCap: bigint }>(
      stack.addrs.registry,
      partnerRegistryAbi,
      "partnerOf",
      [stack.partner.account.address],
    );
    expect((await basisOf(m1)) + (await basisOf(m2)) + (await basisOf(m3))).toBeLessThanOrEqual(
      p.exposureCap,
    );
    expect(
      await counter(rig.metrics, "keeper_tx_sent_total", {
        kind: "splitForInventory",
        result: "sim_revert",
      }),
    ).toBe(0);
  }, 60_000);

  it("shows two-sided quotes and a position changes hands through the SDK", async () => {
    const spot = px.v;
    const q = await takerSdk.getQuotes(m1, { spot });
    expect(q.quoting).toBe(true);
    expect(q.up.ask && q.up.bid).toBeTruthy();
    expect(q.down.ask && q.down.bid).toBeTruthy();
    expect(q.up.ask!.price).toBeGreaterThan(q.up.bid!.price);
    // the two outcomes' asks add up to more than 1 (the spread is the vault's income)
    expect(q.up.ask!.price + q.down.ask!.price).toBeGreaterThan(1);

    stopFills = takerSdk.subscribeFills({ market: m1, pollMs: 200 }, (f) => fills.push(f));
    await new Promise((r) => setTimeout(r, 600));

    // An order nobody executes inside its 4 s window expires and refunds; on a loaded machine that
    // happens, and a user would simply place it again (the product behaviour, kept honest here).
    const filled = await tryUntilExecuted(() =>
      takerSdk.buy({ market: m1, side: "UP", amount: "3", spot }),
    );
    expect(filled.status).toBe("EXECUTED");
    expect(filled.filled).toBeGreaterThan(0n);
    expect(filled.premium).toBeGreaterThan(0n);

    const pos = await takerSdk.getPosition(m1);
    expect(pos.up).toBe(filled.filled);

    const sold = await tryUntilExecuted(() =>
      takerSdk.sell({ market: m1, side: "UP", shares: filled.filled / 2n, spot }),
    );
    expect(sold.status).toBe("EXECUTED");
    expect(sold.filled).toBeGreaterThan(0n);

    await waitFor(() => fills.length >= 2, 10_000, "the fills subscription");
    expect(fills[0]).toMatchObject({ market: m1, side: "UP", action: "BUY", source: "chain" });
    expect(fills.some((f) => f.action === "SELL")).toBe(true);
  }, 90_000);

  it("resolves through the SDK, the winner redeems, and the vault takes its inventory back", async () => {
    const before = (await takerSdk.getPosition(m1)).up;
    expect(before).toBeGreaterThan(0n);
    // the clock reaches the end; the price is above the strike, so UP wins
    const now = await stack.now();
    await stack.warp(Math.max(1, m1End - now + 1));
    const reports = new TestSignerStreamsSource(privateKeyToAccount(KEYS.signer), async (ts) =>
      Number(ts) >= m1End ? 3100n * 10n ** 18n : 3000n * 10n ** 18n,
    );
    const status = await takerSdk.resolve(m1, { reports, timeoutMs: 60_000 });
    expect(status).toBe("RESOLVED_UP");

    const usdcBefore = await stack.read<bigint>(
      stack.addrs.usdc,
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
      [stack.taker.account.address],
    );
    const pos = await takerSdk.getPosition(m1);
    expect(pos.claimable).toBe(pos.up);
    await takerSdk.redeem(m1);
    const usdcAfter = await stack.read<bigint>(
      stack.addrs.usdc,
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
      [stack.taker.account.address],
    );
    // 50 bps of the payout goes to the registry (partner share + treasury)
    expect(usdcAfter - usdcBefore).toBe(pos.up - (pos.up * 50n) / 10_000n);
    expect((await takerSdk.getPosition(m1)).up).toBe(0n);

    // the keeper redeems what the vault holds and frees the registry slot
    await waitFor(
      async () =>
        !(await stack.read<boolean>(stack.addrs.vault, convergeVaultAbi, "isRegistered", [m1])),
      30_000,
      "the vault to redeem the resolved partner market",
    );
  }, 150_000);

  it("then the freed slot goes to the partner's fourth market", async () => {
    await waitFor(async () => (await view(m4)).tradable, 40_000, "the fourth market to be quoted");
    expect(await basisOf(m4)).toBeGreaterThan(0n);
    expect(await basisOf(m4)).toBeLessThanOrEqual((40n * U) / 3n);
  }, 60_000);

  it("never sent an allocation the vault would refuse, and nothing went wrong", async () => {
    // The planner mirrors the caps, so no split or merge was ever refused in simulation. The one
    // simulated revert that can happen is the keeper's resolve losing the race to the SDK's.
    for (const kind of ["splitForInventory", "mergeInventory", "redeemResolved", "setSigma"]) {
      expect(
        await counter(rig.metrics, "keeper_tx_sent_total", { kind, result: "sim_revert" }),
        kind,
      ).toBe(0);
    }
    expect(await counter(rig.metrics, "keeper_errors_total", { kind: "perform" })).toBe(0);
    expect(await counter(rig.metrics, "keeper_errors_total", { kind: "unhandled_rejection" })).toBe(
      0,
    );
    expect(rig.keeper.violationLog).toEqual([]);
    // a time jump (the test warps the chain) can make the price sources look stale for a moment
    // and the keeper pulls its quotes until they recover: that is its job, so wait for it
    await waitFor(() => !rig.keeper.status().halted, 20_000, "the keeper to put its quotes back");
  });

  it("keeps the asset id the partner used", () => {
    expect(ASSET_ID).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
