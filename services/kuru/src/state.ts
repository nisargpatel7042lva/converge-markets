import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address, Hex } from "viem";

export interface TxNote {
  step: string;
  hash: Hex;
  /** Gas limit sent: what Monad bills. */
  gasLimit: string;
  at: number;
}

export interface KuruRound {
  converge: Address;
  up: Address;
  down: Address;
  kuru: Address;
  start: number;
  end: number;
  strike: number;
  status: "listed" | "quoting" | "closed" | "redeemed";
  seeded: boolean;
  orderIds: string[];
  lastQuote: { fair: number; bid: number; ask: number; at: number } | null;
  quotes: number;
  txs: TxNote[];
}

export interface KuruState {
  chainId: number;
  router: Address;
  marginAccount: Address;
  maker: Address;
  rounds: Record<string, KuruRound>;
}

export function loadState(path: string, init: () => KuruState): KuruState {
  if (!existsSync(path)) return init();
  return JSON.parse(readFileSync(path, "utf8")) as KuruState;
}

export function saveState(path: string, s: KuruState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(s, null, 2) + "\n");
}
