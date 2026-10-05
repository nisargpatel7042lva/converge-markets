import type { StrategyParams } from "@converge/strategy";

export type FlowConfig = {
  /** Noise taker volume, USD of notional per hour per market. */
  noiseUsdPerHourPerMarket: number;
  /** Lognormal order size: median notional (USD) and log-space sigma. */
  noiseSizeMedianUsd: number;
  noiseSizeSigma: number;
  /**
   * Demand elasticity of noise takers: each order draws a maximum acceptable cost (fraction of the
   * notional it pays above fair value) from an exponential with this mean, and walks away if the
   * best price costs more. Infinity = fully inelastic flow (an upper bound on revenue).
   */
  noiseToleranceMean: number;
  /** Share of taker ARRIVALS that are informed (0..<1). */
  informedShare: number;
  /**
   * "arrivals": informed takers arrive by Poisson (their share of arrivals is `informedShare`).
   * "sniper": a bot checks the book on a block with probability `sniperPresence` (1 = every block):
   * the adversary that exists wherever a public price feed leads our quotes.
   */
  informedMode: "arrivals" | "sniper";
  sniperPresence: number;
  /** An informed trader only takes a level if the net edge (price units, after fee) exceeds this. */
  informedEdgeThreshold: number;
  /**
   * Age of the price behind the vault's posted quotes, relative to what informed traders see (ms).
   * The vault sees the last 1 s bar from `latencyMs` ago; informed traders see the current bar.
   */
  latencyMs: number;
};

export type VenueConfig = {
  blockMs: number;
  /** Taker fee on notional. */
  takerFeeBps: number;
  /** false: the fee goes to the protocol (ADR-002 settlement rewards); true: it accrues to the LPs. */
  feeToLp: boolean;
  /** Fee on redemption of winning tokens (Market.redeemFeeBps, factory-configurable up to 100). */
  redeemFeeBps: number;
  /**
   * "posted": the keeper publishes quotes onchain by the posting rule (ADR-001 Option D); takers hit
   * the posted, possibly stale, book and every post costs gas.
   * "swapTime": the contract prices each swap from a fresh oracle report attached by the taker
   * (ADR-001's Phase 4 alternative): the book is recomputed every block, there is no keeper posting
   * cadence and no keeper gas; the information lead is just `latencyMs`.
   */
  quoteMode: "posted" | "swapTime";
  /**
   * Orders placed at block b execute at block b + execDelayBlocks against the book of THAT block
   * ("forward pricing": the fill price uses data newer than the information the taker acted on).
   * Informed takers submit limit orders at the price that gave them their edge; noise takers submit
   * market orders with their cost cap. 0 = immediate execution.
   */
  execDelayBlocks: number;
  /**
   * Stress only. 0 = single-shot: an informed order that does not fill at its execution block
   * expires (ADR-004's rule: forced execution against the canonical report). N > 0 lets an informed
   * order choose its moment for N more blocks, re-checking its edge with fresh information at each
   * one: a sniper with a timing option, which the design must prevent by forcing execution.
   */
  execWindowBlocks: number;
  /**
   * swapTime mode only: gas of executing one delayed order and pricing it on chain (report
   * verification plus ln/√/Φ), charged to the vault per order that fills. The posted design pays
   * its gas per keeper update instead.
   */
  gasPerFill: number;
  /** Gas of one batched quote update = gasBase + gasPerMarket × markets updated in that block. */
  gasBase: number;
  gasPerMarket: number;
  gasPriceGwei: number;
  monUsd: number;
  /** Seconds after the boundary before a round is open for trading (strike is the boundary price). */
  openDelaySec: number;
};

export type SimConfig = {
  assets: string[];
  durations: number[];
  nav0: number;
  params: StrategyParams;
  flow: FlowConfig;
  venue: VenueConfig;
  seed: number;
  /** Evaluation window, UTC dates, end exclusive. */
  startDay: string;
  endDay: string;
  /** Only simulate days whose index (from startDay) satisfies day % dayStride === dayOffset. */
  dayStride?: number;
  dayOffset?: number;
  /** Tests: stop the simulation at this block time (ms) and digest only fills before it. */
  stopAtMs?: number;
  /** Tests: called at the start of every block with its time (ms). Not serializable. */
  onBlock?: (tMs: number) => void;
  /** Development: called for every fill (not serializable, so not usable in worker pools). */
  debugFill?: (f: {
    tMs: number;
    market: string;
    kind: "noise" | "informed";
    sign: 1 | -1;
    shares: number;
    price: number;
    pTrue: number;
    vaultFair: number;
    tauSec: number;
  }) => void;
};

export type DailyRow = {
  day: string;
  pnl: number;
  gasUsd: number;
  edgeNoise: number;
  edgeInformed: number;
  residual: number;
  rounds: number;
  breakerTripped: boolean;
  feeIncome: number;
  redeemFees: number;
  noiseVolumeUsd: number;
  informedVolumeUsd: number;
};

export type RunResult = {
  /** Rolling hash of every fill (time, market, side, size, price): determinism and causality tests. */
  digest: number;
  days: number;
  rounds: number;
  pnl: {
    total: number;
    gasUsd: number;
    redeemFees: number;
    /** Taker fees accruing to the vault (only when venue.feeToLp). */
    feeIncome: number;
    edgeNoise: number;
    edgeInformed: number;
    residual: number;
    /** Informed P&L counted as income: the sum over days of min(0, that day's informed edge). */
    edgeInformedCounted: number;
    /** total = edgeNoise + edgeInformed + residual + feeIncome - gasUsd - redeemFees, as a difference (≈ 0). */
    check: number;
  };
  flow: {
    noiseVolumeUsd: number;
    informedVolumeUsd: number;
    noiseFills: number;
    informedFills: number;
    noiseOrders: number;
    noiseOrdersUnfilled: number;
    informedOrders: number;
    informedOrdersTraded: number;
    /** Informed orders actually placed (an edge existed), a subset of informedOrders (checks). */
    informedOrdersPlaced: number;
    protocolFeesUsd: number;
  };
  rounds_: {
    count: number;
    meanPnl: number;
    stdPnl: number;
    winRatePct: number;
    p5: number;
    p50: number;
    p95: number;
  };
  returns: {
    apySimplePct: number;
    sharpeDaily: number;
    profitableDaysPct: number;
    meanDailyPnl: number;
    stdDailyPnl: number;
    /**
     * 95% moving-block bootstrap intervals (5-day blocks). `meanDailyPnlCi95` and `totalPnlCi95` are
     * of realized P&L EXCLUDING informed traders' gains (the same convention as the expected edge);
     * `expectedPerDayCi95` is of the daily expected net edge.
     */
    meanDailyPnlCi95: [number, number];
    totalPnlCi95: [number, number];
    expectedPerDayCi95: [number, number];
  };
  risk: {
    maxDrawdownUsd: number;
    maxDrawdownPct: number;
    breakerTripDays: number;
    meanAbsInventoryShares: number;
    p95AbsInventoryShares: number;
    meanMaxLossAtExpiryUsd: number;
    peakAtRiskPct: number;
  };
  venue: {
    quoteUptimePct: number;
    repostBlocks: number;
    gasUsdPerDay: number;
    gasPctNavPerDay: number;
  };
  byMarket: Record<
    string,
    { rounds: number; pnl: number; edgeNoise: number; edgeInformed: number; residual: number }
  >;
  daily: DailyRow[];
};
