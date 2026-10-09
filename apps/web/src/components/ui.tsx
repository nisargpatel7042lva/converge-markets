import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Mascot } from "./delight";

export function Button({
  tone = "primary",
  size = "lg",
  className = "",
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "primary" | "up" | "down" | "ghost" | "quiet";
  size?: "lg" | "md" | "sm";
}) {
  const tones = {
    primary:
      "bg-brand text-[#15112e] hover:bg-[#bdb3f6] active:bg-[#9a8de6] shadow-[0_8px_24px_-10px_rgba(171,159,242,0.7)]",
    up: "bg-up text-[#04251a] hover:bg-[#5be8b3] active:bg-[#2bc48c] shadow-[0_8px_24px_-12px_rgba(52,217,156,0.8)]",
    down: "bg-down text-[#2c0610] hover:bg-[#ff8a99] active:bg-[#ec5a6e] shadow-[0_8px_24px_-12px_rgba(255,111,130,0.8)]",
    ghost: "border border-line bg-transparent text-text hover:bg-raised",
    quiet: "bg-raised text-text hover:bg-line",
  } as const;
  const sizes = {
    lg: "min-h-14 px-6 text-base",
    md: "min-h-12 px-5 text-sm",
    sm: "min-h-10 px-4 text-sm",
  } as const;
  return (
    <button
      {...p}
      className={`inline-flex items-center justify-center gap-2 rounded-[18px] font-semibold tracking-tight disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none ${tones[tone]} ${sizes[size]} ${className}`}
    />
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-[22px] border border-line/80 bg-surface p-4 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset] ${className}`}
    >
      {children}
    </section>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`skeleton ${className}`} />;
}

export function EmptyState({
  title,
  body,
  action,
  mood = "calm",
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  mood?: "happy" | "calm" | "oops" | "think";
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-[22px] border border-dashed border-line px-6 py-9 text-center">
      <Mascot mood={mood} size={72} />
      <p className="mt-1 text-base font-semibold">{title}</p>
      {body ? <p className="max-w-xs text-sm leading-relaxed text-muted">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = "Couldn't load this",
  body,
  retry,
}: {
  title?: string;
  body?: string;
  retry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-2 rounded-[22px] border border-down-deep/70 bg-down-soft px-6 py-8 text-center"
    >
      <Mascot mood="oops" size={64} />
      <p className="text-base font-semibold">{title}</p>
      <p className="max-w-xs text-sm text-muted">
        {body ?? "That one's on us, not you. Check your connection and try again."}
      </p>
      {retry ? (
        <Button tone="ghost" size="sm" onClick={retry} className="mt-2">
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "up" | "down" | "warn" | "brand";
}) {
  const t = {
    neutral: "bg-raised text-muted",
    up: "bg-up-soft text-up",
    down: "bg-down-soft text-down",
    warn: "bg-warn-soft text-warn",
    brand: "bg-brand-soft text-brand",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${t[tone]}`}
    >
      {children}
    </span>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-faint">{label}</p>
      <p className="tabular truncate text-lg font-semibold">{value}</p>
      {sub ? <p className="text-xs text-muted">{sub}</p> : null}
    </div>
  );
}
