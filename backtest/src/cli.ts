/**
 * `pnpm backtest`: regenerates the whole economic report from the pinned data.
 * Deterministic: fixed seeds, no wall-clock values in any output.
 *   --quick       small windows and search (smoke test of the pipeline, not a result)
 *   --skip-tune   reuse report/tuning.json (parameters found by an earlier full run)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PARAMS, validateParams, type StrategyParams } from "@converge/strategy";
import { DATA_ROOT } from "./data/binance";
import { runCells } from "./pool";
import { DESIGNS, FULL, NAV0, QUICK, SCENARIOS } from "./pipeline/config";
import { runExperiments, type Experiments } from "./pipeline/experiments";
import {
  calibration,
  cellFor,
  classifyWindow,
  dataStats,
  pooledOptimalScale,
  summarizeDays,
  tuneDesign,
  type CalibrationRow,
  type Candidate,
  type DataStats,
  type WindowSummary,
} from "./pipeline/stages";
import { renderCharts } from "./pipeline/render";
import { buildReport, type BasisFile } from "./pipeline/report";
import { HOLDOUT, TRAIN } from "./tune";
import type { DailyRow } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = join(HERE, "..", "report");
const argv = process.argv.slice(2);
const quick = argv.includes("--quick");
const skipTune = argv.includes("--skip-tune");
const q = quick ? QUICK : FULL;
const outDir = quick ? join(OUT, "quick") : OUT;
const log = (m: string) => console.log(m);

mkdirSync(join(outDir, "charts"), { recursive: true });

// --report-only: rebuild REPORT.md from the saved results.json (wording iterations take seconds).
if (argv.includes("--report-only")) {
  const saved = JSON.parse(readFileSync(join(outDir, "results.json"), "utf8")) as {
    meta: { manifestSha256: string; quick: boolean };
    data: DataStats[];
    calibration: CalibrationRow[];
    calibrationLaunch: CalibrationRow[];
    chainlinkBasis: BasisFile | null;
    tuning: {
      specified: Candidate;
      proposed: Candidate;
      specifiedAll: unknown[];
      proposedAll: unknown[];
    };
    headlines: Omit<Headline, "daily">[];
    verdicts: Parameters<typeof buildReport>[0]["verdicts"];
    experiments: Experiments;
  };
  const setDefs = [
    {
      id: "spec-default",
      label: "As specified, CLAUDE.md defaults",
      params: DEFAULT_PARAMS,
      design: "specified" as const,
    },
    {
      id: "spec-tuned",
      label: "As specified, tuned",
      params: saved.tuning.specified.params,
      design: "specified" as const,
    },
    {
      id: "prop-default",
      label: "Proposed design, CLAUDE.md defaults",
      params: DEFAULT_PARAMS,
      design: "proposed" as const,
    },
    {
      id: "prop-tuned",
      label: "Proposed design, tuned (launch parameters)",
      params: saved.tuning.proposed.params,
      design: "proposed" as const,
    },
  ];
  const md = buildReport({
    quick: saved.meta.quick,
    manifestSha: saved.meta.manifestSha256,
    stats: saved.data,
    calib: saved.calibration,
    calibLaunch: saved.calibrationLaunch,
    headlines: saved.headlines.map((h) => ({ ...h, daily: [] })),
    verdicts: saved.verdicts,
    exp: saved.experiments,
    tuned: saved.tuning as Parameters<typeof buildReport>[0]["tuned"],
    specTuned: saved.tuning.specified.params,
    propTuned: saved.tuning.proposed.params,
    sets: setDefs,
    q,
    basis: saved.chainlinkBasis,
  });
  writeFileSync(join(outDir, "REPORT.md"), md);
  console.log(`rebuilt ${join(outDir, "REPORT.md")}`);
  process.exit(0);
}

// ---- data diagnostics
log("data diagnostics ...");
const stats = dataStats();
const calib = calibration();

// ---- tuning
const TUNE_SEED = 20261004;
// Fat-tail volatility multiplier from calibration on the TRAIN window only (never searched).
const calScale = pooledOptimalScale(TRAIN.end);
log(`calibrated volatility multiplier (train window): ${calScale}`);
type AllRow = { id: string; combined: number; pessimistic: number; sniper: number };
type Tuned = {
  specified: Candidate;
  proposed: Candidate;
  specifiedTop: Candidate[];
  proposedTop: Candidate[];
  specifiedAll: AllRow[];
  proposedAll: AllRow[];
};
const slimAll = (cs: Candidate[]): AllRow[] =>
  cs.map((c) => ({
    id: c.id,
    combined: c.screen.combined,
    pessimistic: c.screen.pessimistic.expectedPerDay,
    sniper: c.screen.sniper.expectedPerDay,
  }));
const tuningFile = join(OUT, "tuning.json");
let tuned: Tuned;
if (skipTune && existsSync(tuningFile)) {
  tuned = JSON.parse(readFileSync(tuningFile, "utf8")) as Tuned;
  log("reusing tuning.json");
} else {
  const s = await tuneDesign("specified", q, TUNE_SEED, log, calScale);
  const p = await tuneDesign("proposed", q, TUNE_SEED + 1, log, calScale);
  tuned = {
    specified: s.winner,
    proposed: p.winner,
    specifiedTop: s.candidates.slice(0, 10),
    proposedTop: p.candidates.slice(0, 10),
    specifiedAll: slimAll(s.candidates),
    proposedAll: slimAll(p.candidates),
  };
  if (!quick) writeFileSync(tuningFile, JSON.stringify(tuned, null, 1) + "\n");
}
const specTuned = validateParams(tuned.specified.params);
const propTuned = validateParams(tuned.proposed.params);

// ---- headline runs: the whole 90 days, per parameter set x design x scenario
type SetDef = {
  id: string;
  label: string;
  params: StrategyParams;
  design: "specified" | "proposed";
};
const sets: SetDef[] = [
  {
    id: "spec-default",
    label: "As specified, CLAUDE.md defaults",
    params: DEFAULT_PARAMS,
    design: "specified",
  },
  { id: "spec-tuned", label: "As specified, tuned", params: specTuned, design: "specified" },
  {
    id: "prop-default",
    label: "Proposed design, CLAUDE.md defaults",
    params: DEFAULT_PARAMS,
    design: "proposed",
  },
  {
    id: "prop-tuned",
    label: "Proposed design, tuned (launch parameters)",
    params: propTuned,
    design: "proposed",
  },
];
const scenarioIds = Object.keys(SCENARIOS);
const full = { start: TRAIN.start, end: HOLDOUT.end, stride: quick ? q.holdStride : 1, offset: 0 };
log(`headline runs: ${sets.length * scenarioIds.length} simulations`);
const headCells = sets.flatMap((s) =>
  scenarioIds.map((sc) =>
    cellFor(`${s.id}|${sc}`, s.params, SCENARIOS[sc]!.flow, DESIGNS[s.design]!.venue, full, {
      slim: false,
    }),
  ),
);
const headRes = await runCells(headCells, undefined, {
  onProgress: (d, t) => log(`  headline ${d}/${t}`),
});
// The hold-out is an independent restart (fresh NAV, no carry-over from training), 30 days.
const holdW = {
  start: HOLDOUT.start,
  end: HOLDOUT.end,
  stride: quick ? q.holdStride : 1,
  offset: 0,
};
const holdCells = sets.flatMap((s) =>
  scenarioIds.map((sc) =>
    cellFor(`${s.id}|${sc}|hold`, s.params, SCENARIOS[sc]!.flow, DESIGNS[s.design]!.venue, holdW, {
      slim: false,
    }),
  ),
);
log(`hold-out restarts: ${holdCells.length} simulations`);
const holdRes = await runCells(holdCells, undefined, {
  onProgress: (d, t) => log(`  hold-out ${d}/${t}`),
});

export type Headline = {
  set: string;
  scenario: string;
  all: WindowSummary;
  train: WindowSummary;
  holdout: WindowSummary;
  byMarket: Record<
    string,
    { rounds: number; pnl: number; edgeNoise: number; edgeInformed: number; residual: number }
  >;
  daily: DailyRow[];
  venue: { quoteUptimePct: number; gasUsdPerDay: number; repostBlocks: number };
  risk: {
    maxDrawdownPct: number;
    peakAtRiskPct: number;
    meanAbsInventoryShares: number;
    p95AbsInventoryShares: number;
  };
  flow: {
    noiseOrders: number;
    noiseOrdersUnfilled: number;
    informedOrders: number;
    informedOrdersTraded: number;
  };
  rounds: { winRatePct: number; stdPnl: number; p5: number; p95: number };
};
const headlines: Headline[] = [];
sets.forEach((s, si) =>
  scenarioIds.forEach((sc, ci) => {
    const r = headRes[si * scenarioIds.length + ci]!;
    const days = r.daily;
    const isHold = (d: DailyRow) => d.day >= HOLDOUT.start;
    headlines.push({
      set: s.id,
      scenario: sc,
      all: summarizeDays(days, NAV0, 11),
      train: summarizeDays(
        days.filter((d) => !isHold(d)),
        NAV0,
        12,
      ),
      holdout: summarizeDays(holdRes[si * scenarioIds.length + ci]!.daily, NAV0, 13),
      byMarket: r.byMarket,
      daily: days,
      venue: {
        quoteUptimePct: r.venue.quoteUptimePct,
        gasUsdPerDay: r.venue.gasUsdPerDay,
        repostBlocks: r.venue.repostBlocks,
      },
      risk: {
        maxDrawdownPct: r.risk.maxDrawdownPct,
        peakAtRiskPct: r.risk.peakAtRiskPct,
        meanAbsInventoryShares: r.risk.meanAbsInventoryShares,
        p95AbsInventoryShares: r.risk.p95AbsInventoryShares,
      },
      flow: {
        noiseOrders: r.flow.noiseOrders,
        noiseOrdersUnfilled: r.flow.noiseOrdersUnfilled,
        informedOrders: r.flow.informedOrders,
        informedOrdersTraded: r.flow.informedOrdersTraded,
      },
      rounds: {
        winRatePct: r.rounds_.winRatePct,
        stdPnl: r.rounds_.stdPnl,
        p5: r.rounds_.p5,
        p95: r.rounds_.p95,
      },
    });
  }),
);
const H = (set: string, sc: string) => headlines.find((h) => h.set === set && h.scenario === sc)!;

// ---- verdict (rule fixed in the report's Method section)
const verdictOf = (set: string) => {
  const per = { pessimistic: H(set, "pessimistic").holdout, sniper: H(set, "sniper").holdout };
  const cls = { pessimistic: classifyWindow(per.pessimistic), sniper: classifyWindow(per.sniper) };
  const order = ["UNPROFITABLE", "MARGINAL", "PROFITABLE"] as const;
  const worst = order[Math.min(order.indexOf(cls.pessimistic), order.indexOf(cls.sniper))]!;
  return { per, cls, worst };
};
const verdicts = {
  specTuned: verdictOf("spec-tuned"),
  specDefault: verdictOf("spec-default"),
  propTuned: verdictOf("prop-tuned"),
};

// ---- experiments (sweeps, design table, curves)
const exp: Experiments = await runExperiments({ specTuned, propTuned, q, log });

const calibLaunch = calibration(propTuned.vol.scale);

// ---- outputs
const manifestPath = join(DATA_ROOT, "manifest.json");
const basisPath = join(DATA_ROOT, "chainlink-basis.json");
const basis: BasisFile | null = existsSync(basisPath)
  ? (JSON.parse(readFileSync(basisPath, "utf8")) as BasisFile)
  : null;
const manifestSha = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
const results = {
  meta: {
    command: "pnpm backtest",
    seed: TUNE_SEED,
    calibratedVolScale: calScale,
    quick,
    manifestSha256: manifestSha,
    windows: { train: TRAIN, holdout: HOLDOUT },
    nav0: NAV0,
  },
  data: stats,
  chainlinkBasis: basis,
  calibration: calib,
  calibrationLaunch: calibLaunch,
  tuning: {
    specified: tuned.specified,
    proposed: tuned.proposed,
    specifiedTop: tuned.specifiedTop,
    proposedTop: tuned.proposedTop,
    specifiedAll: tuned.specifiedAll,
    proposedAll: tuned.proposedAll,
  },
  headlines: headlines.map(({ daily, ...h }) => ({ ...h, dailySummary: { days: daily.length } })),
  verdicts,
  experiments: exp,
};
writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 1) + "\n");

log("charts ...");
renderCharts({
  outDir: join(outDir, "charts"),
  headlines,
  exp,
  calib,
  sets: sets.map((s) => s.id),
});

const report = buildReport({
  quick,
  manifestSha,
  stats,
  calib,
  calibLaunch,
  headlines,
  verdicts,
  exp,
  tuned: {
    specified: tuned.specified,
    proposed: tuned.proposed,
    specifiedAll: tuned.specifiedAll,
    proposedAll: tuned.proposedAll,
  },
  specTuned,
  propTuned,
  sets,
  q,
  basis,
});
writeFileSync(join(outDir, "REPORT.md"), report);

if (!quick) {
  const cfgPath = join(ROOT, "config", "strategy.default.json");
  const cfg = {
    version: 1,
    note: "Launch parameters chosen by `pnpm backtest` (see backtest/report/REPORT.md, section 'Launch parameters'). Valid for the forward-priced execution design only.",
    design: {
      quoteMode: "swapTime",
      execDelayBlocks: DESIGNS.proposed!.venue.execDelayBlocks,
      blockMs: 400,
    },
    params: propTuned,
    provenance: {
      report: "backtest/report/REPORT.md",
      dataManifestSha256: manifestSha,
      seed: TUNE_SEED,
      trainWindow: TRAIN,
      holdoutWindow: HOLDOUT,
    },
  };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
}
log(`done -> ${outDir}`);
