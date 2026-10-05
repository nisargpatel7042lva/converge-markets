/**
 * Fast determinism check for `make check-3`: the same cells simulated twice on the worker pool
 * (different scheduling) must give byte-identical results. The full pipeline's determinism is
 * checked by running `pnpm backtest` twice (docs/evidence/phase-3/determinism.txt).
 */
import { createHash } from "node:crypto";
import { DEFAULT_PARAMS } from "@converge/strategy";
import { runCells } from "./pool";
import { DESIGNS, SCENARIOS } from "./pipeline/config";
import { cellFor } from "./pipeline/stages";

const w = { start: "2026-08-10", end: "2026-08-13", stride: 1, offset: 0 };
const cells = Object.entries(SCENARIOS).flatMap(([sc, s]) =>
  Object.entries(DESIGNS).map(([d, def]) =>
    cellFor(`${d}|${sc}`, DEFAULT_PARAMS, s.flow, def.venue, w, { slim: false }),
  ),
);
const hash = async (workers: number) =>
  createHash("sha256")
    .update(JSON.stringify(await runCells(cells, undefined, { workers })))
    .digest("hex");
const a = await hash(4);
const b = await hash(7); // a different pool size changes scheduling, never results
console.log(`run 1: ${a}\nrun 2: ${b}`);
if (a !== b) {
  console.error("NOT DETERMINISTIC");
  process.exit(1);
}
console.log("deterministic: OK");
