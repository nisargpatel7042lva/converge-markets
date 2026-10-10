"use client";
import { useState } from "react";

/**
 * A hands-on example for the landing page: drag the price and the clock and watch the odds move. It uses
 * the same digital-option formula the vault quotes from, N(d2), with an example 60% yearly volatility.
 * An illustration, not a live feed: the card says so.
 */
const STRIKE = 2480;
const SIGMA = 0.6;
const YEAR_MIN = 525_600;

function erf(x: number) {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return s * y;
}

export function fairUp(offset: number, minutesLeft: number) {
  const tau = Math.max(minutesLeft, 0.25) / YEAR_MIN;
  const d2 =
    (Math.log((STRIKE + offset) / STRIKE) - 0.5 * SIGMA * SIGMA * tau) / (SIGMA * Math.sqrt(tau));
  return Math.min(0.97, Math.max(0.03, 0.5 * (1 + erf(d2 / Math.SQRT2))));
}

const mmss = (m: number) => {
  const s = Math.round(m * 60);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function OddsDemo() {
  const [offset, setOffset] = useState(0);
  const [mins, setMins] = useState(15);
  const p = fairUp(offset, mins);
  const up = Math.round(p * 100);
  const down = 100 - up;
  const where =
    offset === 0
      ? "right at the start price"
      : `$${Math.abs(offset).toFixed(2)} ${offset > 0 ? "above" : "below"} the start price`;
  return (
    <div className="rounded-[28px] border border-line/80 bg-surface/80 p-5 shadow-[0_30px_60px_-30px_rgba(0,0,0,0.7)] backdrop-blur md:p-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-bold">ETH · 15 min</p>
        <span className="rounded-full bg-raised px-3 py-1 text-xs font-semibold text-muted">
          Example
        </span>
      </div>
      <p className="mt-3 text-base font-semibold leading-snug text-muted">
        Will ETH finish above <span className="text-brand">${STRIKE.toLocaleString()}</span>?
      </p>
      <p className="tabular mt-4 flex items-baseline gap-2">
        <span className="font-display text-[56px] font-extrabold leading-none">{up}%</span>
        <span className="text-sm font-medium text-muted">chance of Up</span>
      </p>
      <p className="mt-1 text-sm text-faint" aria-live="polite">
        ETH is {where}, with {mmss(mins)} left.
      </p>
      <div className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-raised" aria-hidden>
        <span className="bg-up transition-[width] duration-300" style={{ width: `${up}%` }} />
        <span className="bg-down transition-[width] duration-300" style={{ width: `${down}%` }} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <div className="rounded-2xl bg-up-soft px-4 py-3 text-up">
          <p className="text-xs opacity-80">Up · pay {up}¢</p>
          <p className="tabular text-lg font-extrabold">win $1.00</p>
        </div>
        <div className="rounded-2xl bg-down-soft px-4 py-3 text-down">
          <p className="text-xs opacity-80">Down · pay {down}¢</p>
          <p className="tabular text-lg font-extrabold">win $1.00</p>
        </div>
      </div>
      <div className="mt-5 grid gap-3.5">
        <label className="grid gap-1.5 text-xs font-medium text-muted" htmlFor="demo-price">
          <span className="flex justify-between">
            ETH vs the start price
            <output className="tabular text-text">
              {offset >= 0 ? "+" : "-"}${Math.abs(offset).toFixed(2)}
            </output>
          </span>
          <input
            id="demo-price"
            type="range"
            min={-12}
            max={12}
            step={0.5}
            value={offset}
            onChange={(e) => setOffset(Number(e.target.value))}
            className="h-6 w-full accent-[#b6aaf6]"
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-muted" htmlFor="demo-time">
          <span className="flex justify-between">
            Time left
            <output className="tabular text-text">{mmss(mins)}</output>
          </span>
          <input
            id="demo-time"
            type="range"
            min={0.5}
            max={15}
            step={0.5}
            value={mins}
            onChange={(e) => setMins(Number(e.target.value))}
            className="h-6 w-full accent-[#b6aaf6]"
          />
        </label>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-faint">
        Each share pays $1 if you&apos;re right and nothing if you&apos;re not. The odds are the
        real pricing formula with example numbers, not a live price.
      </p>
    </div>
  );
}
