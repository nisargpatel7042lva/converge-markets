import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  TestSignerStreamsSource,
  dataStreamsResolverAbi,
  marketAbi,
  mockErc20Abi,
} from "@converge/sdk";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDemoFlow, type FlowEvidence } from "../../../../examples/partner-demo/lib/flow";
import { startAnvil, type Anvil } from "../support/anvil";
import { makeRig, type Rig } from "../support/rig";
import { KEYS, TEST_LABEL, U, deployStack, type Stack } from "../support/stack";

/**
 * The partner-demo journey (examples/partner-demo/lib/flow.ts, the same function the testnet CLI
 * runs) against the real contracts and the real keeper on a local anvil chain. With EVIDENCE_OUT set
 * it writes what happened (blocks to quote, prices, fill, resolution, payout) as JSON.
 */
describe("partner-demo journey on anvil", () => {
  let anvil: Anvil;
  let stack: Stack;
  let rig: Rig;
  let feed: ReturnType<Rig["feed"]>;
  const px = { v: 3000 };

  beforeAll(async () => {
    anvil = await startAnvil();
    stack = await deployStack(anvil.url);
    await stack.fund(1000);
    rig = makeRig(stack);
    feed = rig.feed(() => px.v);
    await rig.keeper.start();
    await new Promise((r) => setTimeout(r, 3_000));
  }, 120_000);

  afterAll(async () => {
    feed?.stop();
    rig?.stop();
    await anvil?.stop();
  });

  it("create, quote, trade, resolve, redeem with only the public SDK", async () => {
    const steps: string[] = [];
    const takerWallet = createWalletClient({
      account: privateKeyToAccount(KEYS.taker),
      chain: stack.chain,
      transport: http(stack.url),
    });
    let endTime = 0;
    const ev: FlowEvidence = await runDemoFlow({
      publicClient: stack.pub,
      partnerWallet: stack.partner,
      takerWallet,
      addresses: {
        registry: stack.addrs.registry,
        vault: stack.addrs.vault,
        venue: stack.addrs.venue,
        collateral: stack.addrs.usdc,
      },
      asset: TEST_LABEL,
      strike: String(px.v),
      spot: px.v,
      durationSec: 15 * 60 + 40,
      buyUsd: "3",
      reports: new TestSignerStreamsSource(
        privateKeyToAccount(KEYS.signer),
        async (ts) =>
          BigInt(Math.round((Number(ts) >= endTime && endTime > 0 ? px.v * 1.01 : px.v) * 1e8)) *
          10n ** 10n,
      ),
      chainNow: () => stack.now(),
      waitUntil: async (end) => {
        endTime = end;
        px.v = 3030; // the price moves above the strike before the end: the keeper's feed agrees
        await new Promise((r) => setTimeout(r, 1_000)); // the keeper's price sources catch up
        const now = await stack.now();
        await stack.warp(Math.max(1, end - now + 1));
      },
      fundTaker: async () => {
        await stack.tx(stack.admin, {
          address: stack.addrs.usdc,
          abi: mockErc20Abi,
          functionName: "mint",
          args: [stack.taker.account.address, 100n * U],
        });
      },
      onStep: (s, d) => steps.push(`${s} ${JSON.stringify(d)}`),
    });

    // the acceptance criteria of the journey, asserted
    expect(ev.blocksToQuote).toBeLessThanOrEqual(3);
    expect(ev.quotes.upAsk).not.toBeNull();
    expect(ev.quotes.upBid).not.toBeNull();
    expect(ev.quotes.downAsk).not.toBeNull();
    expect(ev.quotes.upAsk!).toBeGreaterThan(ev.quotes.upBid!);
    expect(ev.fill.status).toBe("EXECUTED");
    expect(BigInt(ev.fill.filled)).toBeGreaterThan(0n);
    expect(ev.fillsSeenBySubscription).toBeGreaterThanOrEqual(1);
    expect(ev.resolution.status).toBe("RESOLVED_UP");
    // UP won: the end price is at or above the strike (a tie goes UP)
    expect(BigInt(ev.resolution.endPrice ?? 0)).toBeGreaterThanOrEqual(
      BigInt(ev.strike) * 10n ** 18n,
    );
    expect(ev.redeemTx).not.toBeNull();
    // bought UP at a premium below 1 and it won: the trader is up, by about (1 - price) less the 0.5 % fee
    expect(ev.takerNetUsd).toBeGreaterThan(0);
    expect(ev.final.partner?.toLowerCase()).toBe(stack.partner.account.address.toLowerCase());

    // Who did what at the end: the vault's keeper and the SDK both submit the end price and both
    // try to finalize, and the first one wins each step. The evidence says which, instead of
    // implying the SDK did everything.
    const keeperAddr = stack.keeperAccount.address.toLowerCase();
    const who = (from: string) =>
      from.toLowerCase() === keeperAddr ? "the vault's keeper" : "the SDK resolve() call";
    const proposed = await stack.pub.getContractEvents({
      address: stack.addrs.streams,
      abi: dataStreamsResolverAbi,
      eventName: "ReportProposed",
      fromBlock: BigInt(ev.createdAtBlock),
    });
    const endProposal = proposed.find((l) => Number(l.args.timestamp) === ev.resolution.endTime);
    const proposedBy = endProposal
      ? who((await stack.pub.getTransaction({ hash: endProposal.transactionHash as Hex })).from)
      : "unknown";
    const resolvedLogs = await stack.pub.getContractEvents({
      address: ev.market,
      abi: marketAbi,
      eventName: "Resolved",
      fromBlock: BigInt(ev.createdAtBlock),
    });
    const finalizedBy = who(
      (await stack.pub.getTransaction({ hash: resolvedLogs[0]!.transactionHash as Hex })).from,
    );

    if (process.env.EVIDENCE_OUT) {
      mkdirSync(dirname(process.env.EVIDENCE_OUT), { recursive: true });
      writeFileSync(
        process.env.EVIDENCE_OUT,
        JSON.stringify(
          {
            network: "local anvil (0.4 s blocks), real contracts, real keeper, test-signer oracle",
            generatedBy: "services/keeper/test/integration/partner-demo-flow.test.ts",
            steps,
            endPriceSubmittedBy: proposedBy,
            finalizedBy,
            ...ev,
          },
          null,
          2,
        ),
      );
    }
  }, 240_000);
});
