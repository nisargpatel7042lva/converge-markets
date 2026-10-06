import type { Address, Hex } from "viem";
import { NonceManager } from "./nonce";
import { errText } from "../errors";

export type Fees = { baseFee: bigint; tip: bigint };

export type TxRequest = {
  to: Address;
  data: Hex;
  value?: bigint;
  gas: bigint;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export type TxReceipt = {
  hash: Hex;
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
};

/** What the transaction manager needs from the chain (one implementation for viem, one for tests). */
export interface ChainTx {
  fees(): Promise<Fees>;
  estimateGas(req: { to: Address; data: Hex; value?: bigint }): Promise<bigint>;
  sendTx(req: TxRequest): Promise<Hex>;
  receipt(hash: Hex): Promise<TxReceipt | null>;
  pendingNonce(): Promise<number>;
}

export class SimulationReverted extends Error {
  constructor(
    readonly kind: string,
    readonly reason: string,
  ) {
    super(`${kind}: simulation reverted: ${reason}`);
  }
}
export class FeeCapExceeded extends Error {
  constructor(
    readonly maxFee: bigint,
    readonly cap: bigint,
  ) {
    super(`fee ${maxFee} above cap ${cap}`);
  }
}
export class TxTimeout extends Error {
  constructor(
    readonly kind: string,
    readonly hashes: Hex[],
  ) {
    super(`${kind}: not mined after the replacements`);
  }
}

export type TxOpts = {
  /** Halts: bypass the fee cap by `haltFeeBoost` and are never queued behind anything. */
  critical?: boolean;
  value?: bigint;
  /** Use this gas limit instead of estimating (a measured value for a known call). */
  gas?: bigint;
};

export type TxResult = TxReceipt & {
  kind: string;
  nonce: number;
  attempts: number;
  sentAtMs: number;
  minedAtMs: number;
  /** minedAtMs - sentAtMs of the first broadcast. */
  latencyMs: number;
  /** gas limit paid for (Monad bills the limit). */
  gasLimit: bigint;
  /** cost in wei at the effective gas price, billed on the limit. */
  costWei: bigint;
};

export type TxManagerCfg = {
  gasMultiplierPct: number;
  maxFeePerGasWei: bigint;
  haltFeeBoost: number;
  stuckMs: number;
  maxReplacements: number;
  bumpPct: number;
  pollMs: number;
};

type Hooks = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onTx?: (r: TxResult) => void;
};

function isNonceTooLow(e: unknown): boolean {
  return /nonce too low|nonce is too low/i.test(String(e));
}

/**
 * Sends transactions with local nonces, a gas-limit and fee cap, and replaces a transaction that
 * does not get mined (same nonce, higher fee). A simulation that reverts never takes a nonce.
 */
export class TxManager {
  readonly nonces: NonceManager;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly chain: ChainTx,
    private readonly cfg: TxManagerCfg,
    private readonly hooks: Hooks = {},
  ) {
    this.nonces = new NonceManager(() => chain.pendingNonce());
    this.now = hooks.now ?? Date.now;
    this.sleep = hooks.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async submit(kind: string, to: Address, data: Hex, opts: TxOpts = {}): Promise<TxResult> {
    const base = { to, data, ...(opts.value === undefined ? {} : { value: opts.value }) };
    let gas = opts.gas;
    if (gas === undefined) {
      try {
        gas = ((await this.chain.estimateGas(base)) * BigInt(this.cfg.gasMultiplierPct)) / 100n;
      } catch (e) {
        throw new SimulationReverted(kind, errText(e, 200));
      }
    }
    const fees = await this.chain.fees();
    let maxFee = fees.baseFee * 2n + fees.tip;
    let tip = fees.tip;
    const cap = opts.critical
      ? BigInt(Math.floor(Number(this.cfg.maxFeePerGasWei) * this.cfg.haltFeeBoost))
      : this.cfg.maxFeePerGasWei;
    if (maxFee > cap) {
      // pay what the network asks if the cap still allows the base fee itself
      maxFee = fees.baseFee + tip;
      if (maxFee > cap) throw new FeeCapExceeded(maxFee, cap);
    }

    let nonce = await this.nonces.acquire();
    const hashes: Hex[] = [];
    const sentAtMs = this.now();
    let attempts = 0;
    const send = async (): Promise<Hex> => {
      attempts += 1;
      const req: TxRequest = {
        ...base,
        gas,
        nonce,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: tip,
      };
      try {
        return await this.chain.sendTx(req);
      } catch (e) {
        if (isNonceTooLow(e) && hashes.length === 0) {
          // somebody else (or an earlier life of this process) used it: trust the chain again
          this.nonces.settle(nonce);
          await this.nonces.resync();
          nonce = await this.nonces.acquire();
          return this.chain.sendTx({ ...req, nonce });
        }
        throw e;
      }
    };

    try {
      hashes.push(await send());
    } catch (e) {
      this.nonces.release(nonce);
      throw e;
    }

    let lastSent = this.now();
    let replacements = 0;
    for (;;) {
      for (const h of hashes) {
        const r = await this.chain.receipt(h);
        if (r) {
          this.nonces.settle(nonce);
          const minedAtMs = this.now();
          const result: TxResult = {
            ...r,
            kind,
            nonce,
            attempts,
            sentAtMs,
            minedAtMs,
            latencyMs: minedAtMs - sentAtMs,
            gasLimit: gas,
            costWei: gas * r.effectiveGasPrice,
          };
          this.hooks.onTx?.(result);
          return result;
        }
      }
      if (this.now() - lastSent >= this.cfg.stuckMs) {
        if (replacements >= this.cfg.maxReplacements) {
          // leave the nonce reserved: it is still pending on the chain
          throw new TxTimeout(kind, hashes);
        }
        replacements += 1;
        const bump = BigInt(Math.max(10, this.cfg.bumpPct));
        const capNow = cap;
        maxFee = (maxFee * (100n + bump)) / 100n;
        tip = (tip * (100n + bump)) / 100n;
        if (tip === 0n) tip = 1n;
        if (maxFee > capNow) maxFee = capNow;
        if (tip > maxFee) tip = maxFee;
        try {
          hashes.push(await send());
        } catch {
          // a replacement that is rejected leaves the earlier ones pending: keep waiting
        }
        lastSent = this.now();
      }
      await this.sleep(this.cfg.pollMs);
    }
  }
}
