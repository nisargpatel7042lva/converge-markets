import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FONTS = [
  join(HERE, "..", "..", "assets", "fonts", "DejaVuSans.ttf"),
  join(HERE, "..", "..", "assets", "fonts", "DejaVuSans-Bold.ttf"),
];

// Okabe-Ito: distinguishable under the common colour-vision deficiencies.
export const C = {
  blue: "#0072B2",
  orange: "#D55E00",
  green: "#009E73",
  purple: "#CC79A7",
  sky: "#56B4E9",
  yellow: "#E69F00",
  ink: "#1b1b1b",
  grid: "#dddddd",
  mute: "#666666",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (v: number, d = 0) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(d));

export function renderPng(svg: string, file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const png = new Resvg(svg, {
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "DejaVu Sans" },
    fitTo: { mode: "zoom", value: 2 },
  })
    .render()
    .asPng();
  writeFileSync(file, png);
}

function frame(w: number, h: number, title: string, body: string, subtitle = ""): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="DejaVu Sans">
<rect width="${w}" height="${h}" fill="#ffffff"/>
<text x="20" y="28" font-size="16" font-weight="bold" fill="${C.ink}">${esc(title)}</text>
${subtitle ? `<text x="20" y="46" font-size="11" fill="${C.mute}">${esc(subtitle)}</text>` : ""}
${body}
</svg>`;
}

/** Diverging fill: orange below zero, blue above, white at zero; saturation scales to `scale`. */
function diverging(v: number, scale: number): string {
  const t = Math.max(-1, Math.min(1, v / scale));
  const mix = (a: number, b: number, k: number) => Math.round(a + (b - a) * k);
  const [r, g, b] = t >= 0 ? [0, 114, 178] : [213, 94, 0];
  const k = Math.abs(t) * 0.85;
  return `rgb(${mix(255, r, k)},${mix(255, g, k)},${mix(255, b, k)})`;
}

export function heatmapSvg(o: {
  title: string;
  subtitle?: string;
  xLabel: string;
  yLabel: string;
  xs: (number | string)[];
  ys: (number | string)[];
  values: number[][];
  unit?: string;
}): string {
  const cw = 78;
  const ch = 44;
  const left = 110;
  const top = 78;
  const W = left + cw * o.xs.length + 40;
  const H = top + ch * o.ys.length + 70;
  const flat = o.values.flat();
  const scale = Math.max(1e-9, ...flat.map((v) => Math.abs(v)));
  let g = "";
  o.values.forEach((row, r) =>
    row.forEach((v, c) => {
      const x = left + c * cw;
      const y = top + r * ch;
      const dark = Math.abs(v) / scale > 0.55;
      g += `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" fill="${diverging(v, scale)}" stroke="#fff" stroke-width="1"/>`;
      g += `<text x="${x + cw / 2}" y="${y + ch / 2 + 4}" font-size="12" text-anchor="middle" fill="${dark ? "#fff" : C.ink}">${v >= 0 ? "+" : "−"}${fmt(Math.abs(v), Math.abs(v) < 10 ? 1 : 0)}</text>`;
    }),
  );
  o.xs.forEach((x, c) => {
    g += `<text x="${left + c * cw + cw / 2}" y="${top + ch * o.ys.length + 16}" font-size="11" text-anchor="middle" fill="${C.ink}">${esc(String(x))}</text>`;
  });
  o.ys.forEach((y, r) => {
    g += `<text x="${left - 8}" y="${top + r * ch + ch / 2 + 4}" font-size="11" text-anchor="end" fill="${C.ink}">${esc(String(y))}</text>`;
  });
  g += `<text x="${left + (cw * o.xs.length) / 2}" y="${top + ch * o.ys.length + 40}" font-size="12" text-anchor="middle" fill="${C.mute}">${esc(o.xLabel)}</text>`;
  g += `<text transform="translate(18 ${top + (ch * o.ys.length) / 2}) rotate(-90)" font-size="12" text-anchor="middle" fill="${C.mute}">${esc(o.yLabel)}</text>`;
  g += `<text x="${W - 20}" y="${H - 8}" font-size="10" text-anchor="end" fill="${C.mute}">${esc(o.unit ?? "$/day, expected net edge")}; blue = profit, orange = loss</text>`;
  return frame(W, H, o.title, g, o.subtitle);
}

export type Series = { name: string; color: string; points: [number, number][]; dashed?: boolean };

function niceTicks(lo: number, hi: number, n = 5): number[] {
  if (hi === lo) return [lo];
  const raw = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step)
    out.push(Math.round(v / step) * step);
  return out;
}

export function lineSvg(o: {
  title: string;
  subtitle?: string;
  xLabel: string;
  yLabel: string;
  series: Series[];
  logX?: boolean;
  shade?: { from: number; to: number; label: string };
  zeroLine?: boolean;
  xTickLabels?: (x: number) => string;
  w?: number;
  h?: number;
}): string {
  const W = o.w ?? 760;
  const H = o.h ?? 420;
  const L = 78;
  const R = 24;
  const T = 66;
  const B = 56 + 18 * Math.ceil(o.series.length / 3);
  const xs = o.series.flatMap((s) => s.points.map((p) => p[0]));
  const ys = o.series.flatMap((s) => s.points.map((p) => p[1]));
  const tx = (x: number) => (o.logX ? Math.log10(x) : x);
  const x0 = Math.min(...xs.map(tx));
  const x1 = Math.max(...xs.map(tx));
  let y0 = Math.min(...ys, o.zeroLine ? 0 : Infinity);
  let y1 = Math.max(...ys, o.zeroLine ? 0 : -Infinity);
  const pad = (y1 - y0) * 0.06 || 1;
  y0 -= pad;
  y1 += pad;
  const px = (x: number) => L + ((tx(x) - x0) / (x1 - x0 || 1)) * (W - L - R);
  const py = (y: number) => T + (1 - (y - y0) / (y1 - y0 || 1)) * (H - T - B);
  let g = "";
  for (const t of niceTicks(y0, y1)) {
    g += `<line x1="${L}" x2="${W - R}" y1="${py(t)}" y2="${py(t)}" stroke="${C.grid}"/><text x="${L - 8}" y="${py(t) + 4}" font-size="11" text-anchor="end" fill="${C.ink}">${fmt(t, Math.abs(t) < 10 ? 1 : 0)}</text>`;
  }
  const xt = o.logX ? [...new Set(xs)].sort((a, b) => a - b) : niceTicks(x0, x1, 6);
  for (const t of xt) {
    g += `<line x1="${px(t)}" x2="${px(t)}" y1="${T}" y2="${H - B}" stroke="${C.grid}"/><text x="${px(t)}" y="${H - B + 16}" font-size="11" text-anchor="middle" fill="${C.ink}">${o.xTickLabels ? o.xTickLabels(t) : fmt(t, 0)}</text>`;
  }
  if (o.shade)
    g += `<rect x="${px(o.shade.from)}" y="${T}" width="${px(o.shade.to) - px(o.shade.from)}" height="${H - T - B}" fill="${C.sky}" opacity="0.15"/><text x="${px(o.shade.from) + 6}" y="${T + 14}" font-size="11" fill="${C.mute}">${esc(o.shade.label)}</text>`;
  if (o.zeroLine && y0 < 0 && y1 > 0)
    g += `<line x1="${L}" x2="${W - R}" y1="${py(0)}" y2="${py(0)}" stroke="${C.ink}" stroke-width="1.2"/>`;
  o.series.forEach((s) => {
    const d = s.points
      .map((p, i) => `${i ? "L" : "M"}${px(p[0]).toFixed(1)} ${py(p[1]).toFixed(1)}`)
      .join(" ");
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2" ${s.dashed ? 'stroke-dasharray="6 4"' : ""}/>`;
    if (s.points.length <= 12)
      for (const p of s.points)
        g += `<circle cx="${px(p[0])}" cy="${py(p[1])}" r="3.2" fill="${s.color}"/>`;
  });
  g += `<text x="${L + (W - L - R) / 2}" y="${H - B + 36}" font-size="12" text-anchor="middle" fill="${C.mute}">${esc(o.xLabel)}</text>`;
  g += `<text transform="translate(18 ${T + (H - T - B) / 2}) rotate(-90)" font-size="12" text-anchor="middle" fill="${C.mute}">${esc(o.yLabel)}</text>`;
  o.series.forEach((s, i) => {
    const lx = L + (i % 3) * 230;
    const ly = H - 18 * Math.ceil(o.series.length / 3) + 18 * Math.floor(i / 3) + 4;
    g += `<line x1="${lx}" x2="${lx + 22}" y1="${ly}" y2="${ly}" stroke="${s.color}" stroke-width="2.4" ${s.dashed ? 'stroke-dasharray="6 4"' : ""}/><text x="${lx + 28}" y="${ly + 4}" font-size="11" fill="${C.ink}">${esc(s.name)}</text>`;
  });
  return frame(W, H, o.title, g, o.subtitle);
}

export type BarGroup = { label: string; bars: { name: string; value: number; color: string }[] };

export function barsSvg(o: {
  title: string;
  subtitle?: string;
  yLabel: string;
  groups: BarGroup[];
  w?: number;
  h?: number;
}): string {
  const W = o.w ?? 860;
  const H = o.h ?? 440;
  const L = 78;
  const R = 24;
  const T = 66;
  const B = 120;
  const all = o.groups.flatMap((g) => g.bars.map((b) => b.value));
  let y0 = Math.min(0, ...all);
  let y1 = Math.max(0, ...all);
  const pad = (y1 - y0) * 0.08 || 1;
  y0 -= pad;
  y1 += pad;
  const py = (y: number) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  let g = "";
  for (const t of niceTicks(y0, y1))
    g += `<line x1="${L}" x2="${W - R}" y1="${py(t)}" y2="${py(t)}" stroke="${C.grid}"/><text x="${L - 8}" y="${py(t) + 4}" font-size="11" text-anchor="end" fill="${C.ink}">${fmt(t)}</text>`;
  g += `<line x1="${L}" x2="${W - R}" y1="${py(0)}" y2="${py(0)}" stroke="${C.ink}"/>`;
  const gw = (W - L - R) / o.groups.length;
  o.groups.forEach((grp, gi) => {
    const bw = Math.min(34, (gw - 16) / grp.bars.length);
    const start = L + gi * gw + (gw - bw * grp.bars.length) / 2;
    grp.bars.forEach((b, bi) => {
      const x = start + bi * bw;
      const yTop = py(Math.max(0, b.value));
      const hgt = Math.abs(py(b.value) - py(0));
      g += `<rect x="${x}" y="${yTop}" width="${bw - 3}" height="${Math.max(1, hgt)}" fill="${b.color}"/>`;
      g += `<text x="${x + (bw - 3) / 2}" y="${b.value >= 0 ? yTop - 4 : yTop + hgt + 12}" font-size="10" text-anchor="middle" fill="${C.ink}">${fmt(b.value, Math.abs(b.value) < 10 ? 1 : 0)}</text>`;
    });
    g += `<text x="${L + gi * gw + gw / 2}" y="${H - B + 20}" font-size="11" text-anchor="middle" fill="${C.ink}">${esc(grp.label)}</text>`;
  });
  const legend = [
    ...new Map(o.groups.flatMap((x) => x.bars).map((b) => [b.name, b.color])).entries(),
  ];
  legend.forEach(([n, c], i) => {
    const lx = L + (i % 4) * 190;
    const ly = H - 50 + 18 * Math.floor(i / 4);
    g += `<rect x="${lx}" y="${ly - 9}" width="12" height="12" fill="${c}"/><text x="${lx + 18}" y="${ly + 2}" font-size="11" fill="${C.ink}">${esc(n)}</text>`;
  });
  g += `<text transform="translate(18 ${T + (H - T - B) / 2}) rotate(-90)" font-size="12" text-anchor="middle" fill="${C.mute}">${esc(o.yLabel)}</text>`;
  return frame(W, H, o.title, g, o.subtitle);
}

export function histogramSvg(o: {
  title: string;
  subtitle?: string;
  xLabel: string;
  values: number[];
  bins?: number;
  color?: string;
}): string {
  const W = 760;
  const H = 380;
  const L = 70;
  const R = 24;
  const T = 66;
  const B = 56;
  const lo = Math.min(...o.values);
  const hi = Math.max(...o.values);
  const nb = o.bins ?? 24;
  const bw = (hi - lo) / nb || 1;
  const counts = new Array<number>(nb).fill(0);
  for (const v of o.values) counts[Math.min(nb - 1, Math.floor((v - lo) / bw))]!++;
  const cmax = Math.max(...counts);
  const px = (x: number) => L + ((x - lo) / (hi - lo || 1)) * (W - L - R);
  const py = (c: number) => T + (1 - c / cmax) * (H - T - B);
  let g = "";
  counts.forEach((c, i) => {
    g += `<rect x="${px(lo + i * bw) + 1}" y="${py(c)}" width="${(W - L - R) / nb - 2}" height="${H - B - py(c)}" fill="${o.color ?? C.blue}"/>`;
  });
  if (lo < 0 && hi > 0)
    g += `<line x1="${px(0)}" x2="${px(0)}" y1="${T}" y2="${H - B}" stroke="${C.ink}" stroke-width="1.5"/>`;
  for (const t of niceTicks(lo, hi, 6))
    g += `<text x="${px(t)}" y="${H - B + 16}" font-size="11" text-anchor="middle" fill="${C.ink}">${fmt(t)}</text>`;
  for (const t of niceTicks(0, cmax, 4))
    g += `<text x="${L - 8}" y="${py(t) + 4}" font-size="11" text-anchor="end" fill="${C.ink}">${t}</text>`;
  g += `<text x="${L + (W - L - R) / 2}" y="${H - 14}" font-size="12" text-anchor="middle" fill="${C.mute}">${esc(o.xLabel)}</text>`;
  g += `<text transform="translate(18 ${T + (H - T - B) / 2}) rotate(-90)" font-size="12" text-anchor="middle" fill="${C.mute}">days</text>`;
  return frame(W, H, o.title, g, o.subtitle);
}

export function writeChart(file: string, svg: string): void {
  renderPng(svg, file);
}
