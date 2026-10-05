import { cpus } from "node:os";
import { Worker } from "node:worker_threads";
import type { Done, Job } from "./worker";
import type { RunResult, SimConfig } from "./types";

export type Cell = { name: string; cfg: SimConfig; slim?: boolean };

/**
 * Runs simulations on a pool of worker threads. Every cell is a pure function of its config and
 * the pinned data, so the result does not depend on scheduling: results come back in input order.
 */
export async function runCells(
  cells: Cell[],
  labels: string[] = ["BTC/USD", "ETH/USD"],
  opts: { workers?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<RunResult[]> {
  const size = Math.max(1, Math.min(opts.workers ?? Math.max(1, cpus().length - 2), cells.length));
  const results: RunResult[] = new Array(cells.length);
  let next = 0;
  let done = 0;
  const workers: Worker[] = [];
  await new Promise<void>((resolve, reject) => {
    const feed = (w: Worker) => {
      if (next >= cells.length) return;
      const id = next++;
      const c = cells[id]!;
      w.postMessage({ id, cfg: c.cfg, slim: c.slim ?? true } satisfies Job);
    };
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL("./worker-boot.mjs", import.meta.url), {
        workerData: labels,
      });
      workers.push(w);
      w.on("message", (m: Done) => {
        results[m.id] = m.result;
        done++;
        opts.onProgress?.(done, cells.length);
        if (done === cells.length) resolve();
        else feed(w);
      });
      w.on("error", reject);
      feed(w);
    }
  }).finally(() => workers.forEach((w) => void w.terminate()));
  return results;
}
