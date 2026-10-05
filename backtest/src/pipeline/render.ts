import { join } from "node:path";
import {
  barsSvg,
  C,
  heatmapSvg,
  histogramSvg,
  lineSvg,
  writeChart,
  type BarGroup,
  type Series,
} from "./charts";
import type { Experiments } from "./experiments";
import type { CalibrationRow, WindowSummary } from "./stages";
import { SCENARIOS } from "./config";
import { HOLDOUT, TRAIN } from "../tune";
import type { DailyRow } from "../types";

type Headline = {
  set: string;
  scenario: string;
  all: WindowSummary;
  holdout: WindowSummary;
  daily: DailyRow[];
};

export function renderCharts(ctx: {
  outDir: string;
  headlines: Headline[];
  exp: Experiments;
  calib: CalibrationRow[];
  sets: string[];
}): void {
  const out = (f: string) => join(ctx.outDir, f);
  const H = (set: string, sc: string) =>
    ctx.headlines.find((h) => h.set === set && h.scenario === sc)!;
  const holdoutIdx = H("prop-tuned", "base").daily.findIndex((d) => d.day >= HOLDOUT.start);

  // cumulative P&L: realized (solid) vs expected edge (dashed)
  const cum = (set: string, title: string, file: string) => {
    const colors: Record<string, string> = { base: C.blue, pessimistic: C.green, sniper: C.orange };
    const series: Series[] = [];
    for (const sc of ["base", "pessimistic", "sniper"]) {
      const d = H(set, sc).daily;
      let r = 0;
      let e = 0;
      const real: [number, number][] = [[0, 0]];
      const exp: [number, number][] = [[0, 0]];
      d.forEach((row, i) => {
        r += row.pnl;
        e +=
          row.edgeNoise +
          row.feeIncome -
          row.gasUsd -
          row.redeemFees +
          Math.min(0, row.edgeInformed);
        real.push([i + 1, r]);
        exp.push([i + 1, e]);
      });
      series.push({ name: `${SCENARIOS[sc]!.label}: realized`, color: colors[sc]!, points: real });
      series.push({
        name: `${SCENARIOS[sc]!.label}: expected edge`,
        color: colors[sc]!,
        points: exp,
        dashed: true,
      });
    }
    writeChart(
      out(file),
      lineSvg({
        title,
        subtitle: `Cumulative net P&L in $ on a $5,000 vault, ${TRAIN.start} to ${HOLDOUT.end} (shaded: out-of-sample hold-out)`,
        xLabel: "day of the backtest",
        yLabel: "cumulative $",
        series,
        zeroLine: true,
        shade: { from: holdoutIdx, to: H(set, "base").daily.length, label: "hold-out" },
        h: 480,
      }),
    );
  };
  cum("prop-tuned", "Proposed design with launch parameters", "cumulative_proposed.png");
  cum("spec-tuned", "Design as specified (best parameters found)", "cumulative_specified.png");

  // per-day decomposition on the hold-out
  const groups: BarGroup[] = [];
  for (const set of ["spec-tuned", "prop-tuned"]) {
    for (const sc of ["pessimistic", "sniper"]) {
      const w = H(set, sc).holdout;
      const n = Math.max(1, w.days);
      groups.push({
        label: `${set === "spec-tuned" ? "Specified" : "Proposed"} / ${sc === "sniper" ? "sniper" : "pessimistic"}`,
        bars: [
          { name: "spread capture (noise)", value: w.edgeNoise / n, color: C.blue },
          { name: "adverse selection (informed)", value: w.edgeInformed / n, color: C.orange },
          { name: "gas", value: -w.gasUsd / n, color: C.purple },
          { name: "expected net edge", value: w.expectedPerDay, color: C.ink },
        ],
      });
    }
  }
  writeChart(
    out("decomposition.png"),
    barsSvg({
      title: "Where the money comes from and goes ($/day, hold-out)",
      subtitle:
        "Expected net edge excludes the zero-mean outcome residual and does not count informed traders' losses as income",
      yLabel: "$ per day",
      groups,
    }),
  );

  for (const g of ctx.exp.grids) {
    writeChart(
      out(`heatmap_${g.id}.png`),
      heatmapSvg({
        title: g.title,
        subtitle: g.note,
        xLabel: g.xLabel,
        yLabel: g.yLabel,
        xs: g.xs.map((x) =>
          g.id === "H1" || g.id === "H5" || g.id === "H3" ? String(x) : String(x),
        ),
        ys: g.ys,
        values: g.cells.map((row) => row.map((c) => c.expectedPerDay)),
      }),
    );
  }

  const vol = ctx.exp.curves.find((c) => c.id === "volume")!;
  writeChart(
    out("curve_volume.png"),
    lineSvg({
      title: "Break-even: expected net edge vs offered noise volume",
      subtitle:
        "Pessimistic informed flow. Offered volume; the vault fills only what the cost tolerance and its depth allow.",
      xLabel: "offered noise volume ($/hour per market, log scale)",
      yLabel: "expected net edge $/day",
      series: vol.rows.map((r, k) => ({
        name: r.label,
        color: [C.blue, C.orange][k]!,
        points: vol.xs.map((x, idx) => [x, r.points[idx]!.expectedPerDay] as [number, number]),
      })),
      logX: true,
      zeroLine: true,
    }),
  );
  const tvl = ctx.exp.curves.find((c) => c.id === "tvl")!;
  writeChart(
    out("curve_tvl.png"),
    lineSvg({
      title: "LP return by TVL (taker flow held fixed)",
      subtitle:
        "Expected net edge as % of TVL, annualized. Return per $ falls with TVL because flow, not capital, limits earnings.",
      xLabel: "TVL ($, log scale)",
      yLabel: "expected APY (%)",
      series: tvl.rows.map((r, i) => ({
        name: r.label,
        color: [C.green, C.blue][i]!,
        points: tvl.xs.map((x, j) => [x, r.points[j]!.expectedApyPct] as [number, number]),
      })),
      logX: true,
      zeroLine: true,
    }),
  );
  const tol = ctx.exp.curves.find((c) => c.id === "tolerance")!;
  writeChart(
    out("curve_tolerance.png"),
    lineSvg({
      title: "Sensitivity to noise-taker price elasticity",
      subtitle:
        "Mean maximum cost a noise order accepts (fraction of notional); 1.0 stands for fully inelastic flow.",
      xLabel: "mean acceptable cost",
      yLabel: "expected net edge $/day",
      series: [
        {
          name: tol.rows[0]!.label,
          color: C.blue,
          points: tol.xs.map((x, i) => [x, tol.rows[0]!.points[i]!.expectedPerDay]),
        },
      ],
      zeroLine: true,
    }),
  );

  const cal = ctx.calib.filter(
    (r) =>
      (r.asset === "BTC/USD" && r.round === "15m" && r.tauSec === 300) ||
      (r.asset === "ETH/USD" && r.round === "15m" && r.tauSec === 300) ||
      (r.asset === "BTC/USD" && r.round === "1h" && r.tauSec === 600),
  );
  writeChart(
    out("calibration.png"),
    lineSvg({
      title: "Fair-probability model is calibrated on real rounds",
      subtitle:
        "Predicted probability of UP (binned) vs observed frequency, 90 days; the dashed line is perfect calibration.",
      xLabel: "model probability of UP",
      yLabel: "observed frequency of UP",
      series: [
        {
          name: "perfect",
          color: C.mute,
          points: [
            [0, 0],
            [1, 1],
          ],
          dashed: true,
        },
        ...cal.map((r, i) => ({
          name: `${r.asset} ${r.round}, ${r.tauSec}s before expiry`,
          color: [C.blue, C.green, C.orange][i]!,
          points: r.bins.map((b) => [b.p, b.freq] as [number, number]),
        })),
      ],
      xTickLabels: (x) => x.toFixed(1),
    }),
  );
  const d = H("prop-tuned", "pessimistic").daily.map((r) => r.pnl);
  writeChart(
    out("daily_pnl_proposed.png"),
    histogramSvg({
      title: "Daily net P&L, proposed design, pessimistic scenario",
      subtitle: "Realized, all 90 days ($)",
      xLabel: "daily net P&L ($)",
      values: d,
    }),
  );
}
