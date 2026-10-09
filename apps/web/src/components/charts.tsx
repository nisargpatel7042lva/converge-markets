"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Point } from "@/lib/prices";
import { price as fmtPrice } from "@/lib/format";
import { useTween } from "./delight";

/** Shrinks a series to at most `n` points by averaging buckets, keeping the very last point exact. */
function downsample(points: Point[], n: number): Point[] {
  if (points.length <= n) return points;
  const size = points.length / n;
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * size);
    const b = Math.max(a + 1, Math.floor((i + 1) * size));
    let t = 0;
    let p = 0;
    for (let j = a; j < b; j++) {
      t += points[j]!.t;
      p += points[j]!.p;
    }
    out.push({ t: t / (b - a), p: p / (b - a) });
  }
  out[out.length - 1] = points[points.length - 1]!;
  return out;
}

/** A smooth path through the points (Catmull-Rom converted to Bezier), without overshoot past the neighbours. */
function smoothPath(xy: [number, number][]): string {
  if (xy.length === 0) return "";
  if (xy.length < 3)
    return xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  let d = `M${xy[0]![0].toFixed(1)},${xy[0]![1].toFixed(1)}`;
  for (let i = 0; i < xy.length - 1; i++) {
    const p0 = xy[i - 1] ?? xy[i]!;
    const p1 = xy[i]!;
    const p2 = xy[i + 1]!;
    const p3 = xy[i + 2] ?? p2;
    const t = 0.18;
    // control points follow the neighbours' slope but never leave the y-range of the segment
    const lo = Math.min(p1[1], p2[1]);
    const hi = Math.max(p1[1], p2[1]);
    const c1y = Math.min(hi, Math.max(lo, p1[1] + (p2[1] - p0[1]) * t));
    const c2y = Math.min(hi, Math.max(lo, p2[1] - (p3[1] - p1[1]) * t));
    const c1x = p1[0] + (p2[0] - p0[0]) * t;
    const c2x = p2[0] - (p3[0] - p1[0]) * t;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/**
 * The value range eased toward its target so the graph breathes instead of snapping when the range
 * moves. It starts AT the first real range (never easing up from zero) and snaps when the range jumps
 * by more than its own size (a new window), so a slow frame rate can never leave it half way.
 */
function useEasedRange(lo: number, hi: number, ready: boolean): [number, number] {
  const [r, setR] = useState<[number, number]>([lo, hi]);
  const target = useRef<[number, number]>([lo, hi]);
  const started = useRef(false);
  target.current = [lo, hi];
  if (ready && !started.current) {
    started.current = true;
    if (r[0] !== lo || r[1] !== hi) setR([lo, hi]);
  }
  useEffect(() => {
    let raf = 0;
    const step = () => {
      setR((cur) => {
        const [tl, th] = target.current;
        if (cur[0] === tl && cur[1] === th) return cur; // settled: no more renders
        const size = Math.max(1e-9, th - tl);
        if (Math.abs(cur[0] - tl) > size * 3 || Math.abs(cur[1] - th) > size * 3) return [tl, th];
        const nl = cur[0] + (tl - cur[0]) * 0.14;
        const nh = cur[1] + (th - cur[1]) * 0.14;
        return Math.abs(nl - tl) + Math.abs(nh - th) < size * 1e-4 ? [tl, th] : [nl, nh];
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);
  return ready ? r : [lo, hi];
}

export function Sparkline({
  points,
  strike,
  className = "",
}: {
  points: Point[];
  strike: number | null;
  className?: string;
}) {
  const id = useId();
  if (points.length < 2) return <div aria-hidden className={`skeleton h-9 w-24 ${className}`} />;
  const w = 96;
  const h = 36;
  const ps = downsample(points, 36);
  const all = strike !== null ? [...ps.map((p) => p.p), strike] : ps.map((p) => p.p);
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.15;
  lo -= pad;
  hi += pad;
  const t0 = ps[0]!.t;
  const t1 = ps[ps.length - 1]!.t;
  const x = (t: number) => 2 + ((t - t0) / Math.max(1, t1 - t0)) * (w - 4);
  const y = (p: number) => h - 2 - ((p - lo) / (hi - lo)) * (h - 4);
  const xy = ps.map((p) => [x(p.t), y(p.p)] as [number, number]);
  const d = smoothPath(xy);
  const last = ps[ps.length - 1]!.p;
  const up = strike === null || last >= strike;
  const color = up ? "#34d99c" : "#ff6f82";
  return (
    <svg
      role="img"
      aria-label="Recent price"
      viewBox={`0 0 ${w} ${h}`}
      className={`h-9 w-24 ${className}`}
    >
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.3" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {strike !== null ? (
        <line
          x1="0"
          x2={w}
          y1={y(strike)}
          y2={y(strike)}
          stroke="#7b7989"
          strokeDasharray="2 3"
          strokeWidth="1"
        />
      ) : null}
      <path d={`${d} L${xy[xy.length - 1]![0]},${h} L${xy[0]![0]},${h} Z`} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <circle cx={xy[xy.length - 1]![0]} cy={xy[xy.length - 1]![1]} r="2.4" fill={color} />
    </svg>
  );
}

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/**
 * The live price. Full when the page opens (the feed back-fills), eased y-range, a last point that
 * glides, a pulsing dot where "now" is, a dashed line at the round's start price, and a crosshair you
 * can drag across the past. Colour follows the question people actually care about: is the price
 * above or below where the round started?
 */
export function PriceChart({
  points,
  strike,
  height = 190,
  label,
}: {
  points: Point[];
  strike: number | null;
  height?: number;
  label?: string;
}) {
  const id = useId();
  const w = 340;
  const [cursor, setCursor] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const lastP = points.length ? points[points.length - 1]!.p : null;
  const glide = useTween(lastP, 300);

  const ps = useMemo(() => downsample(points, 140), [points]);
  const shown = useMemo(() => {
    if (ps.length === 0 || glide === null) return ps;
    const copy = ps.slice();
    copy[copy.length - 1] = { t: copy[copy.length - 1]!.t, p: glide };
    return copy;
  }, [ps, glide]);

  const vals = shown.map((p) => p.p);
  const all = strike !== null && vals.length ? [...vals, strike] : vals;
  const rawLo = all.length ? Math.min(...all) : 0;
  const rawHi = all.length ? Math.max(...all) : 1;
  const span = Math.max(rawHi - rawLo, rawHi * 0.0004, 1e-6);
  const [lo, hi] = useEasedRange(rawLo - span * 0.18, rawHi + span * 0.18, all.length > 1);

  if (points.length < 2)
    return (
      <div aria-hidden className="skeleton w-full" style={{ height }} data-testid="chart-loading" />
    );

  const pad = { l: 6, r: 44, t: 10, b: 20 };
  const t0 = shown[0]!.t;
  const t1 = shown[shown.length - 1]!.t;
  const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad.l - pad.r);
  const y = (p: number) =>
    pad.t + (1 - (p - lo) / Math.max(1e-9, hi - lo)) * (height - pad.t - pad.b);
  const xy = shown.map((p) => [x(p.t), y(p.p)] as [number, number]);
  const d = smoothPath(xy);
  const last = shown[shown.length - 1]!;
  const up = strike === null || last.p >= strike;
  const color = up ? "#34d99c" : "#ff6f82";
  const lx = xy[xy.length - 1]![0];
  const ly = xy[xy.length - 1]![1];

  const idx = cursor === null ? null : Math.max(0, Math.min(shown.length - 1, cursor));
  const onMove = (clientX: number) => {
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const fx = ((clientX - rect.left) / rect.width) * w;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < xy.length; i++) {
      const dd = Math.abs(xy[i]![0] - fx);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    }
    setCursor(best);
  };
  const ticks = [hi - (hi - lo) * 0.18, lo + (hi - lo) * 0.18];

  return (
    <div className="relative select-none">
      <svg
        ref={svgRef}
        role="img"
        aria-label={label ?? "Live price chart"}
        viewBox={`0 0 ${w} ${height}`}
        className="w-full touch-pan-y"
        style={{ height }}
        onPointerMove={(e) => onMove(e.clientX)}
        onPointerDown={(e) => onMove(e.clientX)}
        onPointerLeave={() => setCursor(null)}
        onPointerUp={() => setCursor(null)}
      >
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.32" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((tv) => (
          <g key={tv}>
            <line
              x1={pad.l}
              x2={w - pad.r}
              y1={y(tv)}
              y2={y(tv)}
              stroke="#2e2e37"
              strokeWidth="0.6"
              strokeDasharray="1 5"
            />
            <text
              x={w - 2}
              y={y(tv) + 3}
              textAnchor="end"
              fontSize="9"
              fill="#7b7989"
              className="tabular"
            >
              {fmtPrice(tv, 2)}
            </text>
          </g>
        ))}
        {strike !== null ? (
          <>
            <line
              x1={pad.l}
              x2={w - pad.r}
              y1={y(strike)}
              y2={y(strike)}
              stroke="#a19fae"
              strokeDasharray="4 4"
              strokeWidth="1"
            />
            <rect
              x={w - pad.r + 2}
              y={y(strike) - 8}
              width={pad.r - 4}
              height="16"
              rx="8"
              fill="#24242b"
            />
            <text
              x={w - pad.r / 2}
              y={y(strike) + 3}
              textAnchor="middle"
              fontSize="8.5"
              fill="#a19fae"
            >
              start
            </text>
          </>
        ) : null}
        <path
          d={`${d} L${lx},${height - pad.b} L${xy[0]![0]},${height - pad.b} Z`}
          fill={`url(#${id})`}
        />
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth="2.2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle
          cx={lx}
          cy={ly}
          r="9"
          fill={color}
          opacity="0.18"
          className="breathe"
          style={{ transformOrigin: `${lx}px ${ly}px` }}
        />
        <circle cx={lx} cy={ly} r="4" fill={color} stroke="#121215" strokeWidth="1.5" />
        <text x={pad.l} y={height - 5} fontSize="9" fill="#7b7989">
          {fmtTime(t0).slice(0, 5)}
        </text>
        <text x={w - pad.r} y={height - 5} fontSize="9" fill="#7b7989" textAnchor="end">
          now
        </text>
        {idx !== null ? (
          <g>
            <line
              x1={xy[idx]![0]}
              x2={xy[idx]![0]}
              y1={pad.t}
              y2={height - pad.b}
              stroke="#a19fae"
              strokeWidth="1"
            />
            <circle
              cx={xy[idx]![0]}
              cy={xy[idx]![1]}
              r="4.5"
              fill="#fff"
              stroke={color}
              strokeWidth="2"
            />
          </g>
        ) : null}
      </svg>
      {idx !== null ? (
        <div
          className="pointer-events-none absolute left-1/2 top-1 -translate-x-1/2 rounded-full bg-raised/95 px-3 py-1 text-xs font-semibold shadow-lg"
          data-testid="chart-cursor"
        >
          <span className="tabular">${fmtPrice(shown[idx]!.p, 2)}</span>
          <span className="ml-2 text-faint">{fmtTime(shown[idx]!.t)}</span>
        </div>
      ) : null}
    </div>
  );
}

/** A small area chart of a series of numbers (vault value, daily volume). */
export function LineChart({
  values,
  height = 120,
  label,
  format,
}: {
  values: { x: number; y: number }[];
  height?: number;
  label: string;
  format?: (y: number) => string;
}) {
  const id = useId();
  const w = 340;
  if (values.length < 2) return null;
  const xs = values.map((v) => v.x);
  const ys = values.map((v) => v.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  if (hi - lo < 1e-12) {
    lo -= 1;
    hi += 1;
  }
  const px = (x: number) => 8 + ((x - x0) / Math.max(1, x1 - x0)) * (w - 16);
  const py = (y: number) => height - 10 - ((y - lo) / (hi - lo)) * (height - 30);
  const xy = values.map((v) => [px(v.x), py(v.y)] as [number, number]);
  const d = smoothPath(xy);
  const last = values[values.length - 1]!;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${w} ${height}`}
      className="w-full"
      style={{ height }}
    >
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ab9ff2" stopOpacity="0.3" />
          <stop offset="1" stopColor="#ab9ff2" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d={`${d} L${xy[xy.length - 1]![0]},${height} L${xy[0]![0]},${height} Z`}
        fill={`url(#${id})`}
      />
      <path
        d={d}
        fill="none"
        stroke="#ab9ff2"
        strokeWidth="2.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={px(last.x)}
        cy={py(last.y)}
        r="4"
        fill="#ab9ff2"
        stroke="#121215"
        strokeWidth="1.5"
      />
      {format ? (
        <text x={w - 6} y={14} textAnchor="end" fontSize="11" fill="#a19fae">
          {format(last.y)}
        </text>
      ) : null}
    </svg>
  );
}
