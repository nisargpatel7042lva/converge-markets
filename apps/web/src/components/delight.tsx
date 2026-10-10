"use client";
import { useEffect, useMemo, useRef, useState } from "react";

/** A short buzz on phones that have one. Never required, never throws. */
export function haptic(pattern: number | number[] = 12) {
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(pattern);
  } catch {
    /* no haptics */
  }
}

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Glides a number toward its target instead of jumping (ease-out, ~350 ms). Prices that arrive four
 * times a second then move like a living thing, not like a flickering table.
 */
export function useTween(target: number | null, ms = 350): number | null {
  const [value, setValue] = useState<number | null>(target);
  const from = useRef<number | null>(target);
  const raf = useRef(0);
  useEffect(() => {
    if (target === null) {
      setValue(null);
      from.current = null;
      return;
    }
    if (from.current === null || prefersReducedMotion()) {
      from.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    const a = from.current;
    cancelAnimationFrame(raf.current);
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      const v = a + (target - a) * eased;
      from.current = v;
      setValue(v);
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target, ms]);
  return value;
}

/** A number that glides, and briefly takes the colour of the direction it moved. */
export function AnimatedNumber({
  value,
  format,
  className = "",
  testId,
}: {
  value: number | null;
  format: (n: number) => string;
  className?: string;
  testId?: string;
}) {
  const shown = useTween(value);
  const prev = useRef<number | null>(value);
  const [dir, setDir] = useState<"" | "up" | "down">("");
  const [n, setN] = useState(0);
  useEffect(() => {
    if (value !== null && prev.current !== null && value !== prev.current) {
      setDir(value > prev.current ? "up" : "down");
      setN((x) => x + 1);
    }
    prev.current = value;
  }, [value]);
  return (
    <span
      key={n}
      data-testid={testId}
      className={`tabular ${dir === "up" ? "tick-up" : dir === "down" ? "tick-down" : ""} ${className}`}
    >
      {shown === null ? "…" : format(shown)}
    </span>
  );
}

/**
 * Time left as a ring: calm lilac, amber in the last minute (and breathing), coral in the last
 * fifteen seconds. The colour says "hurry" before the number is read.
 */
export function CountdownRing({
  left,
  total,
  size = 52,
  label,
}: {
  left: number;
  total: number;
  size?: number;
  label?: string;
}) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, left / Math.max(1, total)));
  const color = left <= 15 ? "#ff6f82" : left <= 60 ? "#ffc65a" : "#ab9ff2";
  return (
    <svg
      role="img"
      aria-label={label ?? "Time left in the round"}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={left <= 60 && left > 0 ? "urgent" : ""}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#2e2e37" strokeWidth="4" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - frac)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset 1s linear, stroke 0.4s ease" }}
      />
    </svg>
  );
}

/** The two sides as one bar; both ends glide when the odds move. */
export function OddsBar({ up, height = 10 }: { up: number | null; height?: number }) {
  const p = up === null ? 0.5 : Math.max(0.02, Math.min(0.98, up));
  return (
    <div
      className="flex overflow-hidden rounded-full bg-raised"
      style={{ height }}
      role="img"
      aria-label="Probability bar"
    >
      <div
        className="bg-up"
        style={{ width: `${p * 100}%`, transition: "width 0.5s cubic-bezier(.2,.9,.25,1)" }}
      />
      <div
        className="bg-down"
        style={{ width: `${(1 - p) * 100}%`, transition: "width 0.5s cubic-bezier(.2,.9,.25,1)" }}
      />
    </div>
  );
}

const COLORS = ["#34d99c", "#ab9ff2", "#ffc65a", "#ff6f82", "#7fd0ff"];

/** A burst of confetti over the whole screen; removes itself. Respects reduced motion. */
export function Confetti({ pieces = 46, onDone }: { pieces?: number; onDone?: () => void }) {
  const items = useMemo(
    () =>
      Array.from({ length: pieces }, (_, i) => ({
        left: Math.random() * 100,
        dx: Math.round((Math.random() - 0.5) * 220),
        rot: Math.round(360 + Math.random() * 540),
        dur: 1.8 + Math.random() * 1.4,
        delay: Math.random() * 0.35,
        color: COLORS[i % COLORS.length],
      })),
    [pieces],
  );
  useEffect(() => {
    const t = setTimeout(() => onDone?.(), 3600);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[70] overflow-hidden">
      {items.map((it, i) => (
        <span
          key={i}
          className="confetti-piece"
          style={
            {
              left: `${it.left}%`,
              background: it.color,
              "--dx": `${it.dx}px`,
              "--rot": `${it.rot}deg`,
              "--dur": `${it.dur}s`,
              "--delay": `${it.delay}s`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

/**
 * Conv, the little mascot: the two halves of the logo with a face. It makes empty and error screens
 * feel like someone is there. mood: happy (wins, welcome), calm (nothing yet), oops (something
 * went wrong, said gently), think (waiting).
 */
export function Mascot({
  mood = "calm",
  size = 84,
  className = "",
}: {
  mood?: "happy" | "calm" | "oops" | "think";
  size?: number;
  className?: string;
}) {
  const mouth =
    mood === "happy"
      ? "M35 46 Q42 53 49 46"
      : mood === "oops"
        ? "M36 51 Q42 46 48 51"
        : mood === "think"
          ? "M37 49 L47 49"
          : "M36 48 Q42 51 48 48";
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 84 84"
      className={`${mood === "happy" ? "float" : "breathe"} ${className}`}
    >
      <circle cx="42" cy="29.4" r="25.2" fill="#5fd7ae" />
      <circle cx="42" cy="54.6" r="25.2" fill="#f48b98" />
      <path d="M20.2 42A25.2 25.2 0 0 0 63.8 42A25.2 25.2 0 0 0 20.2 42Z" fill="#b6aaf6" />
      <circle cx="34" cy="40" r="3.2" fill="#0f1218" />
      <circle cx="50" cy="40" r="3.2" fill="#0f1218" />
      <circle cx="35" cy="39" r="1" fill="#fff" />
      <circle cx="51" cy="39" r="1" fill="#fff" />
      <path d={mouth} stroke="#0f1218" strokeWidth="2.4" strokeLinecap="round" fill="none" />
      {mood === "happy" ? (
        <>
          <circle cx="29.5" cy="45.5" r="2.4" fill="#f48b98" opacity=".55" />
          <circle cx="54.5" cy="45.5" r="2.4" fill="#f48b98" opacity=".55" />
        </>
      ) : null}
    </svg>
  );
}
