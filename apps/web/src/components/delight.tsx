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
      ? "M34 55 Q42 65 50 55"
      : mood === "oops"
        ? "M35 60 Q42 54 49 60"
        : mood === "think"
          ? "M36 58 L48 58"
          : "M35 57 Q42 61 49 57";
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 84 84"
      className={`${mood === "happy" ? "float" : "breathe"} ${className}`}
    >
      <defs>
        <linearGradient id="mg-a" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#34d99c" />
          <stop offset="1" stopColor="#1a9c6e" />
        </linearGradient>
        <linearGradient id="mg-b" x1="1" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ff6f82" />
          <stop offset="1" stopColor="#d6405a" />
        </linearGradient>
      </defs>
      <path d="M6 14 L44 42 L6 70 Z" fill="url(#mg-a)" />
      <path d="M78 14 L40 42 L78 70 Z" fill="url(#mg-b)" opacity=".94" />
      <circle cx="33" cy="42" r="4.2" fill="#121215" />
      <circle cx="51" cy="42" r="4.2" fill="#121215" />
      <circle cx="34.4" cy="40.6" r="1.4" fill="#fff" />
      <circle cx="52.4" cy="40.6" r="1.4" fill="#fff" />
      <path d={mouth} stroke="#121215" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      {mood === "happy" ? (
        <>
          <circle cx="28" cy="52" r="3" fill="#ffffff" opacity=".28" />
          <circle cx="56" cy="52" r="3" fill="#ffffff" opacity=".28" />
        </>
      ) : null}
    </svg>
  );
}
