/**
 * The partner API: everything another Monad app needs to put a Converge market on its own page,
 * with the vault's depth behind it. One object, built from a viem public client (and a wallet
 * client for the calls that send transactions) and the deployment's addresses.
 *
 * ```ts
 * const converge = createConvergeClient({ publicClient, walletClient, addresses });
 * const { market } = await converge.createPartnerMarket({ asset: "ETH/USD", strike: "3200", end });
 * const quotes = await converge.getQuotes(market, { spot: 3150 });
 * const { orderId } = await converge.buy({ market, side: "UP", amount: "5", spot: 3150 });
 * await converge.waitForFill(orderId);
 * ```
 *
 * Trading is forward-priced (ADR-004): `buy` and `sell` place an order that a keeper executes about
 * two seconds later at the oracle report for that second, so the price shown by `getQuotes` is an
 * indication and the limit price (the slippage) is the protection. Prices are decimals between 0
 * and 1 in the API (1.00 = the payout of a winning share); amounts are collateral units as decimal
 * strings ("12.5"); share counts are in the collateral's base units (6 decimals for USDC).
 */
import {
  encodeFunctionData,
  keccak256,
  parseEventLogs,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  convergeVaultAbi,
  forwardVenueAbi,
  marketAbi,
  mockErc20Abi,
  partnerRegistryAbi,
} from "./abi/generated";
import type { StreamsReportSource } from "./evidence";
import {
  createIndexerClient,
  type IndexerClient,
  type IndexerClientOptions,
  type MarketStatus,
  type Side,
  type TradeRow,
} from "./indexer";
import { WAD } from "./indexer-math";
import {
  ORDER_KIND,
  approveTx,
  askFromLadder,
  expireOrderTx,
  parseUnits6,
  placeOrderTx,
  planBuy,
  redeemTx,
  roundPhase,
  type BuyPlan,
  type RoundPhase,
  type Tx,
} from "./trade";

// ------------------------------------------------------------------ types

/** The contracts of one Converge deployment (deployments/<network>.json). */
export interface ConvergeAddresses {
  /** `PartnerRegistry`: where partners create markets. */
  registry: Address;
  /** `ConvergeVault`: the liquidity behind every market. */
  vault: Address;
  /** `ForwardVenue`: where orders are placed. */
  venue: Address;
  /** The collateral token (USDC; the open-mint test token on testnet). */
  collateral: Address;
}

export interface ConvergeClientConfig {
  /** Reads. */
  publicClient: PublicClient;
  /** Writes. It must have an account. Omit it for a read-only client. */
  walletClient?: WalletClient;
  addresses: ConvergeAddresses;
  /**
   * The Envio indexer's GraphQL endpoint. Without it `subscribeFills` reads the vault's `Fill`
   * events from the chain instead.
   */
  indexer?: IndexerClientOptions;
  /** Multicall3 address for batched reads (default: the canonical 0xcA11...CA11). */
  multicall3?: Address;
  /**
   * Most blocks one `eth_getLogs` call may span. Monad's public RPC rejects ranges above 100
   * (docs/EXTERNAL.md); the default of 90 keeps every log scan inside that.
   */
  maxLogRange?: number;
}

/** A market as the partner's page needs it. */
export interface MarketView {
  address: Address;
  /** Oracle asset id (keccak256 of the label, e.g. "ETH/USD"). */
  assetId: Hex;
  /** The threshold: UP wins iff the end price is at or above it. 18-decimal oracle scale. */
  strike: bigint;
  /** The strike as a JS number (for display). */
  strikeNumber: number;
  startTime: number;
  endTime: number;
  status: MarketStatus;
  /** What a user should see now (live, resolving, settled and how). */
  phase: RoundPhase;
  upToken: Address;
  downToken: Address;
  /** Redeem fee on winning payouts, in basis points (shared with the partner). */
  redeemFeeBps: number;
  /** The creating partner (null if this is not a partner market). */
  partner: Address | null;
  /** The owner has not voided it and the partner is in good standing. */
  active: boolean;
  /** The vault is quoting it right now. */
  quoting: boolean;
  /** The end price once resolved (18-decimal scale). */
  endPrice: bigint | null;
}

export interface QuoteLevel {
  /** Price per share, 0 to 1. */
  price: number;
  priceWad: bigint;
  /** Shares available at this level (collateral base units). */
  size: bigint;
}

export interface SideQuote {
  /** What a buyer pays per share now (null if the vault is not selling this side). */
  ask: QuoteLevel | null;
  /** What a seller receives per share now (null if the vault is not buying this side). */
  bid: QuoteLevel | null;
}

export interface Quotes {
  /** False when the vault is not quoting (no depth yet, halted, or the final seconds). */
  quoting: boolean;
  /** The implied probability of UP, 0 to 1. */
  fair: number;
  up: SideQuote;
  down: SideQuote;
  /** The UP ladder as the contract returned it (DOWN is its mirror). */
  ladder: {
    bids: readonly { price: bigint; size: bigint }[];
    asks: readonly { price: bigint; size: bigint }[];
  };
  /** The pricing time and spot used. */
  at: number;
  spot: number;
}

export interface CreateMarketResult {
  market: Address;
  txHash: Hex;
  /** The block that included the creation. */
  blockNumber: bigint;
  startTime: number;
  endTime: number;
  strike: bigint;
  upToken: Address;
  downToken: Address;
}

export interface OrderResult {
  /** Venue order id; pass it to `waitForFill`. */
  orderId: bigint;
  txHash: Hex;
  /** The block that included the order: pass it to `waitForFill` as `fromBlock`. */
  blockNumber: bigint;
  /** Chain time at which the order is priced and executed. */
  executesAt: number;
  /** Set for buys: the sizing the SDK chose. */
  plan?: BuyPlan;
  shares: bigint;
  limitWad: bigint;
}

export interface FillResult {
  status: "EXECUTED" | "EXPIRED";
  /** Shares exchanged (0 when the limit price was not met or there was no depth). */
  filled: bigint;
  /** Collateral exchanged. */
  premium: bigint;
  txHash: Hex;
}

export interface Fill {
  market: Address;
  /** The token that changed hands. */
  side: Side;
  /** What the TAKER did. */
  action: "BUY" | "SELL";
  shares: bigint;
  premium: bigint;
  /** Average price per share, 0 to 1. */
  price: number;
  taker: Address;
  txHash: Hex;
  block: number;
  /** Where the event came from. */
  source: "indexer" | "chain";
}

/** A partner's standing in the PartnerRegistry. */
export interface PartnerView {
  address: Address;
  /** The owner approved it. */
  approved: boolean;
  suspended: boolean;
  /** Most collateral the vault may have split into this partner's markets (base units). */
  exposureCap: bigint;
  /** Share of the redeem fee paid to the partner, in basis points. */
  feeShareBps: number;
  /** The active bond (base units); creating markets needs at least `minBond`. */
  bond: bigint;
  minBond: bigint;
  /** Fees credited and not yet withdrawn (base units). */
  feesOwed: bigint;
  marketsCreated: number;
  /** The partner can create a market right now (approved, not suspended, bonded, not paused). */
  canCreate: boolean;
}

export interface Position {
  market: Address;
  /** UP and DOWN balances (collateral base units). */
  up: bigint;
  down: bigint;
  /** What `redeem` would pay now, before the redeem fee (0 until the market has an outcome). */
  claimable: bigint;
}

export class ConvergeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "NO_WALLET"
      | "NOT_QUOTING"
      | "BAD_INPUT"
      | "NOT_RESOLVED"
      | "TIMEOUT"
      | "REVERTED"
      | "NO_REPORT",
  ) {
    super(message);
    this.name = "ConvergeError";
  }
}

// ------------------------------------------------------------------ pure helpers

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const CANONICAL_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;
const STATUS: readonly MarketStatus[] = [
  "CREATED",
  "OPEN",
  "RESOLVED_UP",
  "RESOLVED_DOWN",
  "INVALID",
];

/** The oracle asset id for a label such as "ETH/USD" (a 32-byte hex string is passed through). */
export function assetIdFor(asset: string): Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(asset) ? (asset as Hex) : keccak256(stringToHex(asset));
}

/**
 * A strike as the contracts want it: the oracle's 18-decimal integer. A string or number is read
 * as a plain decimal ("3200.5"); a bigint is taken as already scaled.
 */
const INT192_MAX = 2n ** 191n - 1n;

export function parseStrike(strike: string | number | bigint): bigint {
  if (typeof strike === "bigint") {
    if (strike <= 0n) throw new ConvergeError("strike must be positive", "BAD_INPUT");
    // Below 1e-9 of a dollar no feed has a real price: this is `3200n` where "3200" was meant
    if (strike < 10n ** 9n) {
      throw new ConvergeError(
        'a bigint strike is taken as already scaled by 1e18; this one is below 1e-9: pass a decimal string such as "3200"',
        "BAD_INPUT",
      );
    }
    if (strike > INT192_MAX) throw new ConvergeError("strike is above int192.max", "BAD_INPUT");
    return strike;
  }
  const s = typeof strike === "number" ? numberToDecimal(strike) : strike.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(s)) {
    throw new ConvergeError(`not a price: ${String(strike)}`, "BAD_INPUT");
  }
  const v = parseUnits(s, 18);
  if (v <= 0n) throw new ConvergeError("strike must be positive", "BAD_INPUT");
  if (v > INT192_MAX) throw new ConvergeError("strike is above int192.max", "BAD_INPUT");
  return v;
}

function numberToDecimal(x: number): string {
  if (!Number.isFinite(x) || x <= 0) throw new ConvergeError(`not a price: ${x}`, "BAD_INPUT");
  // toFixed avoids exponent notation; 12 decimals is far finer than any feed's precision
  return x.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}

/** The strike (or any 18-decimal price) as a number for display. */
export function formatStrike(v: bigint): number {
  return Number(v) / 1e18;
}

/** A unix time in seconds from a Date or a number of seconds. */
function toSeconds(t: Date | number): number {
  const s = t instanceof Date ? Math.floor(t.getTime() / 1000) : Math.floor(t);
  if (!Number.isFinite(s) || s <= 0) throw new ConvergeError("bad end time", "BAD_INPUT");
  return s;
}

/**
 * The best price a seller of `side` gets, from the UP ladder (DOWN is the mirror of UP). Sizes are
 * returned as the contract has them, WAD-scaled; `getQuotes` converts them to base units.
 */
export function bidFromLadder(
  side: Side,
  q: {
    quoting: boolean;
    bids: readonly { price: bigint; size: bigint }[];
    asks: readonly { price: bigint; size: bigint }[];
  },
): { priceWad: bigint; sizeShares: bigint } | null {
  if (!q.quoting) return null;
  if (side === "UP") {
    const b = q.bids[0];
    return b && b.size > 0n ? { priceWad: b.price, sizeShares: b.size } : null;
  }
  // selling DOWN = buying UP from the vault's best UP ask: the DOWN price is 1 - that ask
  const a = q.asks[0];
  return a && a.size > 0n ? { priceWad: WAD - a.price, sizeShares: a.size } : null;
}

/** The lowest price a seller accepts: the displayed bid less the slippage, never below 0.01. */
export function floorFor(priceWad: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 5_000)
    throw new ConvergeError("slippage out of range", "BAD_INPUT");
  const f = (priceWad * BigInt(10_000 - slippageBps)) / 10_000n;
  const min = 10_000_000_000_000_000n; // 0.01
  return f < min ? min : f > priceWad ? priceWad : f;
}

/**
 * The venue's ladder sizes are WAD-scaled token amounts (1e18 = one share); the API reports shares
 * in the collateral's base units (6 decimals), like every other amount here.
 */
const SIZE_SCALE = 10n ** 12n;
const level = (l: { priceWad: bigint; sizeShares: bigint } | null) =>
  l === null
    ? null
    : { price: Number(l.priceWad) / 1e18, priceWad: l.priceWad, size: l.sizeShares / SIZE_SCALE };

// ------------------------------------------------------------------ client

export interface ConvergeClient {
  /** The addresses this client talks to. */
  readonly addresses: ConvergeAddresses;
  /** The signer's address, if there is a wallet client. */
  readonly account: Address | null;

  /**
   * Creates a price-threshold market through the PartnerRegistry: UP wins iff the oracle price of
   * `asset` at `end` is at or above `strike` (a tie goes UP). The market is open at once and the
   * vault starts quoting it within a couple of blocks (the keeper adds liquidity), up to your cap.
   * @param args.asset an onboarded feed, as a label ("ETH/USD") or a 32-byte asset id
   * @param args.strike the threshold as a decimal ("3200") or an already scaled bigint
   * @param args.end when it ends: a Date or unix seconds, 15 minutes to 7 days from now
   * @throws if the partner is not approved, the feed is not allowed, the bond is too low or the
   *   duration is out of range (the contract's error name is in the message).
   */
  createPartnerMarket(args: {
    asset: string;
    strike: string | number | bigint;
    end: Date | number;
  }): Promise<CreateMarketResult>;

  /** Reads a market: terms, state, phase, who made it and whether the vault is quoting it. */
  getMarket(market: Address): Promise<MarketView>;

  /**
   * The vault's two-sided prices for both outcomes.
   * @param opts.spot the current price of the asset (a number, or an 18-decimal bigint). The vault
   *   prices from the oracle at execution time; this only shapes the indication you show.
   * @param opts.at the pricing time in unix seconds (default: the latest block's time)
   */
  getQuotes(market: Address, opts: { spot: number | bigint; at?: number }): Promise<Quotes>;

  /**
   * Buys `side` for `amount` collateral. Approves the venue if needed, then places the order; a
   * keeper fills it about two seconds later (see `waitForFill`). The order never pays more than
   * the displayed price plus `slippageBps`; unspent escrow is refunded.
   * @param args.amount decimal collateral ("5" = 5 USDC)
   */
  buy(args: {
    market: Address;
    side: Side;
    amount: string | number;
    spot: number | bigint;
    slippageBps?: number;
  }): Promise<OrderResult>;

  /**
   * Sells `shares` of `side` back to the vault. The order never receives less than the displayed
   * bid minus `slippageBps`.
   * @param args.shares collateral base units (6 decimals), as a bigint or a decimal string
   */
  sell(args: {
    market: Address;
    side: Side;
    shares: bigint | string;
    spot: number | bigint;
    slippageBps?: number;
  }): Promise<OrderResult>;

  /**
   * Waits until a venue order is executed (or expires) and returns what happened.
   * @param opts.fromBlock where to start looking: pass `order.blockNumber` (default: the last 90
   *   blocks). Log scans are split into windows the public Monad RPC accepts.
   * @throws `TIMEOUT` after `timeoutMs` (default 30 s); an unexecuted order can be refunded with
   *   `expireOrder` once its window has passed.
   */
  waitForFill(
    orderId: bigint,
    opts?: { timeoutMs?: number; fromBlock?: bigint },
  ): Promise<FillResult>;

  /** Refunds an order nobody executed in time (anyone may call; the caller takes the reward). */
  expireOrder(orderId: bigint): Promise<Hex>;

  /**
   * Resolves a market that has ended: fetches the oracle report for the end time from `reports`,
   * submits it, waits out the oracle's finalization window and finalizes. Anyone may call.
   * @param opts.reports where to get the Data Streams report (`DataStreamsRestSource`, or a test
   *   signer source on testnet)
   * @returns the final status
   */
  resolve(
    market: Address,
    opts: { reports: StreamsReportSource; timeoutMs?: number },
  ): Promise<MarketStatus>;

  /** Burns the signer's UP and DOWN of a resolved market and pays out winnings. */
  redeem(market: Address): Promise<Hex>;

  /** UP and DOWN balances of `account` (default: the signer) and what `redeem` would pay. */
  getPosition(market: Address, account?: Address): Promise<Position>;

  /** A partner's terms and standing (default: the signer). */
  getPartner(partner?: Address): Promise<PartnerView>;

  /**
   * Adds `amount` collateral ("100" = 100 USDC) to the signer's bond, approving the registry first
   * if needed. The signer must be an approved partner. The bond is what the owner can slash for
   * invalid markets.
   */
  postBond(amount: string | number): Promise<Hex>;

  /** Withdraws the partner's share of the redeem fees to `to` (default: the signer). */
  withdrawFees(to?: Address): Promise<Hex>;

  /**
   * Calls `onFill` for every fill in `market` (or in every market if omitted) from now on, as seen
   * by the indexer if one is configured, else read from the vault's `Fill` events on chain.
   * @returns a function that stops the subscription
   */
  subscribeFills(
    opts: { market?: Address; pollMs?: number; onError?: (e: unknown) => void },
    onFill: (f: Fill) => void,
  ): () => void;
}

export function createConvergeClient(cfg: ConvergeClientConfig): ConvergeClient {
  const { publicClient: pub, walletClient: wallet, addresses: A } = cfg;
  const account = wallet?.account?.address ?? null;
  const indexer: IndexerClient | null = cfg.indexer ? createIndexerClient(cfg.indexer) : null;

  const need = (): NonNullable<typeof wallet> => {
    if (!wallet?.account)
      throw new ConvergeError("this call needs a wallet client with an account", "NO_WALLET");
    return wallet;
  };

  const send = async (tx: Tx) => {
    const w = need();
    const hash = await w.sendTransaction({
      account: w.account!,
      chain: w.chain,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new ConvergeError(`transaction ${hash} reverted`, "REVERTED");
    }
    return { hash, receipt };
  };

  /** Sends only after a simulation passes, so a revert surfaces with the contract's error name. */
  const sendChecked = async (tx: Tx) => {
    const w = need();
    try {
      await pub.call({ account: w.account!.address, to: tx.to, data: tx.data, value: tx.value });
    } catch (e) {
      throw new ConvergeError(revertText(e), "REVERTED");
    }
    return send(tx);
  };

  const batch = async <T extends readonly unknown[]>(
    contracts: readonly {
      address: Address;
      abi: readonly unknown[];
      functionName: string;
      args?: readonly unknown[];
    }[],
  ): Promise<T> => {
    try {
      const r = await pub.multicall({
        contracts: contracts as never,
        allowFailure: false,
        multicallAddress: cfg.multicall3 ?? CANONICAL_MULTICALL3,
      });
      return r as unknown as T;
    } catch {
      return (await Promise.all(
        contracts.map((c) => pub.readContract(c as never)),
      )) as unknown as T;
    }
  };

  const chainNow = async (): Promise<number> => Number((await pub.getBlock()).timestamp);

  /** `getContractEvents` over [from, to] in windows the RPC accepts. */
  const range = BigInt(Math.max(1, cfg.maxLogRange ?? 90));
  async function eventsIn<T>(
    query: (fromBlock: bigint, toBlock: bigint) => Promise<readonly T[]>,
    from: bigint,
    to: bigint,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let start = from; start <= to; start += range) {
      const end = start + range - 1n < to ? start + range - 1n : to;
      out.push(...(await query(start, end)));
    }
    return out;
  }

  const spotWad = (spot: number | bigint): bigint =>
    typeof spot === "bigint" ? spot : parseStrike(spot);

  async function getMarket(market: Address): Promise<MarketView> {
    const m = (functionName: string) => ({ address: market, abi: marketAbi, functionName });
    const [assetId, start, end, state, strike, endPrice, up, down, fee, info, limits, view] =
      await batch<
        readonly [
          Hex,
          bigint,
          bigint,
          number,
          bigint,
          bigint,
          Address,
          Address,
          number,
          { partner: Address },
          { active: boolean },
          { tradable: boolean },
        ]
      >([
        m("assetId"),
        m("startTime"),
        m("endTime"),
        m("state"),
        m("strike"),
        m("endPrice"),
        m("up"),
        m("down"),
        m("redeemFeeBps"),
        { address: A.registry, abi: partnerRegistryAbi, functionName: "infoOf", args: [market] },
        { address: A.registry, abi: partnerRegistryAbi, functionName: "limits", args: [market] },
        { address: A.vault, abi: convergeVaultAbi, functionName: "venueView", args: [market] },
      ]);
    const status = STATUS[Number(state)] ?? "CREATED";
    const now = await chainNow();
    return {
      address: market,
      assetId,
      strike,
      strikeNumber: formatStrike(strike),
      startTime: Number(start),
      endTime: Number(end),
      status,
      phase: roundPhase({ state: Number(state), start: Number(start), end: Number(end), now }),
      upToken: up,
      downToken: down,
      redeemFeeBps: Number(fee),
      partner: info.partner === ZERO ? null : info.partner,
      active: limits.active,
      quoting: view.tradable,
      endPrice: status === "RESOLVED_UP" || status === "RESOLVED_DOWN" ? endPrice : null,
    };
  }

  async function getQuotes(
    market: Address,
    opts: { spot: number | bigint; at?: number },
  ): Promise<Quotes> {
    const at = opts.at ?? (await chainNow());
    const spot = spotWad(opts.spot);
    const q = (await pub.readContract({
      address: A.venue,
      abi: forwardVenueAbi,
      functionName: "quoteAt",
      args: [market, spot, BigInt(at)],
    })) as {
      quoting: boolean;
      fair: bigint;
      bids: readonly { price: bigint; size: bigint }[];
      asks: readonly { price: bigint; size: bigint }[];
    };
    const l = { quoting: q.quoting, bids: q.bids, asks: q.asks };
    return {
      quoting: q.quoting,
      fair: Number(q.fair) / 1e18,
      up: {
        ask: level(askFromLadder("UP", l)),
        bid: level(bidFromLadder("UP", l)),
      },
      down: {
        ask: level(askFromLadder("DOWN", l)),
        bid: level(bidFromLadder("DOWN", l)),
      },
      ladder: { bids: q.bids, asks: q.asks },
      at,
      spot: Number(spot) / 1e18,
    };
  }

  async function allowanceOk(token: Address, spender: Address, need_: bigint): Promise<boolean> {
    const have = (await pub.readContract({
      address: token,
      abi: mockErc20Abi,
      functionName: "allowance",
      args: [account as Address, spender],
    })) as bigint;
    return have >= need_;
  }

  async function place(
    market: Address,
    kind: keyof typeof ORDER_KIND,
    shares: bigint,
    limitWad: bigint,
    escrowToken: Address,
    escrowAmount: bigint,
    plan?: BuyPlan,
  ): Promise<OrderResult> {
    need();
    if (!(await allowanceOk(escrowToken, A.venue, escrowAmount))) {
      await send(approveTx(escrowToken, A.venue, escrowAmount));
    }
    const reward = (await pub.readContract({
      address: A.venue,
      abi: forwardVenueAbi,
      functionName: "minReward",
    })) as bigint;
    const { hash, receipt } = await sendChecked(
      placeOrderTx({
        venue: A.venue,
        market,
        // placeOrderTx indexes ORDER_KIND with this, which also holds the sell kinds
        plan: { kind: kind as BuyPlan["kind"], shares, limitWad },
        reward,
      }),
    );
    const ev = parseEventLogs({
      abi: forwardVenueAbi,
      eventName: "OrderPlaced",
      logs: receipt.logs,
    })[0];
    if (!ev) throw new ConvergeError("order placed but no OrderPlaced event found", "REVERTED");
    return {
      orderId: ev.args.id,
      txHash: hash,
      blockNumber: receipt.blockNumber,
      executesAt: Number(ev.args.execAt),
      plan,
      shares,
      limitWad,
    };
  }

  return {
    addresses: A,
    account,

    async createPartnerMarket(args) {
      const assetId = assetIdFor(args.asset);
      const strike = parseStrike(args.strike);
      const end = toSeconds(args.end);
      const data = encodeFunctionData({
        abi: partnerRegistryAbi,
        functionName: "createThresholdMarket",
        args: [assetId, strike, BigInt(end)],
      });
      const { hash, receipt } = await sendChecked({ to: A.registry, data });
      const ev = parseEventLogs({
        abi: partnerRegistryAbi,
        eventName: "PartnerMarketCreated",
        logs: receipt.logs,
      })[0];
      const created = parseEventLogs({
        abi: partnerRegistryAbi,
        eventName: "MarketCreated",
        logs: receipt.logs,
      })[0];
      if (!ev || !created) throw new ConvergeError("market created but no event found", "REVERTED");
      return {
        market: ev.args.market,
        txHash: hash,
        blockNumber: receipt.blockNumber,
        startTime: Number(ev.args.startTime),
        endTime: Number(ev.args.endTime),
        strike: ev.args.strike,
        upToken: created.args.params.up,
        downToken: created.args.params.down,
      };
    },

    getMarket,
    getQuotes,

    async buy({ market, side, amount, spot, slippageBps = 100 }) {
      const budget = parseUnits6(amount);
      const view = await getMarket(market);
      const quotes = await getQuotes(market, { spot });
      const ask = askFromLadder(side, {
        quoting: quotes.quoting,
        bids: quotes.ladder.bids,
        asks: quotes.ladder.asks,
      });
      if (!ask)
        throw new ConvergeError("the vault is not quoting this side right now", "NOT_QUOTING");
      const plan = planBuy({
        side,
        budget,
        priceWad: ask.priceWad,
        slippageBps,
        redeemFeeBps: view.redeemFeeBps,
      });
      return place(market, plan.kind, plan.shares, plan.limitWad, A.collateral, plan.escrow, plan);
    },

    async sell({ market, side, shares, spot, slippageBps = 100 }) {
      const n = typeof shares === "bigint" ? shares : parseUnits6(shares);
      if (n <= 0n) throw new ConvergeError("shares must be positive", "BAD_INPUT");
      const view = await getMarket(market);
      const quotes = await getQuotes(market, { spot });
      const bid = bidFromLadder(side, {
        quoting: quotes.quoting,
        bids: quotes.ladder.bids,
        asks: quotes.ladder.asks,
      });
      if (!bid)
        throw new ConvergeError("the vault is not buying this side right now", "NOT_QUOTING");
      const kind = side === "UP" ? "SELL_UP" : "SELL_DOWN";
      const token = side === "UP" ? view.upToken : view.downToken;
      const limit = floorFor(bid.priceWad, slippageBps);
      return place(market, kind, n, limit, token, n);
    },

    async waitForFill(orderId, opts = {}) {
      const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
      let cursor = opts.fromBlock ?? (await pub.getBlockNumber()) - (range - 1n);
      if (cursor < 0n) cursor = 0n;
      for (;;) {
        const head = await pub.getBlockNumber();
        const [done, expired] =
          head < cursor
            ? [[], []]
            : await Promise.all([
                eventsIn(
                  (fromBlock, toBlock) =>
                    pub.getContractEvents({
                      address: A.venue,
                      abi: forwardVenueAbi,
                      eventName: "OrderExecuted",
                      args: { id: orderId },
                      fromBlock,
                      toBlock,
                    }),
                  cursor,
                  head,
                ),
                eventsIn(
                  (fromBlock, toBlock) =>
                    pub.getContractEvents({
                      address: A.venue,
                      abi: forwardVenueAbi,
                      eventName: "OrderExpired",
                      args: { id: orderId },
                      fromBlock,
                      toBlock,
                    }),
                  cursor,
                  head,
                ),
              ]);
        if (head >= cursor) cursor = head + 1n;
        const d = done[0];
        if (d) {
          return {
            status: "EXECUTED",
            filled: d.args.filled as bigint,
            premium: d.args.premium as bigint,
            txHash: d.transactionHash as Hex,
          };
        }
        const x = expired[0];
        if (x)
          return { status: "EXPIRED", filled: 0n, premium: 0n, txHash: x.transactionHash as Hex };
        if (Date.now() > deadline)
          throw new ConvergeError(`order ${orderId} was not executed in time`, "TIMEOUT");
        await sleep(400);
      }
    },

    async expireOrder(orderId) {
      return (await sendChecked(expireOrderTx(A.venue, orderId))).hash;
    },

    async resolve(market, opts) {
      need();
      const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
      const read = async () => {
        const [state, end, assetId] = await batch<readonly [number, bigint, Hex]>([
          { address: market, abi: marketAbi, functionName: "state" },
          { address: market, abi: marketAbi, functionName: "endTime" },
          { address: market, abi: marketAbi, functionName: "assetId" },
        ]);
        return { state: STATUS[Number(state)] ?? "CREATED", end: Number(end), assetId };
      };
      let cur = await read();
      if (cur.state !== "OPEN") return cur.state;
      const assetRow = await pub.readContract({
        address: A.vault,
        abi: convergeVaultAbi,
        functionName: "assetCfg",
        args: [cur.assetId],
      });
      const feedId: Hex = assetRow[1];
      while ((await chainNow()) < cur.end) {
        if (Date.now() > deadline)
          throw new ConvergeError("the market has not ended yet", "TIMEOUT");
        await sleep(500);
      }
      const report = await opts.reports.reportAt(feedId, BigInt(cur.end));
      const resolveData = (evidence: Hex): Tx => ({
        to: market,
        data: encodeFunctionData({ abi: marketAbi, functionName: "resolve", args: [evidence] }),
      });
      // The first call submits the report; once the oracle's finalization window passes, another
      // call finalizes. Anyone can call it, and so does the vault's keeper, so a call can lose a
      // race (a transaction that simulated fine is mined after the market was resolved, or
      // estimated its gas against a state the other transaction then changed). Every failure is
      // therefore re-checked against the market's state and retried until the deadline. The
      // report is sent every time: it is ignored once the boundary is final.
      // Without a report the call can still succeed once the oracle's grace has passed: the
      // market then becomes INVALID (every share pays 0.5), which is the correct outcome.
      const evidence: Hex = report ?? "0x";
      let lastError: unknown = null;
      for (let attempt = 0; ; attempt++) {
        try {
          await sendChecked(resolveData(evidence));
          lastError = null;
        } catch (e) {
          lastError = e;
        }
        cur = await read();
        if (cur.state !== "OPEN") return cur.state;
        if (Date.now() > deadline) {
          if (!report) {
            throw new ConvergeError("no oracle report for the end time yet", "NO_REPORT");
          }
          throw new ConvergeError(
            lastError
              ? `the market was not resolved: ${lastError instanceof Error ? lastError.message : String(lastError)}`
              : "the oracle has not finalized the end price",
            "TIMEOUT",
          );
        }
        // an attempt that failed before the oracle's window ended is expected: wait and retry
        await sleep(attempt === 0 && !lastError ? 1_000 : 1_500);
      }
    },

    async redeem(market) {
      const view = await getMarket(market);
      if (view.status === "OPEN" || view.status === "CREATED") {
        throw new ConvergeError("the market has no outcome yet", "NOT_RESOLVED");
      }
      return (await sendChecked(redeemTx(market))).hash;
    },

    async getPosition(market, who) {
      const holder = who ?? account;
      if (!holder) throw new ConvergeError("no account to read", "NO_WALLET");
      const view = await getMarket(market);
      const [up, down, claimable] = await batch<readonly [bigint, bigint, bigint]>([
        { address: view.upToken, abi: mockErc20Abi, functionName: "balanceOf", args: [holder] },
        { address: view.downToken, abi: mockErc20Abi, functionName: "balanceOf", args: [holder] },
        { address: market, abi: marketAbi, functionName: "claimable", args: [holder] },
      ]);
      return { market, up, down, claimable };
    },

    async getPartner(who) {
      const partner = who ?? account;
      if (!partner) throw new ConvergeError("no account to read", "NO_WALLET");
      const [p, minBond, feesOwed, paused] = await batch<
        readonly [
          {
            approved: boolean;
            suspended: boolean;
            exposureCap: bigint;
            feeShareBps: number;
            bond: bigint;
            marketsCreated: number;
          },
          bigint,
          bigint,
          boolean,
        ]
      >([
        {
          address: A.registry,
          abi: partnerRegistryAbi,
          functionName: "partnerOf",
          args: [partner],
        },
        { address: A.registry, abi: partnerRegistryAbi, functionName: "minBond" },
        { address: A.registry, abi: partnerRegistryAbi, functionName: "feesOwed", args: [partner] },
        { address: A.registry, abi: partnerRegistryAbi, functionName: "paused" },
      ]);
      return {
        address: partner,
        approved: p.approved,
        suspended: p.suspended,
        exposureCap: p.exposureCap,
        feeShareBps: Number(p.feeShareBps),
        bond: p.bond,
        minBond,
        feesOwed,
        marketsCreated: Number(p.marketsCreated),
        canCreate: p.approved && !p.suspended && !paused && p.bond >= minBond,
      };
    },

    async postBond(amount) {
      const n = parseUnits6(amount);
      need();
      if (!(await allowanceOk(A.collateral, A.registry, n))) {
        await send(approveTx(A.collateral, A.registry, n));
      }
      const data = encodeFunctionData({
        abi: partnerRegistryAbi,
        functionName: "postBond",
        args: [n],
      });
      return (await sendChecked({ to: A.registry, data })).hash;
    },

    async withdrawFees(to) {
      const dest = to ?? account;
      if (!dest) throw new ConvergeError("no account to pay", "NO_WALLET");
      const data = encodeFunctionData({
        abi: partnerRegistryAbi,
        functionName: "withdrawFees",
        args: [dest],
      });
      return (await sendChecked({ to: A.registry, data })).hash;
    },

    subscribeFills(opts, onFill) {
      const every = opts.pollMs ?? 1_000;
      let stopped = false;
      const fail = (e: unknown) => (opts.onError ? opts.onError(e) : undefined);
      const seen = new Set<string>();
      let primed = false;
      let from: bigint | null = null;

      const fromIndexer = async () => {
        let rows: TradeRow[];
        if (opts.market) {
          const m = await (indexer as IndexerClient).market(opts.market.toLowerCase(), 50);
          // the indexer has not seen the market yet: stay unprimed, so its first trades are not
          // mistaken for history
          if (!m) return;
          rows = m.trades;
        } else {
          rows = await (indexer as IndexerClient).recentTrades(50);
        }
        for (const t of [...rows].reverse()) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          if (!primed) continue;
          onFill({
            market: t.marketId as Address,
            side: t.side,
            action: t.action,
            shares: t.size,
            premium: t.premium,
            price: t.price,
            taker: t.taker as Address,
            txHash: t.txHash as Hex,
            block: t.block,
            source: "indexer",
          });
        }
        primed = true;
      };

      const fromChain = async () => {
        const head = await pub.getBlockNumber();
        if (from === null) from = head + 1n;
        if (head < from) return;
        const logs = await eventsIn(
          (fromBlock, toBlock) =>
            pub.getContractEvents({
              address: A.vault,
              abi: convergeVaultAbi,
              eventName: "Fill",
              args: opts.market ? { market: opts.market } : undefined,
              fromBlock,
              toBlock,
            }),
          from,
          head,
        );
        from = head + 1n;
        for (const l of logs) {
          const a = l.args as {
            market: Address;
            upToken: boolean;
            vaultSells: boolean;
            units: bigint;
            premium: bigint;
            taker: Address;
          };
          onFill({
            market: a.market,
            side: a.upToken ? "UP" : "DOWN",
            action: a.vaultSells ? "BUY" : "SELL",
            shares: a.units,
            premium: a.premium,
            price: a.units === 0n ? 0 : Number(a.premium) / Number(a.units),
            taker: a.taker,
            txHash: l.transactionHash as Hex,
            block: Number(l.blockNumber),
            source: "chain",
          });
        }
      };

      void (async () => {
        while (!stopped) {
          try {
            await (indexer ? fromIndexer() : fromChain());
          } catch (e) {
            fail(e);
          }
          await sleep(every);
        }
      })();
      return () => {
        stopped = true;
      };
    },
  };
}

// ------------------------------------------------------------------ small utilities

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** viem wraps contract reverts deeply; the custom error name is what a developer needs. */
function revertText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const name = /reverted with the following (?:custom error|reason)[^:]*:\s*([^\n(]+)/i.exec(
    m,
  )?.[1];
  const sig = /Error: ([A-Za-z0-9_]+)\(/.exec(m)?.[1];
  return `the call would revert: ${name?.trim() ?? sig ?? m.split("\n")[0]}`;
}
