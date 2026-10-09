"use client";
import { useMemo } from "react";
import { fairProbUp, SECONDS_PER_YEAR } from "@converge/strategy";
import { askFromLadder, planBuy, type Side } from "@converge/sdk";
import type { Round } from "./data";
import { nowSecFloat } from "./clock";
import { usePrice } from "./prices";
import { useLadder, useNow, useSigma } from "./queries";
import { useEffect, useState } from "react";

const WAD = 10n ** 18n;
/** Ladder sizes are WAD-scaled token amounts; shares are 6-decimal base units. */
const SIZE_TO_SHARES = 10n ** 12n;
/** The keeper refuses a fill that would use more than 90 % of a market's loss ceiling: stay clear of it. */
const DEPTH_USE = 80n;

export type LiveMarket = {
  /** The composite spot (mean of the fresh exchanges), or null. */
  spot: number | null;
  live: boolean;
  /** Probability that UP wins, moving with every price tick; null until the odds can be computed. */
  prob: number | null;
  /** Share prices in dollars, moving with the odds between ladder reads (null: not quoting). */
  upAsk: number | null;
  downAsk: number | null;
  quoting: boolean;
  ladder: ReturnType<typeof useLadder>["data"];
  ladderReady: boolean;
  isError: boolean;
};

/**
 * Everything a live round needs on screen, without waiting for the network on every tick: the price
 * comes from the exchanges (four times a second), the odds are the same formula the vault uses
 * (`fairProbUp`, with the keeper's on-chain volatility, read every 30 s), and the share prices are
 * the vault's last ladder shifted by how far the odds have moved since it was read. The ladder itself
 * is re-read every 2 s to correct any drift. So the numbers move as fast as the market does.
 */
export function useLiveMarket(round: Round | undefined): LiveMarket {
  const px = usePrice(round?.series);
  const ladderQ = useLadder(round, round?.state === 1 ? px.price : null);
  const sigma = useSigma(round?.series.assetId);
  const tick = useFastClock(250);
  void tick;

  return useMemo(() => {
    const strike = round && round.strike > 0n ? Number(round.strike) / 1e18 : null;
    const ladder = ladderQ.data;
    let prob: number | null = null;
    if (round && px.price && strike && sigma.data) {
      const tau = Math.max(0, round.end - nowSecFloat()) / SECONDS_PER_YEAR;
      try {
        prob = fairProbUp(px.price, strike, sigma.data, tau);
      } catch {
        prob = null;
      }
    }
    const fairAtLadder = ladder ? Number(ladder.fair) / 1e18 : null;
    const delta =
      prob !== null && fairAtLadder !== null && ladder?.quoting ? prob - fairAtLadder : 0;
    const clamp = (x: number) => Math.min(0.99, Math.max(0.01, x));
    let upAsk: number | null = null;
    let downAsk: number | null = null;
    if (ladder?.quoting) {
      const ua = askFromLadder("UP", ladder);
      const da = askFromLadder("DOWN", ladder);
      if (ua) upAsk = clamp(Number(ua.priceWad) / 1e18 + delta);
      if (da) downAsk = clamp(Number(da.priceWad) / 1e18 - delta);
    }
    return {
      spot: px.price,
      live: px.live,
      prob: prob ?? (ladder?.quoting ? Number(ladder.fair) / 1e18 : null),
      upAsk,
      downAsk,
      quoting: Boolean(ladder?.quoting),
      ladder,
      ladderReady: ladderQ.isSuccess,
      isError: ladderQ.isError,
    };
  }, [
    round,
    px.price,
    px.live,
    ladderQ.data,
    ladderQ.isSuccess,
    ladderQ.isError,
    sigma.data,
    tick,
  ]);
}

/** Forces a re-render a few times a second (the odds depend on the seconds left). */
function useFastClock(ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return n;
}

/**
 * How much of `side` the vault can fill right now at or below the price limit, in 6-decimal shares,
 * with a safety margin so the keeper never has to turn the order down for being too big.
 */
export function depthShares(
  side: Side,
  ladder: NonNullable<LiveMarket["ladder"]>,
  limitWad: bigint,
): bigint {
  let total = 0n;
  const levels = side === "UP" ? ladder.asks : ladder.bids;
  for (const l of levels) {
    const p = side === "UP" ? l.price : WAD - l.price;
    if (p > limitWad) break;
    total += l.size / SIZE_TO_SHARES;
  }
  return (total * DEPTH_USE) / 100n;
}

/** The largest bet (collateral base units) that fits the depth, given the share price and tolerance. */
export function maxBudget(
  side: Side,
  ladder: LiveMarket["ladder"],
  priceWad: bigint,
  slippageBps: number,
): bigint | null {
  if (!ladder?.quoting) return null;
  const probe = planBuy({ side, budget: 1_000_000n, priceWad, slippageBps });
  const shares = depthShares(side, ladder, probe.limitWad);
  // escrow = shares * limit + slack: the budget that buys exactly `shares` at the limit
  const budget = (shares * probe.limitWad) / WAD;
  return budget > 4n ? budget : 0n;
}

export const useRoundNow = useNow;
