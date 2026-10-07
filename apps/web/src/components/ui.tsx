import type { ButtonHTMLAttributes, ReactNode } from "react";

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
    primary: "bg-brand text-[#0b0820] hover:bg-[#9d8fff] active:bg-[#7a69f0]",
    up: "bg-up text-[#04251a] hover:bg-[#52ecb2] active:bg-[#2bc98f]",
    down: "bg-down text-[#2c0610] hover:bg-[#ff849a] active:bg-[#ec5572]",
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
      className={`inline-flex items-center justify-center gap-2 rounded-2xl font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${tones[tone]} ${sizes[size]} ${className}`}
    />
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-line bg-surface p-4 ${className}`}>
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
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line px-6 py-10 text-center">
      <p className="text-base font-semibold">{title}</p>
      {body ? <p className="max-w-xs text-sm text-muted">{body}</p> : null}
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
      className="flex flex-col items-center gap-2 rounded-2xl border border-down-deep bg-[#1e0d14] px-6 py-8 text-center"
    >
      <p className="text-base font-semibold">{title}</p>
      <p className="max-w-xs text-sm text-muted">
        {body ?? "Check your connection and try again."}
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
    up: "bg-[#0d2a20] text-up",
    down: "bg-[#2a1018] text-down",
    warn: "bg-[#2e2410] text-warn",
    brand: "bg-[#1d1a40] text-[#b9afff]",
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${t[tone]}`}
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
