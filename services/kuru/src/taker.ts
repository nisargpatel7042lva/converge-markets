/**
 * Kuru taker demo (TESTNET): a separate wallet buys the Converge UP token from the maker's quote on
 * Kuru's order book, then sells it back, to show a real fill on both sides of a listed round.
 *
 *   pnpm --filter @converge/kuru taker -- --usd 2
 *
 * The taker key is generated once into .testnet/taker.key (untracked) and funded with a little MON by
 * the maker wallet, so the fill is between two different accounts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { formatEther, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { mockErc20Abi } from "@converge/sdk";
import { makeCtx, read, send } from "./chain";
import { loadDeployment, makerKey, root, rpcUrl, STATE_PATH } from "./config";
import { fromBookPrice, orderBookAbi } from "./kuru";
import { loadState } from "./state";

const { values } = parseArgs({ options: { usd: { type: "string", default: "2" } } });
const log = (s: string) => console.log(`[taker ${new Date().toISOString().slice(11, 19)}] ${s}`);
const dep = loadDeployment();
const maker = makeCtx(rpcUrl(), makerKey(), log);
const keyPath = `${root}.testnet/taker.key`;
if (!existsSync(keyPath)) writeFileSync(keyPath, generatePrivateKey(), { mode: 0o600 });
const taker = makeCtx(rpcUrl(), readFileSync(keyPath, "utf8").trim() as Hex, log);

const state = loadState(STATE_PATH, () => {
  throw new Error("no deployments/kuru-testnet.json: run the lister first");
});
const found = Object.values(state.rounds)
  .filter((r) => r.status === "quoting" && r.orderIds.length === 2)
  .sort((a, b) => b.start - a.start)[0];
if (!found) throw new Error("no round is being quoted right now");
const live = found;

const usd = Number(values.usd);
const tokens = async (a: Address, who: Address) =>
  read<bigint>(taker, a, mockErc20Abi, "balanceOf", [who]);
const evidence: { step: string; hash: Hex; detail: string }[] = [];

async function main(): Promise<void> {
  if ((await taker.pub.getBalance({ address: taker.me })) < parseEther("0.05")) {
    const hash = await maker.wallet.sendTransaction({
      account: maker.wallet.account!,
      chain: maker.wallet.chain,
      to: taker.me,
      value: parseEther("0.2"),
      gas: 21_000n,
    });
    await maker.pub.waitForTransactionReceipt({ hash });
    log(`funded the taker wallet ${taker.me} with 0.2 MON`);
  }
  const [bid, ask] = await read<readonly [bigint, bigint]>(
    taker,
    live.kuru,
    orderBookAbi,
    "bestBidAsk",
  );
  log(
    `book on Kuru: best bid ${fromBookPrice(bid).toFixed(3)} / best ask ${fromBookPrice(ask).toFixed(3)} (market ${live.kuru})`,
  );

  const mint = await send(taker, {
    address: dep.collateral_tUSDC,
    abi: mockErc20Abi,
    functionName: "mint",
    args: [taker.me, BigInt(Math.round(usd * 2e6))],
  });
  const appr = await send(taker, {
    address: dep.collateral_tUSDC,
    abi: mockErc20Abi,
    functionName: "approve",
    args: [live.kuru, 2n ** 256n - 1n],
  });
  const apprUp = await send(taker, {
    address: live.up,
    abi: mockErc20Abi,
    functionName: "approve",
    args: [live.kuru, 2n ** 256n - 1n],
  });
  evidence.push({
    step: "taker mints + approves test collateral",
    hash: mint.hash,
    detail: `approve ${appr.hash}, approve UP ${apprUp.hash}`,
  });

  const upBefore = await tokens(live.up, taker.me);
  const buy = await send(taker, {
    address: live.kuru,
    abi: orderBookAbi,
    functionName: "placeAndExecuteMarketBuy",
    args: [BigInt(Math.round(usd * 10_000)), 0n, false, true],
  });
  const got = (await tokens(live.up, taker.me)) - upBefore;
  const avg = got > 0n ? usd / (Number(got) / 1e6) : NaN;
  log(
    `BOUGHT ${(Number(got) / 1e6).toFixed(4)} UP for $${usd} at an average ${avg.toFixed(4)} (tx ${buy.hash})`,
  );
  evidence.push({
    step: "market buy of the UP token on Kuru",
    hash: buy.hash,
    detail: `${Number(got) / 1e6} UP for $${usd}, avg ${avg.toFixed(4)}`,
  });

  if (got > 0n) {
    const usdBefore = await tokens(dep.collateral_tUSDC, taker.me);
    // _size is in sizePrecision units (1e4 per whole token); the token has 6 decimals
    const sell = await send(taker, {
      address: live.kuru,
      abi: orderBookAbi,
      functionName: "placeAndExecuteMarketSell",
      args: [(got / 100n) as unknown as bigint, 0n, false, false],
    });
    const back = (await tokens(dep.collateral_tUSDC, taker.me)) - usdBefore;
    log(`SOLD back for $${(Number(back) / 1e6).toFixed(4)} (tx ${sell.hash})`);
    evidence.push({
      step: "market sell back to the book",
      hash: sell.hash,
      detail: `received $${Number(back) / 1e6}`,
    });
  }

  const dir = `${root}docs/evidence/kuru`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    `${dir}/taker-fill.json`,
    JSON.stringify(
      {
        market: live.kuru,
        round: live.converge,
        taker: taker.me,
        bestBid: fromBookPrice(bid),
        bestAsk: fromBookPrice(ask),
        steps: evidence,
        balanceMon: formatEther(await taker.pub.getBalance({ address: taker.me })),
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((e) => {
  console.error(`taker failed: ${(e as Error).message.split("\n")[0]}`);
  process.exit(1);
});
