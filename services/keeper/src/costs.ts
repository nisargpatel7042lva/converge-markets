import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TxResult } from "./chain/tx";

export type CostRow = {
  atMs: number;
  kind: string;
  hash: string;
  block: string;
  status: string;
  gasLimit: string;
  gasUsed: string;
  effectiveGasPriceWei: string;
  /** Monad bills the limit, so this is gasLimit x price. */
  costWei: string;
  latencyMs: number;
  attempts: number;
};

/** Appends one JSON line per transaction: the raw material of docs/evidence/phase-5/costs.md. */
export class CostLedger {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  record(r: TxResult, atMs = Date.now()): CostRow {
    const row: CostRow = {
      atMs,
      kind: r.kind,
      hash: r.hash,
      block: r.blockNumber.toString(),
      status: r.status,
      gasLimit: r.gasLimit.toString(),
      gasUsed: r.gasUsed.toString(),
      effectiveGasPriceWei: r.effectiveGasPrice.toString(),
      costWei: r.costWei.toString(),
      latencyMs: r.latencyMs,
      attempts: r.attempts,
    };
    appendFileSync(this.path, `${JSON.stringify(row)}\n`);
    return row;
  }
}

export type KindSummary = {
  kind: string;
  count: number;
  avgGasLimit: number;
  avgGasUsed: number;
  avgCostMon: number;
  totalCostMon: number;
  p95LatencyMs: number;
};

const MON = 1e18;
function pct(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
}

export function summarize(rows: readonly CostRow[]): KindSummary[] {
  const by = new Map<string, CostRow[]>();
  for (const r of rows) by.set(r.kind, [...(by.get(r.kind) ?? []), r]);
  return [...by.entries()]
    .map(([kind, rs]) => {
      const cost = rs.map((r) => Number(r.costWei) / MON);
      return {
        kind,
        count: rs.length,
        avgGasLimit: rs.reduce((a, r) => a + Number(r.gasLimit), 0) / rs.length,
        avgGasUsed: rs.reduce((a, r) => a + Number(r.gasUsed), 0) / rs.length,
        avgCostMon: cost.reduce((a, b) => a + b, 0) / rs.length,
        totalCostMon: cost.reduce((a, b) => a + b, 0),
        p95LatencyMs: pct(
          rs.map((r) => r.latencyMs),
          0.95,
        ),
      };
    })
    .sort((a, b) => b.totalCostMon - a.totalCostMon);
}
