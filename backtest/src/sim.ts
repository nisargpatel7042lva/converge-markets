/**
 * Economic simulation of the Converge vault (ADR-001, Option D) against historical prices.
 *
 * What is simulated, in time order, every 400 ms block:
 *   1. The keeper observes the price `latencyMs` ago (sample-and-hold, no interpolation) and runs
 *      the SAME `generateQuotes` / `shouldRepost` code the production keeper will run.
 *   2. If the posting rule fires, the new quotes replace the posted ones and one batched update's
 *      gas is charged. Takers only ever see POSTED quotes, which go stale between posts, and a
 *      level that was filled stays empty until the next post.
 *   3. Informed takers see the current bar (the vault sees an older one) and take every level
 *      whose net edge beats their threshold; noise takers arrive by Poisson and walk the book.
 *   4. At each boundary the round settles exactly like Market.sol: UP iff endPrice >= strike.
 *
 * Causality: nothing in a decision uses data newer than its timestamp. The vault's inputs come
 * from bars at or before (t − latencyMs); the strike and end price are the bars at the exact
 * boundary seconds.
 */
import {
  applyFill,
  drawdownBreaker,
  EwmaVol,
  fairProbUp,
  generateQuotes,
  lossCeiling,
  maxLoss,
  RollingRange,
  sellRoom,
  buyRoom,
  SECONDS_PER_YEAR,
  shouldRepost,
  summarize,
  type Position,
  type PostedQuote,
  type QuoteSet,
} from "@converge/strategy";
import { addDays } from "./data/binance";
import { indexAtOrBefore, type PriceSeries } from "./data/series";
import { blockBootstrapCi, maxDrawdown, mean, quantile, sharpeDaily, std } from "./metrics";
import { hashSeed, Rng } from "./rng";
import type { DailyRow, RunResult, SimConfig } from "./types";

const DAY_MS = 86_400_000;
/**
 * Blocks fall 100 ms after whole seconds. Bars close on whole seconds and blocks come every
 * 400 ms, so with no offset every fifth block would sit exactly on a bar edge and the share of
 * blocks where a lead of L ms matters would be biased upward for small L. The offset makes that
 * share unbiased on average.
 */
const BLOCK_PHASE_MS = 100;

/** Market.sol: UP iff endPrice >= strike (a tie goes UP). */
export function isUp(endPrice: number, strike: number): boolean {
  return endPrice >= strike;
}

type AssetRT = {
  label: string;
  series: PriceSeries;
  vol: EwmaVol;
  range: RollingRange;
  /** Last bar index fed to the vault's estimators. */
  fed: number;
};

type Accum = {
  edgeNoise: number;
  edgeInformed: number;
  /** Σ sign·shares·pTrue over fills (sign +1 = vault sold UP). */
  weightedFair: number;
  volNoise: number;
  volInformed: number;
};

type Order =
  | { kind: "noise"; dueMs: number; buyUp: boolean; notional: number; tolerance: number }
  | { kind: "informed"; dueMs: number; expiresMs: number; buyUp: boolean; limit: number };

type MarketRT = {
  pending: Order[];
  asset: AssetRT;
  dur: number;
  key: string;
  startMs: number;
  endMs: number;
  openMs: number;
  strike: number;
  pos: Position;
  posted: QuoteSet | null;
  postedSummary: PostedQuote | null;
  bidRem: Float64Array;
  askRem: Float64Array;
  age: number;
  force: boolean;
  nextNoiseMs: number;
  nextInformedMs: number;
  rng: Rng;
  acc: Accum;
  lastFair: number;
  quotableBlocks: number;
  quotingBlocks: number;
  dayIndex: number;
};

type DayAgg = Omit<DailyRow, "day">;

export function simulate(cfg: SimConfig, data: Map<string, PriceSeries>): RunResult {
  const { params: P, flow, venue } = cfg;
  const BLOCK = venue.blockMs;
  const feeTaker = venue.takerFeeBps / 1e4;
  const gasUsdOf = (markets: number) =>
    (venue.gasBase + venue.gasPerMarket * markets) * venue.gasPriceGwei * 1e-9 * venue.monUsd;
  const fillGasUsd = venue.gasPerFill * venue.gasPriceGwei * 1e-9 * venue.monUsd;
  const limits = {
    perMarketMaxFraction: P.perMarketMaxFraction,
    totalAtRiskMaxFraction: P.totalAtRiskMaxFraction,
  };

  const assets: AssetRT[] = cfg.assets.map((label) => {
    const series = data.get(label);
    if (!series) throw new Error(`no data for ${label}`);
    return {
      label,
      series,
      vol: new EwmaVol(P.vol),
      range: new RollingRange(P.toxicityWindowSec),
      fed: -1,
    };
  });

  const meanSize =
    flow.noiseSizeMedianUsd * Math.exp((flow.noiseSizeSigma * flow.noiseSizeSigma) / 2);
  const noiseGapMs =
    flow.noiseUsdPerHourPerMarket > 0
      ? (3_600_000 * meanSize) / flow.noiseUsdPerHourPerMarket
      : Infinity;
  const informedGapMs =
    flow.informedMode === "arrivals" && flow.informedShare > 0
      ? (noiseGapMs * (1 - flow.informedShare)) / flow.informedShare
      : Infinity;

  // ---- evaluation days ----
  const stride = cfg.dayStride ?? 1;
  const offset = cfg.dayOffset ?? 0;
  const dayList: string[] = [];
  for (let d = cfg.startDay, i = 0; d < cfg.endDay; d = addDays(d, 1), i++) {
    if (i % stride === offset) dayList.push(d);
  }
  const dayAggs: DayAgg[] = dayList.map(() => ({
    pnl: 0,
    gasUsd: 0,
    edgeNoise: 0,
    edgeInformed: 0,
    residual: 0,
    rounds: 0,
    breakerTripped: false,
    feeIncome: 0,
    redeemFees: 0,
    noiseVolumeUsd: 0,
    informedVolumeUsd: 0,
  }));

  // ---- accumulators ----
  let realized = 0; // settled P&L, net of redeem fees
  let gasTotal = 0;
  let redeemFees = 0;
  let edgeNoise = 0;
  let edgeInformed = 0;
  let residual = 0;
  let noiseVol = 0;
  let informedVol = 0;
  let noiseFills = 0;
  let informedFills = 0;
  let noiseOrders = 0;
  let noiseUnfilled = 0;
  let informedOrders = 0;
  let informedTraded = 0;
  let informedPlaced = 0;
  let protocolFees = 0;
  let feeIncome = 0;
  let repostBlocks = 0;
  let quotable = 0;
  let quoting = 0;
  let peakAtRisk = 0;
  let tripDays = 0;
  const roundPnl: number[] = [];
  const inventory: number[] = [];
  const maxLossAtExpiry: number[] = [];
  const equity: number[] = [];
  const byMarket: RunResult["byMarket"] = {};
  let digest = 0x811c9dc5;
  const mix = (x: number) => {
    digest = Math.imul(digest ^ (x | 0), 0x01000193) >>> 0;
  };
  let nowMs = 0;

  /** Sum of worst-case losses over all live markets, recomputed on each call (no stale total). */
  function liveTotalLoss(): number {
    let t = 0;
    for (const x of slots) if (x) t += maxLoss(x.pos);
    return t;
  }

  function room(m: MarketRT, side: "sell" | "buy", price: number, nav: number): number {
    const ceiling = lossCeiling(m.pos, nav, liveTotalLoss() - maxLoss(m.pos), limits);
    return side === "sell" ? sellRoom(m.pos, price, ceiling) : buyRoom(m.pos, price, ceiling);
  }

  function record(
    m: MarketRT,
    kind: "noise" | "informed",
    sign: 1 | -1,
    shares: number,
    price: number,
    pTrue: number,
  ): void {
    m.acc.weightedFair += sign * shares * pTrue;
    // Taker dollars: UP at `price` when the vault sells UP, DOWN at `1 - price` when it buys UP.
    const notional = shares * (sign === 1 ? price : 1 - price);
    const fee = notional * feeTaker;
    if (!venue.feeToLp) protocolFees += fee;
    const e = sign * shares * (price - pTrue);
    const dayAgg = dayAggs[m.dayIndex]!;
    if (kind === "noise") dayAgg.noiseVolumeUsd += notional;
    else dayAgg.informedVolumeUsd += notional;
    if (kind === "noise") {
      m.acc.edgeNoise += e;
      m.acc.volNoise += notional;
      noiseFills++;
    } else {
      m.acc.edgeInformed += e;
      m.acc.volInformed += notional;
      informedFills++;
    }
    if (cfg.stopAtMs === undefined || nowMs < cfg.stopAtMs) {
      mix(Math.round(nowMs / 10));
      mix(m.dur);
      mix(m.asset.label.charCodeAt(0));
      mix(sign);
      mix(kind === "noise" ? 1 : 2);
      mix(Math.round(shares * 1e6));
      mix(Math.round(price * 1e6));
    }
    cfg.debugFill?.({
      tMs: nowMs,
      market: m.key,
      kind,
      sign,
      shares,
      price,
      pTrue,
      vaultFair: m.lastFair,
      tauSec: (m.endMs - nowMs) / 1000,
    });
    m.pos = applyFill(m.pos, sign === 1 ? "sell" : "buy", price, shares);
    if (venue.feeToLp) {
      // The fee is cash received by the vault, so it is in `cash` (and in settlement P&L).
      m.pos = { cash: m.pos.cash + fee, shortUp: m.pos.shortUp };
      feeIncome += fee;
      dayAgg.feeIncome += fee;
    }
    m.force = true; // the keeper sees the swap and refreshes the book next block
  }

  /**
   * Informed taker's decision against the book it sees now: it wants every level whose net edge
   * beats the threshold, so it submits a LIMIT order at the worst qualifying price.
   */
  function placeInformed(m: MarketRT, pTrue: number, dueMs: number): Order | null {
    const expiresMs = dueMs + venue.execWindowBlocks * BLOCK;
    const book = m.posted!;
    let limit = NaN;
    for (const lvl of book.up.asks) {
      if (pTrue - lvl.price * (1 + feeTaker) <= flow.informedEdgeThreshold) break;
      limit = lvl.price;
    }
    if (!Number.isNaN(limit)) return { kind: "informed", dueMs, expiresMs, buyUp: true, limit };
    for (const lvl of book.up.bids) {
      if (lvl.price * (1 - feeTaker) - pTrue <= flow.informedEdgeThreshold) break;
      limit = lvl.price;
    }
    if (!Number.isNaN(limit)) return { kind: "informed", dueMs, expiresMs, buyUp: false, limit };
    return null;
  }

  /** Noise taker: a random-side market order of lognormal notional with a cost cap. */
  function placeNoise(m: MarketRT, dueMs: number): Order {
    return {
      kind: "noise",
      dueMs,
      buyUp: m.rng.next() < 0.5,
      notional: m.rng.lognormal(flow.noiseSizeMedianUsd, flow.noiseSizeSigma),
      tolerance: Number.isFinite(flow.noiseToleranceMean)
        ? m.rng.exp(flow.noiseToleranceMean)
        : Infinity,
    };
  }

  /** Fills an order against the CURRENT posted book. Returns true if anything filled. */
  function execute(m: MarketRT, o: Order, pTrue: number, nav: number): boolean {
    const book = m.posted!;
    const levels = o.buyUp ? book.up.asks : book.up.bids;
    let filled = false;
    if (o.kind === "informed") {
      for (let j = 0; j < levels.length; j++) {
        const lvl = levels[j]!;
        if (o.buyUp ? lvl.price > o.limit : lvl.price < o.limit) break;
        const rem = o.buyUp ? m.askRem[j]! : m.bidRem[j]!;
        const shares = Math.min(rem, room(m, o.buyUp ? "sell" : "buy", lvl.price, nav));
        if (shares <= 1e-9) continue;
        if (o.buyUp) m.askRem[j]! -= shares;
        else m.bidRem[j]! -= shares;
        record(m, "informed", o.buyUp ? 1 : -1, shares, lvl.price, pTrue);
        filled = true;
      }
      return filled;
    }
    // The taker's notional is in the token it buys: UP at `price`, or DOWN at `1 - price` when the
    // vault buys UP. Cost is per $ of that token above its fair value.
    let notional = o.notional;
    for (let j = 0; j < levels.length && notional > 1e-9; j++) {
      const lvl = levels[j]!;
      const paid = o.buyUp ? lvl.price * (1 + feeTaker) : 1 - lvl.price * (1 - feeTaker);
      const fair = o.buyUp ? pTrue : 1 - pTrue;
      const unit = o.buyUp ? lvl.price : 1 - lvl.price;
      // The cost cap acts like a limit price: stop walking once a level costs more than it.
      if ((paid - fair) / paid > o.tolerance) break;
      const rem = o.buyUp ? m.askRem[j]! : m.bidRem[j]!;
      const shares = Math.min(
        rem,
        notional / unit,
        room(m, o.buyUp ? "sell" : "buy", lvl.price, nav),
      );
      if (shares <= 1e-9) continue;
      if (o.buyUp) m.askRem[j]! -= shares;
      else m.bidRem[j]! -= shares;
      notional -= shares * unit;
      record(m, "noise", o.buyUp ? 1 : -1, shares, lvl.price, pTrue);
      filled = true;
    }
    return filled;
  }

  /** Arrivals while there is nothing to trade against are lost (but still counted). */
  function drainArrivals(m: MarketRT, tMs: number): void {
    while (m.nextNoiseMs <= tMs) {
      m.nextNoiseMs += m.rng.exp(noiseGapMs);
      noiseOrders++;
      noiseUnfilled++;
    }
    if (flow.informedMode === "arrivals") {
      while (m.nextInformedMs <= tMs) {
        m.nextInformedMs += m.rng.exp(informedGapMs);
        informedOrders++;
      }
    }
  }

  function settle(m: MarketRT): void {
    const endIdx = indexAtOrBefore(m.asset.series, m.endMs / 1000);
    const endPx = m.asset.series.px[endIdx]!;
    const up = isUp(endPx, m.strike);
    const s = m.pos.shortUp;
    const gross = m.pos.cash - (up ? s : 0);
    const fee = (venue.redeemFeeBps / 1e4) * (s > 0 && !up ? s : s < 0 && up ? -s : 0);
    const net = gross - fee;
    // Outcome residual: Σ sign·u·(pTrue − 1{UP}); with the edge terms it sums to `gross`.
    const res = m.acc.weightedFair - s * (up ? 1 : 0);
    inventory.push(Math.abs(s));
    maxLossAtExpiry.push(maxLoss(m.pos));
    quotable += m.quotableBlocks;
    quoting += m.quotingBlocks;
    realized += net;
    redeemFees += fee;
    dayAggs[m.dayIndex]!.redeemFees += fee;
    edgeNoise += m.acc.edgeNoise;
    edgeInformed += m.acc.edgeInformed;
    residual += res;
    noiseVol += m.acc.volNoise;
    informedVol += m.acc.volInformed;
    roundPnl.push(net);
    const d = dayAggs[m.dayIndex]!;
    d.pnl += net;
    d.edgeNoise += m.acc.edgeNoise;
    d.edgeInformed += m.acc.edgeInformed;
    d.residual += res;
    d.rounds += 1;
    const b = (byMarket[m.key] ??= {
      rounds: 0,
      pnl: 0,
      edgeNoise: 0,
      edgeInformed: 0,
      residual: 0,
    });
    b.rounds++;
    b.pnl += net;
    b.edgeNoise += m.acc.edgeNoise;
    b.edgeInformed += m.acc.edgeInformed;
    b.residual += res;
  }

  // ---- main loop ----
  const slotMeta: { asset: AssetRT; dur: number }[] = [];
  for (const a of assets) for (const d of cfg.durations) slotMeta.push({ asset: a, dur: d });
  const slots: (MarketRT | null)[] = slotMeta.map(() => null);
  const blocksPerDay = DAY_MS / BLOCK;

  for (let di = 0; di < dayList.length; di++) {
    const dayStartMs = Date.parse(`${dayList[di]}T00:00:00Z`);
    const agg = dayAggs[di]!;
    let navMtm = cfg.nav0 + realized - gasTotal;
    const dayStartNav = navMtm;
    let tripped = false;

    for (let bi = 0; bi < blocksPerDay; bi++) {
      const tMs = dayStartMs + BLOCK_PHASE_MS + bi * BLOCK;
      nowMs = tMs;
      cfg.onBlock?.(tMs);
      if (cfg.stopAtMs !== undefined && tMs >= cfg.stopAtMs) break;

      // 1. the vault's estimators catch up to what it can have seen by (t − latency)
      for (const a of assets) {
        const idxV = indexAtOrBefore(a.series, (tMs - flow.latencyMs) / 1000);
        while (a.fed < idxV) {
          a.fed++;
          const tSec = a.series.t0 + a.fed * a.series.stepSec;
          const px = a.series.px[a.fed]!;
          a.vol.update(px, tSec);
          a.range.push(px, tSec);
        }
      }

      // 2. lifecycle: settle finished rounds, create the next ones
      for (let si = 0; si < slots.length; si++) {
        let m: MarketRT | null = slots[si] ?? null;
        if (m && tMs >= m.endMs) {
          settle(m);
          slots[si] = m = null;
        }
        if (!m) {
          const { asset, dur } = slotMeta[si]!;
          const durMs = dur * 1000;
          const startMs = Math.floor(tMs / durMs) * durMs;
          const openMs = startMs + venue.openDelaySec * 1000;
          const rng = new Rng(hashSeed(cfg.seed, asset.label, dur, startMs));
          slots[si] = {
            pending: [],
            asset,
            dur,
            key: `${asset.label} ${dur === 900 ? "15m" : "1h"}`,
            startMs,
            endMs: startMs + durMs,
            openMs,
            // The strike is the price at the boundary second; the market opens a little later.
            strike: asset.series.px[indexAtOrBefore(asset.series, startMs / 1000)]!,
            pos: { cash: 0, shortUp: 0 },
            posted: null,
            postedSummary: null,
            bidRem: new Float64Array(P.levels),
            askRem: new Float64Array(P.levels),
            age: 0,
            force: false,
            nextNoiseMs: Number.isFinite(noiseGapMs) ? openMs + rng.exp(noiseGapMs) : Infinity,
            nextInformedMs: Number.isFinite(informedGapMs)
              ? openMs + rng.exp(informedGapMs)
              : Infinity,
            rng,
            acc: { edgeNoise: 0, edgeInformed: 0, weightedFair: 0, volNoise: 0, volInformed: 0 },
            lastFair: 0.5,
            quotableBlocks: 0,
            quotingBlocks: 0,
            dayIndex: di,
          };
        }
      }

      // 3. NAV and the daily circuit breaker (every 3 blocks, about 1.2 s)
      if (bi % 3 === 0) {
        let mtm = cfg.nav0 + realized - gasTotal;
        for (const m of slots)
          if (m && tMs >= m.openMs) mtm += m.pos.cash - m.pos.shortUp * m.lastFair;
        navMtm = mtm;
        if (!tripped && drawdownBreaker(dayStartNav, navMtm, P.drawdownBreakerFraction).tripped) {
          tripped = true;
          tripDays++;
          agg.breakerTripped = true;
        }
        if (bi % 150 === 0) equity.push(navMtm);
      }

      // 4. quote, post, trade
      let totalLoss = 0;
      for (const m of slots) if (m) totalLoss += maxLoss(m.pos);
      if (navMtm > 0) peakAtRisk = Math.max(peakAtRisk, totalLoss / navMtm);
      let reposts = 0;
      for (const m of slots) {
        if (!m || tMs < m.openMs) continue;
        const a = m.asset;
        const idxV = indexAtOrBefore(a.series, (tMs - flow.latencyMs) / 1000);
        const tauSec = (m.endMs - tMs) / 1000;
        const quotableNow = tauSec > P.noQuoteWindowSec;
        if (quotableNow) m.quotableBlocks++;
        const sigma = a.vol.annualVol;
        const q = generateQuotes(
          {
            spot: a.series.px[idxV]!,
            strike: m.strike,
            tauSec,
            roundSec: m.dur,
            sigma,
            position: m.pos,
            nav: navMtm,
            otherAtRisk: liveTotalLoss() - maxLoss(m.pos),
            recentRangeBps: a.range.rangeBps,
            breakerTripped: tripped,
          },
          P,
        );
        m.lastFair = q.fair;
        const swapTime = venue.quoteMode === "swapTime";
        if (swapTime || m.force || shouldRepost(m.postedSummary, q, m.age, P)) {
          m.posted = q;
          m.postedSummary = summarize(q);
          m.bidRem.fill(0);
          m.askRem.fill(0);
          q.up.bids.forEach((l, j) => (m.bidRem[j] = l.size));
          q.up.asks.forEach((l, j) => (m.askRem[j] = l.size));
          m.age = 0;
          m.force = false;
          if (!swapTime) reposts++; // swap-time pricing has no keeper posts, hence no keeper gas
        } else {
          m.age++;
        }
        const book = m.posted;
        if (!book || book.status !== "quoting") {
          // Orders that come due while we are not quoting fail (a noise order is lost; an informed
          // order may keep trying until it expires). Orders not yet due are untouched.
          const keep: Order[] = [];
          for (const o of m.pending) {
            if (o.dueMs > tMs) keep.push(o);
            else if (o.kind === "noise") noiseUnfilled++;
            else if (o.expiresMs > tMs) keep.push(o);
          }
          m.pending = keep;
          drainArrivals(m, tMs);
          continue;
        }
        if (quotableNow) m.quotingBlocks++;
        // The true fair value is only needed when someone trades, so compute it on first use.
        let pTrueCache = NaN;
        const pTrue = (): number => {
          if (Number.isNaN(pTrueCache)) {
            pTrueCache = fairProbUp(
              a.series.px[indexAtOrBefore(a.series, tMs / 1000)]!,
              m.strike,
              sigma,
              Math.max(0, tauSec) / SECONDS_PER_YEAR,
            );
          }
          return pTrueCache;
        };
        const executed = (o: Order, ok: boolean) => {
          if (o.kind === "informed") {
            if (ok) informedTraded++;
          } else if (!ok) noiseUnfilled++;
          if (ok && venue.quoteMode === "swapTime") {
            gasTotal += fillGasUsd;
            dayAggs[m.dayIndex]!.gasUsd += fillGasUsd;
          }
        };
        // Orders placed earlier that are due now execute against THIS block's book.
        if (m.pending.length > 0) {
          const due = m.pending.filter((o) => o.dueMs <= tMs);
          if (due.length > 0) {
            const keep = m.pending.filter((o) => o.dueMs > tMs);
            for (const o of due) {
              let ok: boolean;
              if (o.kind === "informed" && venue.execWindowBlocks > 0) {
                // Timing option (stress): the sniper chooses WHEN to fire, so at every block of the
                // window it re-checks its edge with fresh information against the current book.
                const fresh = placeInformed(m, pTrue(), tMs);
                ok = fresh ? execute(m, fresh, pTrue(), navMtm) : false;
              } else ok = execute(m, o, pTrue(), navMtm);
              executed(o, ok);
              // Single-shot unless the stress option lets an informed order wait for a better block.
              if (o.kind === "informed" && !ok && tMs + BLOCK <= o.expiresMs) keep.push(o);
            }
            m.pending = keep;
          }
        }
        const dueMs = tMs + venue.execDelayBlocks * BLOCK;
        const submit = (o: Order | null) => {
          if (!o) return;
          if (o.kind === "informed") informedPlaced++;
          if (venue.execDelayBlocks === 0) executed(o, execute(m, o, pTrue(), navMtm));
          else m.pending.push(o);
        };
        const informedPending = () => m.pending.some((o) => o.kind === "informed");
        // Informed takers act first (the worst case for the vault), then noise.
        if (flow.informedMode === "sniper") {
          if (flow.sniperPresence >= 1 || m.rng.next() < flow.sniperPresence) {
            informedOrders++;
            if (!informedPending()) submit(placeInformed(m, pTrue(), dueMs));
          }
        } else {
          while (m.nextInformedMs <= tMs) {
            m.nextInformedMs += m.rng.exp(informedGapMs);
            informedOrders++;
            if (!informedPending()) submit(placeInformed(m, pTrue(), dueMs));
          }
        }
        while (m.nextNoiseMs <= tMs) {
          m.nextNoiseMs += m.rng.exp(noiseGapMs);
          noiseOrders++;
          submit(placeNoise(m, dueMs));
        }
      }
      if (reposts > 0) {
        const g = gasUsdOf(reposts);
        gasTotal += g;
        agg.gasUsd += g;
        repostBlocks++;
      }
    }
    // Rounds end exactly on the day boundary: settle whatever is still open.
    for (let si = 0; si < slots.length; si++) {
      const m = slots[si];
      if (m) {
        settle(m);
        slots[si] = null;
      }
    }
    agg.pnl -= agg.gasUsd;
  }

  // ---- results ----
  const daily: DailyRow[] = dayList.map((day, i) => ({ day, ...dayAggs[i]! }));
  const dailyPnl = Float64Array.from(daily.map((d) => d.pnl));
  const nDays = daily.length;
  const total = realized - gasTotal;
  const dd = maxDrawdown(equity);
  const meanDaily = mean(dailyPnl);
  const rSeed = hashSeed(cfg.seed, "bootstrap");
  // Realized P&L excluding informed traders' gains, and the daily expected edge (same convention).
  const adjPnl = Float64Array.from(daily.map((d) => d.pnl - Math.max(0, d.edgeInformed)));
  const expDaily = Float64Array.from(
    daily.map(
      (d) => d.edgeNoise + Math.min(0, d.edgeInformed) + d.feeIncome - d.gasUsd - d.redeemFees,
    ),
  );
  const adjCi = blockBootstrapCi(adjPnl, mean, rSeed);
  const expCi = blockBootstrapCi(expDaily, mean, hashSeed(cfg.seed, "bootstrap-expected"));
  const wins = roundPnl.filter((x) => x > 0).length;
  return {
    digest,
    days: nDays,
    rounds: roundPnl.length,
    pnl: {
      total,
      gasUsd: gasTotal,
      redeemFees,
      feeIncome,
      edgeNoise,
      edgeInformed,
      edgeInformedCounted: dayAggs.reduce((a, d) => a + Math.min(0, d.edgeInformed), 0),
      residual,
      check: edgeNoise + edgeInformed + residual + feeIncome - gasTotal - redeemFees - total,
    },
    flow: {
      noiseVolumeUsd: noiseVol,
      informedVolumeUsd: informedVol,
      noiseFills,
      informedFills,
      noiseOrders,
      noiseOrdersUnfilled: noiseUnfilled,
      informedOrders,
      informedOrdersTraded: informedTraded,
      informedOrdersPlaced: informedPlaced,
      protocolFeesUsd: protocolFees,
    },
    rounds_: {
      count: roundPnl.length,
      meanPnl: mean(roundPnl),
      stdPnl: std(roundPnl),
      winRatePct: roundPnl.length ? (100 * wins) / roundPnl.length : 0,
      p5: quantile(roundPnl, 0.05),
      p50: quantile(roundPnl, 0.5),
      p95: quantile(roundPnl, 0.95),
    },
    returns: {
      apySimplePct: nDays ? ((total / cfg.nav0) * 365 * 100) / nDays : 0,
      sharpeDaily: sharpeDaily(dailyPnl),
      profitableDaysPct: nDays ? (100 * dailyPnl.filter((x) => x > 0).length) / nDays : 0,
      meanDailyPnl: meanDaily,
      stdDailyPnl: std(dailyPnl),
      meanDailyPnlCi95: adjCi,
      totalPnlCi95: [adjCi[0] * nDays, adjCi[1] * nDays] as [number, number],
      expectedPerDayCi95: expCi,
    },
    risk: {
      maxDrawdownUsd: dd.abs,
      maxDrawdownPct: 100 * (cfg.nav0 > 0 ? dd.abs / cfg.nav0 : 0),
      breakerTripDays: tripDays,
      meanAbsInventoryShares: mean(inventory),
      p95AbsInventoryShares: quantile(inventory, 0.95),
      meanMaxLossAtExpiryUsd: mean(maxLossAtExpiry),
      peakAtRiskPct: 100 * peakAtRisk,
    },
    venue: {
      quoteUptimePct: quotable ? (100 * quoting) / quotable : 0,
      repostBlocks,
      gasUsdPerDay: nDays ? gasTotal / nDays : 0,
      gasPctNavPerDay: nDays ? (100 * gasTotal) / nDays / cfg.nav0 : 0,
    },
    byMarket,
    daily,
  };
}
