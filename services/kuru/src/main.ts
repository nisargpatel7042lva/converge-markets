/**
 * Converge x Kuru lister (TESTNET). Every 15-minute Converge round has an UP token: an ERC-20 that pays
 * 1 collateral if the round ends above its strike. This service lists that token on Kuru's order book
 * (permissionless market creation), seeds it by splitting collateral into UP + DOWN, and quotes both
 * sides around the same fair probability the Converge vault uses, so a new class of asset (a 15-minute
 * binary outcome that converges to 0 or 1) trades on Kuru's book next to the vault's own pricing.
 *
 *   pnpm --filter @converge/kuru lister -- --rounds 3
 */
import { parseArgs } from "node:util";
import { formatEther } from "viem";
import { makeCtx } from "./chain";
import { loadDeployment, makerKey, refPrice, rpcUrl, STATE_PATH } from "./config";
import {
  closeRound,
  DEFAULT_SIZING,
  ensureListed,
  fairNow,
  readRounds,
  redeemRound,
  requote,
  seed,
} from "./lister";
import { DEFAULT_POLICY, KURU_TESTNET, needsRequote } from "./kuru";
import { loadState, saveState, type KuruState } from "./state";

const { values } = parseArgs({
  options: {
    rounds: { type: "string", default: "2" },
    "reserve-mon": { type: "string", default: "0.6" },
    once: { type: "boolean", default: false },
  },
});
const MAX_ROUNDS = Number(values.rounds);
const RESERVE = BigInt(Math.round(Number(values["reserve-mon"]) * 1e18));
const log = (s: string) => console.log(`[kuru ${new Date().toISOString().slice(11, 19)}] ${s}`);

const dep = loadDeployment();
const ctx = makeCtx(rpcUrl(), makerKey(), log);
const state = loadState(STATE_PATH, () => ({
  chainId: 10143,
  router: KURU_TESTNET.router,
  marginAccount: KURU_TESTNET.marginAccount,
  maker: ctx.me,
  rounds: {},
}));
const save = () => saveState(STATE_PATH, state);

async function tick(): Promise<void> {
  const { now, rounds } = await readRounds(ctx, dep);
  const spot = await refPrice();
  const listedNew = Object.keys(state.rounds).length;
  for (const r of rounds) {
    const key = r.converge.toLowerCase();
    let kr = state.rounds[key];
    const remaining = r.end - now;
    if (!kr) {
      // only list a round that is open (strike known) with enough time to be worth quoting
      if (r.state !== 1 || remaining < 300 || listedNew >= MAX_ROUNDS) continue;
      const bal = await ctx.pub.getBalance({ address: ctx.me });
      if (bal < RESERVE) {
        log(
          `balance ${formatEther(bal)} MON is below the ${formatEther(RESERVE)} reserve: not listing`,
        );
        continue;
      }
      kr = await ensureListed(ctx, dep, state, r);
      save();
    }
    if (kr.status === "listed") {
      await seed(ctx, dep, kr, DEFAULT_SIZING);
      save();
    }
    if (kr.status === "quoting") {
      if (remaining <= 20) {
        await closeRound(ctx, dep, kr);
        save();
        log(`closed ${kr.converge.slice(0, 8)}: quotes pulled, margin withdrawn`);
        continue;
      }
      const fair = await fairNow(ctx, dep, r, now, spot);
      if (
        fair !== null &&
        needsRequote(kr.orderIds.length === 0 ? null : kr.lastQuote, fair, now, DEFAULT_POLICY)
      ) {
        const bal = await ctx.pub.getBalance({ address: ctx.me });
        if (bal < RESERVE / 3n) {
          log("MON nearly out: holding the current quote");
        } else if (await requote(ctx, kr, fair, now, DEFAULT_SIZING)) {
          save();
          const q = kr.lastQuote;
          log(
            kr.orderIds.length === 0 || !q
              ? `pulled quotes: fair ${fair.toFixed(3)} is outside the quoting band (${remaining}s left)`
              : `quote ${q.bid.toFixed(3)} / ${q.ask.toFixed(3)} around fair ${fair.toFixed(3)} (${remaining}s left)`,
          );
        }
      }
    }
  }
  for (const kr of Object.values(state.rounds)) {
    if (kr.status === "closed" && (await redeemRound(ctx, kr))) {
      save();
      log(`redeemed ${kr.converge.slice(0, 8)}`);
    }
  }
}

async function main(): Promise<void> {
  log(`maker ${ctx.me}, up to ${MAX_ROUNDS} rounds, reserve ${formatEther(RESERVE)} MON`);
  for (;;) {
    try {
      await tick();
    } catch (e) {
      log(`tick failed: ${(e as Error).message.split("\n")[0]}`);
    }
    const open = Object.values(state.rounds).filter((r) => r.status !== "redeemed");
    if (values.once) break;
    if (Object.keys(state.rounds).length >= MAX_ROUNDS && open.length === 0) {
      log("done: every round listed, closed and redeemed");
      break;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
}

void main();
export type { KuruState };
