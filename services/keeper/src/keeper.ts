import {
  convergeVaultAbi,
  forwardVenueAbi,
  marketAbi,
  type StreamsReportSource,
} from "@converge/sdk";
import { EwmaVol, onchainQuote } from "@converge/strategy";
import {
  decodeFunctionResult,
  encodeFunctionData,
  parseEventLogs,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import type { Logger } from "pino";
import type { Alerter } from "./alerts";
import { BlockSource, type Head } from "./chain/blocks";
import { tracked, type Clients } from "./chain/clients";
import {
  FeeCapExceeded,
  SimulationReverted,
  TxTimeout,
  type TxManager,
  type TxResult,
} from "./chain/tx";
import {
  VaultReader,
  type Addresses,
  type MarketInfo,
  type OrderRow,
  type VaultState,
} from "./chain/vault";
import type { AssetCfg, KeeperFile } from "./config";
import type { CostLedger } from "./costs";
import { PnlTracker, fairUp, inventoryView, ladderViolations } from "./inventory";
import type { KillSwitch } from "./killswitch";
import type { Metrics } from "./metrics";
import { OrderTracker } from "./orders";
import { plan, type Action } from "./planner";
import { ReferencePrice, type PriceSnapshot, type Tick } from "./price/aggregator";
import { HaltController, evaluateRisk, type InventoryView, type RiskReason } from "./risk";
import type { Status } from "./server";

export type AssetRuntime = {
  cfg: AssetCfg;
  assetId: Hex;
  feedId: Hex;
  ref: ReferencePrice;
  vol: EwmaVol;
};

export type Mode = "live" | "dry-run" | "paper";

export type KeeperDeps = {
  mode: Mode;
  cfg: KeeperFile;
  log: Logger;
  metrics: Metrics;
  alerter: Alerter;
  kill: KillSwitch;
  clients: Clients;
  addrs: Addresses;
  assets: AssetRuntime[];
  /** Report source for order execution and settlement marks. */
  reports: (feedId: Hex) => StreamsReportSource;
  /** Null in dry-run and paper mode (nothing is ever sent). */
  tx: TxManager | null;
  ledger?: CostLedger;
  wsUrl?: string | undefined;
  now?: () => number;
  /** Execution delay and lateness of the venue (read at start when omitted). */
  venue?: { execDelay: number; maxLateness: number };
  /** Gas limit used for halts (a tiny call: no estimate round trip). */
  haltGas?: bigint;
};

const WAD = 10n ** 18n;
const toWad = (x: number): bigint => BigInt(Math.round(x * 1e8)) * 10n ** 10n;
const key32 = (s: string): Hex => stringToHex(s.slice(0, 31), { size: 32 });

/**
 * The market maker's operating loop.
 *
 * In this architecture the vault's ladder is struck on chain when an order executes, so "keeping a
 * market quoted" means keeping it tradable (inventory split, sigma and NAV fresh, no halt, no
 * settlement pending) and executing the orders that arrive within seconds of their pricing time.
 * Two paths run side by side:
 *   - fast, on every block and every price tick: risk checks (pull-all), orders;
 *   - slow, every `slowTickMs`: read the vault, plan the diff to the desired state, send it.
 * Nothing here can do more than the vault allows: the vault re-checks every bound.
 */
export class Keeper {
  readonly orders: OrderTracker;
  readonly reader: VaultReader;
  readonly blocks: BlockSource;
  private readonly controller: HaltController;
  private readonly pnl = new PnlTracker();
  private readonly now: () => number;
  private state: VaultState | null = null;
  private inventory: InventoryView | null = null;
  private head: Head | null = null;
  private readonly heads: Head[] = [];
  private startedAt = 0;
  private firstHealthyAt: number | null = null;
  private lastTickAt: number | null = null;
  private halting = false;
  private haltWanted = false;
  private haltReasons: RiskReason[] = [];
  private triggerBlock: bigint | null = null;
  private localHalt = false; // dry-run / paper: what the halt would have been
  private readonly inflight = new Set<string>();
  private readonly lastAttempt = new Map<string, number>();
  private readonly simulated = new Set<bigint>();
  private slowBusy = false;
  private slowTimer: NodeJS.Timeout | null = null;
  private readonly lastVolUpdate = new Map<string, number>();
  private venue: { execDelay: number; maxLateness: number };
  private lastBalanceCheck = 0;
  private peakPps = 0;
  readonly paper = { fills: 0, unfilled: 0, premiumUsd: 0 };
  /** Last violations seen, for tests and /status. */
  readonly violationLog: string[] = [];

  constructor(private readonly d: KeeperDeps) {
    this.now = d.now ?? Date.now;
    this.venue = d.venue ?? { execDelay: 2, maxLateness: 4 };
    this.orders = new OrderTracker(d.clients, d.addrs.venue);
    this.reader = new VaultReader(
      d.clients,
      d.addrs,
      d.assets.map((a) => ({ assetId: a.assetId, label: a.cfg.label, durations: [900, 3600] })),
    );
    this.controller = new HaltController(d.cfg.risk);
    this.blocks = new BlockSource(d.clients.pub, (h) => this.onHead(h), d.log, {
      wsUrl: d.wsUrl,
      pollMs: 150,
      stallMs: 3_000,
      now: this.now,
    });
    d.metrics.mode.set({ mode: d.mode }, 1);
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    this.startedAt = this.now();
    if (!this.d.venue) {
      try {
        const [delay, late] = await Promise.all([
          tracked(this.d.clients, () =>
            this.d.clients.pub.readContract({
              address: this.d.addrs.venue,
              abi: forwardVenueAbi,
              functionName: "execDelay",
            }),
          ),
          tracked(this.d.clients, () =>
            this.d.clients.pub.readContract({
              address: this.d.addrs.venue,
              abi: forwardVenueAbi,
              functionName: "maxLateness",
            }),
          ),
        ]);
        this.venue = { execDelay: Number(delay), maxLateness: Number(late) };
      } catch (e) {
        this.d.log.warn(
          { err: String(e).slice(0, 100) },
          "could not read the venue's timing, using defaults",
        );
      }
    }
    this.blocks.start();
    this.slowTimer = setInterval(() => void this.slowTick(), this.d.cfg.slowTickMs);
    this.slowTimer.unref();
    this.d.log.info({ mode: this.d.mode, venue: this.venue }, "keeper started");
  }

  stop(): void {
    this.blocks.stop();
    if (this.slowTimer) clearInterval(this.slowTimer);
  }

  /** Price tick from an exchange source (called by the WebSocket clients, or by tests). */
  onTick(asset: string, t: Tick): void {
    const a = this.d.assets.find((x) => x.cfg.label === asset);
    if (!a) return;
    a.ref.ingest(t);
    const last = this.lastVolUpdate.get(asset) ?? 0;
    if (t.tsMs - last >= 250) {
      const snap = a.ref.snapshot(t.tsMs);
      if (snap.price !== null && snap.healthy) a.vol.update(snap.price, t.tsMs / 1000);
      this.lastVolUpdate.set(asset, t.tsMs);
    }
    void this.riskCheck("tick");
  }

  /** The cached state with one more fill applied (kinds: 0 BUY_UP, 1 SELL_UP, 2 BUY_DOWN, 3 SELL_DOWN). */
  private withFill(st: VaultState, o: OrderRow, filled: bigint, premium: bigint): VaultState {
    const markets = st.markets.map((m) => {
      if (m.address.toLowerCase() !== o.market.toLowerCase()) return m;
      const up = o.kind === 0 ? -filled : o.kind === 1 ? filled : 0n;
      const down = o.kind === 2 ? -filled : o.kind === 3 ? filled : 0n;
      const sells = o.kind === 0 || o.kind === 2; // the vault sells tokens, receives premium
      return {
        ...m,
        upBal: m.upBal + up,
        downBal: m.downBal + down,
        cash: m.cash + (sells ? premium : -premium),
      };
    });
    return { ...st, markets };
  }

  /** Chain time minus this machine's clock, in ms (from the latest block). */
  chainOffsetMs(): number {
    return this.head ? Number(this.head.timestamp) * 1000 - this.head.seenAtMs : 0;
  }

  // ------------------------------------------------------------------ fast path

  private onHead(h: Head): void {
    this.head = h;
    this.heads.push(h);
    if (this.heads.length > 500) this.heads.shift();
    this.d.metrics.block.set(Number(h.number));
    void this.fast();
  }

  private snapshots(nowMs: number): PriceSnapshot[] {
    return this.d.assets.map((a) => a.ref.snapshot(nowMs));
  }

  private vaultFlags() {
    return {
      keeperHalt: this.d.mode === "live" ? (this.state?.keeperHalt ?? false) : this.localHalt,
      quotingPaused: this.state?.quotingPaused ?? false,
    };
  }

  /** Risk evaluation + the halt/unhalt decision. Cheap: no I/O unless it acts. */
  private async riskCheck(why: string): Promise<void> {
    const nowMs = this.now();
    let prices = this.snapshots(nowMs);
    if (this.firstHealthyAt === null && prices.every((p) => p.healthy)) this.firstHealthyAt = nowMs;
    // Start-up: the sockets are still connecting. Until the price has been healthy once, a missing
    // price is not an alarm for the first `startupGraceMs` (nothing is quoted without a price anyway).
    if (this.firstHealthyAt === null && nowMs - this.startedAt < this.d.cfg.startupGraceMs) {
      prices = prices.filter((p) => !(p.reasons.includes("NO_PRICE") || p.reasons.includes("FEW_SOURCES")));
    }
    const risk = evaluateRisk(
      {
        nowMs,
        prices,
        rpc: { consecutiveErrors: this.d.clients.rpcErrors.consecutive },
        blockLagMs: this.head ? nowMs - this.head.seenAtMs : null,
        inventory: this.inventory,
        killed: this.d.kill.killed,
        halted: this.vaultFlags().keeperHalt || this.halting,
      },
      this.d.cfg.risk,
    );
    this.d.metrics.killed.set(this.d.kill.killed ? 1 : 0);
    const flags = this.vaultFlags();
    // a halt already on its way counts as halted
    const decision = this.controller.decide(
      risk,
      { keeperHalt: flags.keeperHalt || this.halting, quotingPaused: flags.quotingPaused },
      nowMs,
    );
    if (decision.kind === "halt") {
      this.haltWanted = true;
      this.haltReasons = decision.reasons;
    }
    // A halt that could not be sent (RPC down) stays wanted until it has gone through.
    if (flags.keeperHalt) this.haltWanted = false;
    if (this.haltWanted && !this.halting) {
      this.triggerBlock ??= this.head?.number ?? null;
      await this.pullAll(this.haltReasons, why);
    } else if (decision.kind === "unhalt" && !this.halting) {
      await this.unhalt();
    }
  }

  private async fast(): Promise<void> {
    try {
      await this.riskCheck("block");
      if (this.d.kill.killed) return;
      if (!this.state) return; // the first slow tick has not run yet
      await this.orders.refresh();
      this.d.metrics.pendingOrders.set(this.orders.size);
      const acts = this.planNow().filter(
        (a) => a.type === "executeOrder" || a.type === "expireOrder",
      );
      this.dispatch(acts);
    } catch (e) {
      this.d.metrics.errors.inc({ kind: "fast" });
      this.d.log.warn({ err: String(e).slice(0, 160) }, "fast path failed");
    }
  }

  private async pullAll(reasons: RiskReason[], why: string): Promise<void> {
    const reason = reasons[0] ?? "UNKNOWN";
    this.halting = true;
    const blockAt = this.head?.number ?? null;
    this.d.log.warn(
      { reasons, why, block: blockAt?.toString() ?? null },
      "PULL ALL: halting quotes",
    );
    for (const r of reasons) this.d.metrics.halts.inc({ reason: r });
    void this.d.alerter.alert(
      `halt:${reason}`,
      `quotes pulled (${reasons.join(", ")}) at block ${blockAt ?? "?"}`,
    );
    try {
      if (this.d.mode !== "live" || !this.d.tx) {
        this.localHalt = true;
        this.haltWanted = false;
        this.d.log.info({ mode: this.d.mode }, "would send haltQuoting");
        return;
      }
      const data = encodeFunctionData({
        abi: convergeVaultAbi,
        functionName: "haltQuoting",
        args: [key32(reason)],
      });
      const r = await this.d.tx.submit("haltQuoting", this.d.addrs.vault, data, {
        critical: true,
        gas: this.d.haltGas ?? 100_000n,
      });
      this.account(r);
      if (r.status === "success") {
        if (this.state) this.state = { ...this.state, keeperHalt: true };
        this.haltWanted = false;
        const lat = this.triggerBlock !== null ? Number(r.blockNumber - this.triggerBlock) : 0;
        this.d.metrics.haltBlocks.observe(lat);
        this.d.log.warn(
          {
            triggerBlock: this.triggerBlock?.toString() ?? null,
            haltBlock: r.blockNumber.toString(),
            blocks: lat,
            hash: r.hash,
            reasons,
          },
          "quotes pulled",
        );
      } else {
        this.d.log.error({ hash: r.hash }, "haltQuoting reverted");
        this.d.metrics.errors.inc({ kind: "halt_reverted" });
      }
    } catch (e) {
      this.d.metrics.errors.inc({ kind: "halt_failed" });
      this.d.log.error({ err: String(e).slice(0, 200) }, "haltQuoting failed");
      void this.d.alerter.alert(
        "halt-failed",
        `could not send haltQuoting: ${String(e).slice(0, 120)}`,
      );
    } finally {
      this.halting = false;
      this.triggerBlock = null;
      this.d.metrics.halted.set(this.haltWanted ? 0 : 1);
    }
  }

  private async unhalt(): Promise<void> {
    this.halting = true;
    try {
      this.d.log.info("risk clean: putting quotes back");
      if (this.d.mode !== "live" || !this.d.tx) {
        this.localHalt = false;
        this.d.metrics.halted.set(0);
        return;
      }
      const data = encodeFunctionData({ abi: convergeVaultAbi, functionName: "unhaltQuoting" });
      const r = await this.d.tx.submit("unhaltQuoting", this.d.addrs.vault, data, {
        critical: true,
        gas: this.d.haltGas ?? 100_000n,
      });
      this.account(r);
      if (r.status === "success") {
        if (this.state) this.state = { ...this.state, keeperHalt: false };
        this.d.metrics.halted.set(0);
        void this.d.alerter.alert("unhalt", "quotes are back (risk checks clean)");
      }
    } catch (e) {
      this.d.metrics.errors.inc({ kind: "unhalt_failed" });
      this.d.log.error({ err: String(e).slice(0, 200) }, "unhaltQuoting failed");
    } finally {
      this.halting = false;
    }
  }

  // ------------------------------------------------------------------ slow path

  async slowTick(): Promise<void> {
    if (this.slowBusy) return;
    this.slowBusy = true;
    const t0 = this.now();
    try {
      const st = await this.reader.read();
      this.state = st;
      this.d.metrics.rpcErrors.set(this.d.clients.rpcErrors.consecutive);
      this.d.metrics.vaultPaused.set(st.quotingPaused ? 1 : 0);
      this.d.metrics.halted.set(st.keeperHalt || this.localHalt || this.halting ? 1 : 0);
      this.inventory = inventoryView(st);
      this.observe(st);
      await this.orders.refresh();
      this.d.metrics.pendingOrders.set(this.orders.size);
      await this.riskCheck("slow");
      if (!this.d.kill.killed) this.dispatch(this.planNow());
      await this.housekeeping();
      this.lastTickAt = this.now();
      this.d.metrics.lastTickTs.set(this.lastTickAt / 1000);
    } catch (e) {
      this.d.metrics.errors.inc({ kind: "slow" });
      this.d.metrics.rpcErrors.set(this.d.clients.rpcErrors.consecutive);
      this.d.log.warn({ err: String(e).slice(0, 160) }, "slow tick failed");
      await this.riskCheck("slow-error");
    } finally {
      this.d.metrics.loopMs.observe(this.now() - t0);
      this.slowBusy = false;
    }
  }

  private planNow(): Action[] {
    const st = this.state as VaultState;
    const nowSec = this.head ? Number(this.head.timestamp) : st.now;
    const sigmaTarget = new Map<string, number>();
    for (const a of this.d.assets) {
      const snap = a.ref.snapshot(this.now());
      if (snap.healthy) sigmaTarget.set(a.assetId.toLowerCase(), a.vol.annualVol);
    }
    return plan({
      nowSec: Math.max(nowSec, st.now),
      state: st,
      sigmaTarget,
      orders: this.orders.open,
      venue: this.venue,
      cfg: this.d.cfg,
      pulling: this.halting || this.vaultFlags().keeperHalt || this.d.kill.killed,
    });
  }

  /** Metrics, the live ladder check and P&L. */
  private observe(st: VaultState): void {
    const m = this.d.metrics;
    const nowMs = this.now();
    m.navLower.set(Number(st.navLower) / 1e6);
    m.navAgeSec.set(st.now - st.navUpdatedAt);
    for (const a of this.d.assets) {
      const snap = a.ref.snapshot(nowMs);
      const label = a.cfg.label;
      m.priceHealthy.set({ asset: label }, snap.healthy ? 1 : 0);
      if (snap.price !== null) m.price.set({ asset: label }, snap.price);
      m.shockBps.set({ asset: label }, snap.shockBps);
      m.divergenceBps.set({ asset: label }, snap.divergenceBps);
      if (snap.chainlinkBps !== null) m.chainlinkBps.set({ asset: label }, snap.chainlinkBps);
      for (const s of snap.sources) {
        m.sourceHealthy.set({ asset: label, source: s.name }, s.healthy ? 1 : 0);
        if (s.ageMs !== null) m.sourceAgeMs.set({ asset: label, source: s.name }, s.ageMs);
      }
      m.sigmaEstimate.set({ asset: label }, a.vol.annualVol);
      const as = st.assets.find((x) => x.assetId.toLowerCase() === a.assetId.toLowerCase());
      if (as) {
        m.sigma.set({ asset: label }, as.sigma);
        m.sigmaAgeSec.set({ asset: label }, st.now - as.sigmaUpdatedAt);
      }
    }
    if (this.inventory) {
      m.totalLossRatio.set(this.inventory.totalLossRatio);
      m.excessFraction.set(this.inventory.excessNavFraction);
    }
    let eligible = 0;
    let tradable = 0;
    for (const mk of st.markets) {
      const open = mk.state === 1 && mk.end - st.now > this.d.cfg.minSecondsLeftToSplit;
      if (open && mk.registered) {
        eligible += 1;
        if (mk.tradable) tradable += 1;
      }
      if (mk.registered) {
        m.tradable.set({ market: mk.address }, mk.tradable ? 1 : 0);
        m.inventory.set({ market: mk.address, side: "up" }, Number(mk.upBal) / 1e6);
        m.inventory.set({ market: mk.address, side: "down" }, Number(mk.downBal) / 1e6);
        const per = st.params.perMarketMaxFraction * (Number(st.navLower) / 1e6);
        const loss = Math.max(
          0,
          (Number(mk.basis) - Number(mk.cash)) / 1e6 -
            Math.min(Number(mk.upBal), Number(mk.downBal)) / 1e6,
        );
        m.lossRatio.set({ market: mk.address }, per > 0 ? loss / per : 0);
      }
    }
    m.eligibleMarkets.set(eligible);
    m.tradableMarkets.set(tradable);

    const fair = (mk: MarketInfo): number | null => {
      const a = this.d.assets.find((x) => x.assetId.toLowerCase() === mk.assetId.toLowerCase());
      const snap = a?.ref.snapshot(nowMs);
      const as = st.assets.find((x) => x.assetId.toLowerCase() === mk.assetId.toLowerCase());
      if (!a || !snap || snap.price === null || !as || mk.strike === 0n || mk.state !== 1)
        return null;
      return fairUp(
        snap.price,
        Number(mk.strike) / 1e18,
        as.sigma || a.vol.annualVol,
        mk.end - st.now,
      );
    };
    const pnl = this.pnl.update(st, fair);
    m.pnlRealized.set(pnl.realized);
    m.pnlUnrealized.set(pnl.unrealized);
    // drawdown of the lower share price against the best seen in this run
    if (st.totalSupply > 0n) {
      const pps = Number(st.navLower) / Number(st.totalSupply);
      this.peakPps = Math.max(this.peakPps, pps);
      if (this.peakPps > 0 && 1 - pps / this.peakPps >= this.d.cfg.risk.drawdownAlert) {
        void this.d.alerter.alert(
          "drawdown",
          `lower share price is ${((1 - pps / this.peakPps) * 100).toFixed(2)}% under its peak`,
        );
      }
    }
    void this.checkLadders(st);
  }

  /** Reads the venue's ladder for each tradable round and flags crossed or out-of-bounds levels. */
  private async checkLadders(st: VaultState): Promise<void> {
    try {
      for (const mk of st.markets) {
        if (!mk.registered || !mk.tradable || mk.state !== 1) continue;
        const a = this.d.assets.find((x) => x.assetId.toLowerCase() === mk.assetId.toLowerCase());
        const snap = a?.ref.snapshot(this.now());
        if (!a || !snap || snap.price === null || !snap.healthy) continue;
        const at = BigInt(st.now + this.venue.execDelay);
        const q = (await tracked(this.d.clients, () =>
          this.d.clients.pub.readContract({
            address: this.d.addrs.venue,
            abi: forwardVenueAbi,
            functionName: "quoteAt",
            args: [mk.address, toWad(snap.price as number), at],
          }),
        )) as unknown as {
          quoting: boolean;
          fair: bigint;
          bids: readonly { price: bigint; size: bigint }[];
          asks: readonly { price: bigint; size: bigint }[];
        };
        const f = (x: bigint) => Number(x) / 1e18;
        const ladder = {
          quoting: q.quoting,
          fair: f(q.fair),
          bids: q.bids.map((l) => ({ price: f(l.price), size: f(l.size) })),
          asks: q.asks.map((l) => ({ price: f(l.price), size: f(l.size) })),
        };
        const bad = ladderViolations(ladder, st.params);
        for (const kind of bad) {
          this.d.metrics.violations.inc({ kind });
          this.violationLog.push(`${mk.address}:${kind}`);
          void this.d.alerter.alert(
            `violation:${kind}`,
            `ladder violation ${kind} in ${mk.address}`,
          );
        }
        // the TypeScript twin of the contract's pricing must agree with the chain
        const as = st.assets.find((x) => x.assetId.toLowerCase() === mk.assetId.toLowerCase());
        if (as && as.sigma > 0 && ladder.quoting) {
          const pos = {
            basis: Number(mk.basis) / 1e6,
            cash: Number(mk.cash) / 1e6,
            up: Number(mk.upBal) / 1e6,
            down: Number(mk.downBal) / 1e6,
          };
          const mirror = onchainQuote(
            snap.price,
            Number(mk.strike) / 1e18,
            as.sigma,
            mk.end - Number(at),
            mk.end - mk.start,
            Number(st.navLower) / 1e6,
            pos,
            st.params,
          );
          if (Math.abs(mirror.fair - ladder.fair) > 2e-3) {
            this.d.metrics.errors.inc({ kind: "mirror_mismatch" });
            this.d.log.warn(
              { market: mk.address, chain: ladder.fair, mirror: mirror.fair },
              "on-chain and TypeScript fair value differ",
            );
          }
        }
      }
    } catch (e) {
      this.d.log.debug({ err: String(e).slice(0, 100) }, "ladder check failed");
    }
  }

  private async housekeeping(): Promise<void> {
    const t = this.now();
    if (t - this.lastBalanceCheck < 30_000) return;
    this.lastBalanceCheck = t;
    const bal = await tracked(this.d.clients, () =>
      this.d.clients.pub.getBalance({ address: this.d.clients.account.address }),
    );
    this.d.metrics.keeperBalanceMon.set(Number(bal) / 1e18);
    if (bal < 2n * 10n ** 17n)
      void this.d.alerter.alert(
        "low-balance",
        `keeper wallet is low: ${(Number(bal) / 1e18).toFixed(3)} MON`,
      );
  }

  // ------------------------------------------------------------------ dispatch

  private dispatch(actions: Action[]): void {
    let started = 0;
    for (const a of actions) {
      if (this.inflight.has(a.key)) continue;
      const cool = a.type === "executeOrder" ? 600 : 2_500;
      const last = this.lastAttempt.get(a.key);
      if (last !== undefined && this.now() - last < cool) continue;
      if (this.inflight.size >= 8 || started >= 6) break;
      this.inflight.add(a.key);
      this.lastAttempt.set(a.key, this.now());
      started += 1;
      void this.perform(a)
        .catch((e) => {
          this.d.metrics.errors.inc({ kind: "perform" });
          this.d.log.error({ action: a.type, err: String(e).slice(0, 200) }, "action failed");
        })
        .finally(() => this.inflight.delete(a.key));
    }
    if (this.lastAttempt.size > 5_000) {
      const cutoff = this.now() - 60_000;
      for (const [k, v] of this.lastAttempt) if (v < cutoff) this.lastAttempt.delete(k);
    }
  }

  private async send(
    kind: string,
    to: Address,
    data: Hex,
    opts: { gas?: bigint } = {},
  ): Promise<TxResult | null> {
    if (this.d.mode !== "live" || !this.d.tx) {
      this.d.log.info({ mode: this.d.mode, kind, to }, "would send");
      return null;
    }
    try {
      const r = await this.d.tx.submit(kind, to, data, opts);
      this.account(r);
      return r;
    } catch (e) {
      if (e instanceof SimulationReverted) {
        this.d.metrics.txSent.inc({ kind, result: "sim_revert" });
        this.d.log.debug({ kind, reason: e.reason.slice(0, 120) }, "skipped: simulation reverts");
      } else if (e instanceof FeeCapExceeded) {
        this.d.metrics.errors.inc({ kind: "fee_cap" });
        void this.d.alerter.alert("fee-cap", `fee above the cap, not sending ${kind}`);
      } else if (e instanceof TxTimeout) {
        this.d.metrics.errors.inc({ kind: "tx_timeout" });
        void this.d.alerter.alert("tx-timeout", `${kind} not mined after the replacements`);
      } else {
        this.d.metrics.errors.inc({ kind: "send" });
        this.d.log.warn({ kind, err: String(e).slice(0, 160) }, "send failed");
      }
      return null;
    }
  }

  private account(r: TxResult): void {
    const m = this.d.metrics;
    m.txSent.inc({ kind: r.kind, result: r.status });
    m.txInclusionMs.observe({ kind: r.kind }, r.latencyMs);
    m.txGas.inc({ kind: r.kind }, Number(r.gasLimit));
    m.txCostMon.inc({ kind: r.kind }, Number(r.costWei) / 1e18);
    this.d.ledger?.record(r);
  }

  private async perform(a: Action): Promise<void> {
    const { vault, venue } = this.d.addrs;
    switch (a.type) {
      case "setSigma": {
        const data = encodeFunctionData({
          abi: convergeVaultAbi,
          functionName: "setSigma",
          args: [a.assetId, a.sigmaWad],
        });
        const r = await this.send("setSigma", vault, data);
        if (r?.status === "success") this.d.metrics.quotesSent.inc({ kind: "setSigma" });
        return;
      }
      case "split":
      case "merge": {
        const fn = a.type === "split" ? "splitForInventory" : "mergeInventory";
        const data = encodeFunctionData({
          abi: convergeVaultAbi,
          functionName: fn,
          args: [a.market, a.amount],
        });
        const r = await this.send(fn, vault, data);
        if (r?.status === "success") this.d.metrics.quotesSent.inc({ kind: a.type });
        return;
      }
      case "redeemResolved":
      case "pruneEmpty": {
        const data = encodeFunctionData({
          abi: convergeVaultAbi,
          functionName: a.type,
          args: [a.market],
        });
        await this.send(a.type, vault, data);
        return;
      }
      case "resolve": {
        const data = encodeFunctionData({ abi: marketAbi, functionName: "resolve", args: ["0x"] });
        await this.send("resolve", a.market, data);
        return;
      }
      case "checkpoint": {
        const reports = await this.freshReports(a.feeds);
        const data = encodeFunctionData({
          abi: convergeVaultAbi,
          functionName: "checkpoint",
          args: [reports],
        });
        await this.send("checkpoint", vault, data);
        return;
      }
      case "settle": {
        const reports: Hex[] = [];
        for (const feed of a.feeds) {
          const rep = await this.d.reports(feed).reportAt(feed, BigInt(a.end));
          if (!rep) {
            this.d.metrics.errors.inc({ kind: "no_epoch_price" });
            void this.d.alerter.alert(
              `no-epoch-price:${a.epochId}`,
              `no price at the end of epoch ${a.epochId}: it will expire`,
            );
            return;
          }
          reports.push(rep);
        }
        const data = encodeFunctionData({
          abi: convergeVaultAbi,
          functionName: "settleEpoch",
          args: [BigInt(a.epochId), reports],
        });
        await this.send("settleEpoch", vault, data);
        return;
      }
      case "expireOrder": {
        const data = encodeFunctionData({
          abi: forwardVenueAbi,
          functionName: "expireOrder",
          args: [a.order.id],
        });
        const r = await this.send("expireOrder", venue, data);
        if (r || this.d.mode !== "live") this.orders.forget(a.order.id);
        return;
      }
      case "executeOrder":
        await this.execute(a.order);
        return;
    }
  }

  private async freshReports(feeds: Hex[]): Promise<Hex[]> {
    const ts = this.head ? this.head.timestamp : BigInt(Math.floor(this.now() / 1000));
    const out: Hex[] = [];
    for (const f of feeds) {
      try {
        const r = await this.d.reports(f).reportAt(f, ts);
        if (r) out.push(r);
      } catch (e) {
        this.d.log.debug({ err: String(e).slice(0, 80) }, "no fresh report for the checkpoint");
      }
    }
    return out;
  }

  /** The latency-critical step: build the report for the order's second and execute it once. */
  private async execute(o: OrderRow): Promise<void> {
    const { venue } = this.d.addrs;
    const st = this.state as VaultState;
    const mk = st.markets.find((x) => x.address.toLowerCase() === o.market.toLowerCase());
    const a = mk
      ? this.d.assets.find((x) => x.assetId.toLowerCase() === mk.assetId.toLowerCase())
      : undefined;
    if (!a) {
      this.d.metrics.errors.inc({ kind: "order_unknown_market" });
      return;
    }
    // never execute on a price we do not trust
    const snap = a.ref.snapshot(this.now());
    if (!snap.healthy) {
      this.d.log.warn(
        { id: o.id.toString(), reasons: snap.reasons },
        "not executing: reference price unhealthy",
      );
      return;
    }
    const report = await this.d.reports(a.feedId).reportAt(a.feedId, BigInt(o.execAt));
    if (!report) {
      this.d.metrics.errors.inc({ kind: "no_exec_price" });
      this.d.log.warn({ id: o.id.toString(), execAt: o.execAt }, "no price for the order's second");
      return;
    }
    const data = encodeFunctionData({
      abi: forwardVenueAbi,
      functionName: "executeOrder",
      args: [o.id, report],
    });
    // what the chain says would happen
    let filled = 0n;
    let premium = 0n;
    try {
      const res = await tracked(this.d.clients, () =>
        this.d.clients.pub.call({ account: this.d.clients.account, to: venue, data }),
      );
      const out = decodeFunctionResult({
        abi: forwardVenueAbi,
        functionName: "executeOrder",
        data: res.data ?? "0x",
      }) as readonly [bigint, bigint];
      filled = out[0];
      premium = out[1];
    } catch (e) {
      this.d.log.debug(
        { id: o.id.toString(), err: String(e).slice(0, 120) },
        "execution would revert: skipping",
      );
      this.orders.forget(o.id);
      return;
    }
    if (filled === 0n && !this.d.cfg.executeUnfilled) return;

    // Pull BEFORE the vault's own ceiling is reached: if this fill would take the inventory past the
    // keeper's cap, halt instead of executing (the order expires and the taker is refunded).
    if (filled > 0n && this.d.mode !== "dry-run") {
      const proj = inventoryView(this.withFill(st, o, filled, premium));
      const cap = this.d.cfg.risk.inventoryLossRatioCap;
      if (proj && (proj.maxLossRatio >= cap || proj.totalLossRatio >= cap)) {
        this.inventory = proj;
        this.haltWanted = true;
        this.haltReasons = ["INVENTORY_LOSS"];
        this.triggerBlock ??= this.head?.number ?? null;
        this.d.log.warn({ id: o.id.toString(), maxLossRatio: proj.maxLossRatio }, "this fill would pass the inventory cap");
        if (!this.halting) await this.pullAll(this.haltReasons, "projected-fill");
        return;
      }
    }

    if (this.d.mode === "paper") {
      if (this.simulated.has(o.id)) return;
      this.simulated.add(o.id);
      if (filled > 0n) {
        this.paper.fills += 1;
        this.paper.premiumUsd += Number(premium) / 1e6;
        this.d.metrics.fills.inc({ outcome: "simulated" });
      } else {
        this.paper.unfilled += 1;
      }
      this.d.log.info(
        { id: o.id.toString(), filled: filled.toString(), premium: premium.toString() },
        "paper fill",
      );
      this.orders.forget(o.id);
      return;
    }
    if (this.d.mode === "dry-run") {
      this.d.log.info({ id: o.id.toString(), filled: filled.toString() }, "would execute order");
      return;
    }
    const first = this.heads.find((h) => Number(h.timestamp) >= o.execAt) ?? this.head;
    const r = await this.send("executeOrder", venue, data);
    if (!r) return;
    this.orders.forget(o.id);
    if (r.status === "success") {
      const outcome = filled > 0n ? "filled" : "unfilled";
      this.d.metrics.fills.inc({ outcome });
      if (filled > 0n) this.d.metrics.filledUsd.inc(Number(premium) / 1e6);
      if (first) {
        const age = Number(r.blockNumber - first.number);
        this.d.metrics.quoteAgeBlocks.observe(age);
        this.d.metrics.orderExecLatencyMs.observe(r.minedAtMs - first.seenAtMs);
        this.d.log.info(
          {
            id: o.id.toString(),
            outcome,
            filled: filled.toString(),
            premium: premium.toString(),
            pricingBlock: first.number.toString(),
            mined: r.blockNumber.toString(),
            blocks: age,
          },
          "order executed",
        );
      }
      if (filled > 0n && this.state) {
        this.state = this.withFill(this.state, o, filled, premium);
        this.inventory = inventoryView(this.state);
      }
      void this.confirmExecution(r.hash, o.id);
    }
  }

  /** Reads the receipt's OrderExecuted log to account the real fill (best effort). */
  private async confirmExecution(hash: Hex, id: bigint): Promise<void> {
    try {
      const rc = await this.d.clients.pub.getTransactionReceipt({ hash });
      const ev = parseEventLogs({
        abi: forwardVenueAbi,
        logs: rc.logs,
        eventName: "OrderExecuted",
      })[0];
      if (ev)
        this.d.log.debug(
          { id: id.toString(), filled: ev.args.filled.toString() },
          "execution confirmed",
        );
    } catch {
      // not essential
    }
  }

  // ------------------------------------------------------------------ status

  status(): Status {
    const nowMs = this.now();
    const snaps = this.snapshots(nowMs);
    const reasons: string[] = [];
    if (this.d.kill.killed) reasons.push("killed");
    if (this.vaultFlags().keeperHalt || this.halting) reasons.push("halted");
    if (this.vaultFlags().quotingPaused) reasons.push("vault-paused");
    if (snaps.some((s) => !s.healthy)) reasons.push("price-unhealthy");
    if (this.d.clients.rpcErrors.consecutive >= this.d.cfg.risk.rpcErrorsToPull)
      reasons.push("rpc-errors");
    if (!this.head || nowMs - this.head.seenAtMs > this.d.cfg.risk.maxBlockLagMs)
      reasons.push("no-blocks");
    if (!this.state) reasons.push("no-state");
    return {
      mode: this.d.mode,
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      tickIntervalMs: this.d.cfg.slowTickMs,
      ready: reasons.length === 0,
      readyReasons: reasons,
      halted: this.vaultFlags().keeperHalt || this.halting,
      vaultPaused: this.vaultFlags().quotingPaused,
      block: this.head?.number.toString() ?? null,
      pendingOrders: this.orders.size,
      inventory: this.inventory,
      kill: this.d.kill.sources,
      prices: snaps.map((s) => ({ price: s.price, healthy: s.healthy, reasons: s.reasons })),
      paper: this.paper,
      violations: this.violationLog.length,
    };
  }
}

export { WAD };
