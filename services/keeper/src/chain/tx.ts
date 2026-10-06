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
  /** Transactions the chain has mined for this account: the lowest nonce not yet confirmed. */
  confirmedNonce(): Promise<number>;
  /** This account (cancellations are self-transfers). */
  readonly address: Address;
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

/** Another transaction took this nonce (a halt replaced it, or another process used it). */
export class TxSuperseded extends Error {
  constructor(
    readonly kind: string,
    readonly hashes: Hex[],
  ) {
    super(`${kind}: its nonce was used by another transaction`);
  }
}

export type TxOpts = {
  /**
   * Halts: may pay up to `haltFeeBoost` times the fee cap. When something else is in flight, a
   * critical transaction takes the lowest unconfirmed nonce and replaces whatever sits there
   * (a stuck transaction can never queue a halt behind it).
   */
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
  /** Highest max fee sent per nonce: what a replacement has to beat. */
  private readonly feeAt = new Map<number, { maxFee: bigint; tip: bigint }>();

  constructor(
    private readonly chain: ChainTx,
    private readonly cfg: TxManagerCfg,
    private readonly hooks: Hooks = {},
  ) {
    this.nonces = new NonceManager(() => chain.pendingNonce());
    this.now = hooks.now ?? Date.now;
    this.sleep = hooks.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Primes what a submission needs (fees and the first nonce) so that the first send after a quiet
   * period does not spend round trips on them. Errors are ignored: it is only an optimisation.
   */
  async warm(): Promise<void> {
    try {
      await this.chain.fees();
      if (this.nonces.pendingCount === 0) this.nonces.release(await this.nonces.acquire());
    } catch {
      // the real submission reports its own errors
    }
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

    let nonce: number;
    let supersede = false;
    if (opts.critical && this.nonces.pendingCount > 0) {
      // something is in flight (possibly stuck): replace the lowest unconfirmed transaction
      nonce = await this.chain.confirmedNonce();
      this.nonces.adopt(nonce);
      supersede = true;
      // 30 % over what was sent there (the replacement rule asks for 10 % on both fields)
      const old = this.feeAt.get(nonce) ?? { maxFee: cap, tip };
      const beatFee = (old.maxFee * 13n) / 10n;
      const beatTip = (old.tip * 13n) / 10n + 1n;
      if (maxFee < beatFee) maxFee = beatFee;
      if (tip < beatTip) tip = beatTip;
      if (tip > maxFee) tip = maxFee;
    } else {
      nonce = await this.nonces.acquire();
    }
    const hashes: Hex[] = [];
    const sentAtMs = this.now();
    let attempts = 0;
    const send = async (): Promise<Hex> => {
      attempts += 1;
      this.feeAt.set(nonce, { maxFee, tip });
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
        if (isNonceTooLow(e) && hashes.length === 0 && !supersede) {
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
        if (r) return this.finish(kind, nonce, attempts, sentAtMs, gas as bigint, r);
      }
      if (this.now() - lastSent >= this.cfg.stuckMs) {
        if ((await this.chain.confirmedNonce()) > nonce) {
          // the nonce is used: by us (mined a moment ago) or by a transaction that replaced ours
          for (const h of hashes) {
            const r = await this.chain.receipt(h);
            if (r) return this.finish(kind, nonce, attempts, sentAtMs, gas as bigint, r);
          }
          this.nonces.settle(nonce);
          this.feeAt.delete(nonce);
          throw new TxSuperseded(kind, hashes);
        }
        if (replacements >= this.cfg.maxReplacements) {
          // The nonce is still pending on the chain and would hold up everything behind it,
          // halts included: cancel it with a self-transfer that outbids it.
          if (!opts.critical) await this.cancel(nonce, maxFee);
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

  private finish(
    kind: string,
    nonce: number,
    attempts: number,
    sentAtMs: number,
    gas: bigint,
    r: TxReceipt,
  ): TxResult {
    this.nonces.settle(nonce);
    this.feeAt.delete(nonce);
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

  /** Frees a stuck nonce: a 21,000 gas self-transfer that pays 30 % more than anything sent there. */
  private async cancel(nonce: number, lastMaxFee: bigint): Promise<void> {
    const maxFee = (lastMaxFee * 13n) / 10n;
    const tip = ((this.feeAt.get(nonce)?.tip ?? maxFee / 4n) * 13n) / 10n + 1n;
    try {
      const hash = await this.chain.sendTx({
        to: this.chain.address,
        data: "0x",
        gas: 21_000n,
        nonce,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: tip > maxFee ? maxFee : tip,
      });
      const until = this.now() + this.cfg.stuckMs * 2;
      while (this.now() < until) {
        if (await this.chain.receipt(hash)) break;
        if ((await this.chain.confirmedNonce()) > nonce) break;
        await this.sleep(this.cfg.pollMs);
      }
      if ((await this.chain.confirmedNonce()) > nonce) {
        this.nonces.settle(nonce);
        this.feeAt.delete(nonce);
      }
    } catch {
      // the cancel is best effort: the timeout is reported either way
    }
  }
}
