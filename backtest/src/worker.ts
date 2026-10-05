/** Worker thread: loads price data once, then simulates cells sent by the pool. */
import { parentPort, workerData } from "node:worker_threads";
import { loadSeriesCached } from "./data/cache";
import { simulate } from "./sim";
import type { RunResult, SimConfig } from "./types";

const labels = workerData as string[];
const data = new Map(labels.map((l) => [l, loadSeriesCached(l)]));

export type Job = { id: number; cfg: SimConfig; slim: boolean };
export type Done = { id: number; result: RunResult };

parentPort!.on("message", (job: Job) => {
  const r = simulate(job.cfg, data);
  // Sweep cells keep only the summary (the per-day rows dominate the message size).
  const result: RunResult = job.slim ? { ...r, daily: [], byMarket: {} } : r;
  parentPort!.postMessage({ id: job.id, result } satisfies Done);
});
