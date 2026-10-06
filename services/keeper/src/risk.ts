import type { RiskCfg } from "./config";
import type { PriceSnapshot } from "./price/aggregator";

/** What the keeper knows about its own exposure (from the vault, per open market). */
export type InventoryView = {
  /** Largest worst-case loss over a market's loss ceiling (0..1+). */
  maxLossRatio: number;
  /** Worst-case loss of all markets over the total at-risk ceiling. */
  totalLossRatio: number;
  /** Excess tokens (one side above the other) of all markets, valued at fair, over the lower NAV. */
  excessNavFraction: number;
};

export type RiskInputs = {
  nowMs: number;
  /** One snapshot per asset the keeper quotes. */
  prices: PriceSnapshot[];
  rpc: { consecutiveErrors: number };
  /** Time since the last block was seen (null before the first one). */
  blockLagMs: number | null;
  inventory: InventoryView | null;
  killed: boolean;
};

export type RiskReason =
  | "KILL_SWITCH"
  | "PRICE_UNHEALTHY"
  | "PRICE_SHOCK"
  | "SOURCE_DIVERGENCE"
  | "FEW_SOURCES"
  | "CHAINLINK_MISMATCH"
  | "RPC_ERRORS"
  | "BLOCK_LAG"
  | "INVENTORY_LOSS"
  | "INVENTORY_EXCESS";

export type Risk = { pull: boolean; reasons: RiskReason[] };

/** The checks that pull every quote. Pure. */
export function evaluateRisk(i: RiskInputs, cfg: RiskCfg): Risk {
  const reasons = new Set<RiskReason>();
  if (i.killed) reasons.add("KILL_SWITCH");
  for (const p of i.prices) {
    if (p.healthy) continue;
    reasons.add("PRICE_UNHEALTHY");
    for (const r of p.reasons) {
      if (r === "SHOCK") reasons.add("PRICE_SHOCK");
      else if (r === "DIVERGENCE") reasons.add("SOURCE_DIVERGENCE");
      else if (r === "FEW_SOURCES" || r === "NO_PRICE") reasons.add("FEW_SOURCES");
      else if (r === "CHAINLINK_MISMATCH") reasons.add("CHAINLINK_MISMATCH");
    }
  }
  if (i.rpc.consecutiveErrors >= cfg.rpcErrorsToPull) reasons.add("RPC_ERRORS");
  if (i.blockLagMs !== null && i.blockLagMs > cfg.maxBlockLagMs) reasons.add("BLOCK_LAG");
  if (i.inventory) {
    if (
      i.inventory.maxLossRatio >= cfg.inventoryLossRatioCap ||
      i.inventory.totalLossRatio >= cfg.inventoryLossRatioCap
    )
      reasons.add("INVENTORY_LOSS");
    if (i.inventory.excessNavFraction >= cfg.excessNavFractionCap) reasons.add("INVENTORY_EXCESS");
  }
  return { pull: reasons.size > 0, reasons: [...reasons] };
}

export type Decision =
  { kind: "none" } | { kind: "halt"; reasons: RiskReason[] } | { kind: "unhalt" };

/**
 * Decides when to send `haltQuoting` and `unhaltQuoting`.
 * - A pull while quotes are live: halt at once.
 * - While halted by the keeper: unhalt only after the risk has been clean for `hysteresisMs`
 *   (it doubles after a flap, up to `maxHysteresisMs`, and resets after a long calm).
 * - A vault paused by the guardian, the owner or the breaker is never touched: the keeper does
 *   not halt on top of it and does not try to resume it.
 * The vault state (`keeperHalt`, `quotingPaused`) is refreshed by the loop before each decision.
 */
export class HaltController {
  private cleanSinceMs: number | null = null;
  private hysteresisMs: number;
  private lastUnhaltMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly cfg: RiskCfg) {
    this.hysteresisMs = cfg.hysteresisMs;
  }

  get currentHysteresisMs(): number {
    return this.hysteresisMs;
  }

  decide(
    risk: Risk,
    vault: { keeperHalt: boolean; quotingPaused: boolean },
    nowMs: number,
  ): Decision {
    if (risk.pull) {
      this.cleanSinceMs = null;
      if (!vault.keeperHalt) return { kind: "halt", reasons: risk.reasons };
      return { kind: "none" };
    }
    if (!vault.keeperHalt) {
      // a long calm while quoting resets the flap guard
      if (nowMs - this.lastUnhaltMs > 4 * this.hysteresisMs)
        this.hysteresisMs = this.cfg.hysteresisMs;
      this.cleanSinceMs = null;
      return { kind: "none" };
    }
    if (vault.quotingPaused) return { kind: "none" }; // not ours to resume
    this.cleanSinceMs ??= nowMs;
    if (nowMs - this.cleanSinceMs < this.hysteresisMs) return { kind: "none" };
    // flap guard: a second unhalt soon after the last one doubles the wait
    if (nowMs - this.lastUnhaltMs < 2 * this.hysteresisMs)
      this.hysteresisMs = Math.min(this.cfg.maxHysteresisMs, this.hysteresisMs * 2);
    this.lastUnhaltMs = nowMs;
    this.cleanSinceMs = null;
    return { kind: "unhalt" };
  }
}
