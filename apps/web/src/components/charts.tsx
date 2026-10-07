import type { Point } from "@/lib/prices";

function scale(points: Point[], strike: number | null, w: number, h: number, pad = 6) {
  const ps = points.map((p) => p.p);
  const all = strike !== null ? [...ps, strike] : ps;
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const span = hi - lo;
  const pad2 = span * 0.12;
  lo -= pad2;
  hi += pad2;
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const x = (t: number) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad * 2);
  const y = (p: number) => h - pad - ((p - lo) / (hi - lo)) * (h - pad * 2);
  return { x, y };
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
  if (points.length < 2) return <div aria-hidden className={`skeleton h-8 w-24 ${className}`} />;
  const w = 96;
  const h = 32;
  const { x, y } = scale(points, strike, w, h, 2);
  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`)
    .join(" ");
  const last = points[points.length - 1]!.p;
  const up = strike === null || last >= strike;
  return (
    <svg
      role="img"
      aria-label="Recent price"
      viewBox={`0 0 ${w} ${h}`}
      className={`h-8 w-24 ${className}`}
    >
      {strike !== null ? (
        <line
          x1="0"
          x2={w}
          y1={y(strike)}
          y2={y(strike)}
          stroke="#7f8da3"
          strokeDasharray="2 3"
          strokeWidth="1"
        />
      ) : null}
      <path
        d={d}
        fill="none"
        stroke={up ? "#35e0a1" : "#ff6b86"}
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function PriceChart({
  points,
  strike,
  height = 160,
  label,
}: {
  points: Point[];
  strike: number | null;
  height?: number;
  label?: string;
}) {
  const w = 340;
  if (points.length < 2) return <div aria-hidden className="skeleton w-full" style={{ height }} />;
  const { x, y } = scale(points, strike, w, height, 8);
  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`)
    .join(" ");
  const last = points[points.length - 1]!;
  const up = strike === null || last.p >= strike;
  const area = `${d} L${x(last.t).toFixed(1)},${height} L${x(points[0]!.t).toFixed(1)},${height} Z`;
  const color = up ? "#35e0a1" : "#ff6b86";
  return (
    <svg
      role="img"
      aria-label={label ?? "Live price chart"}
      viewBox={`0 0 ${w} ${height}`}
      className="w-full"
      style={{ height }}
    >
      <defs>
        <linearGradient id="fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {strike !== null ? (
        <>
          <line
            x1="0"
            x2={w}
            y1={y(strike)}
            y2={y(strike)}
            stroke="#a3b0c4"
            strokeDasharray="4 4"
            strokeWidth="1"
          />
          <text x={w - 4} y={y(strike) - 5} textAnchor="end" fontSize="10" fill="#a3b0c4">
            start price
          </text>
        </>
      ) : null}
      <path d={area} fill="url(#fill)" />
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={x(last.t)} cy={y(last.p)} r="4" fill={color} />
    </svg>
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
  const py = (y: number) => height - 8 - ((y - lo) / (hi - lo)) * (height - 24);
  const d = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${px(v.x).toFixed(1)},${py(v.y).toFixed(1)}`)
    .join(" ");
  const last = values[values.length - 1]!;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${w} ${height}`}
      className="w-full"
      style={{ height }}
    >
      <path
        d={d}
        fill="none"
        stroke="#8b7bff"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={px(last.x)} cy={py(last.y)} r="3.5" fill="#8b7bff" />
      {format ? (
        <text x={w - 6} y={14} textAnchor="end" fontSize="11" fill="#a3b0c4">
          {format(last.y)}
        </text>
      ) : null}
    </svg>
  );
}
