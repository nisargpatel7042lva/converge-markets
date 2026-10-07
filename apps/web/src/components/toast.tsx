"use client";
import { useEffect, useState } from "react";

type Toast = { id: number; text: string; tone: "ok" | "error" | "info" };
let items: Toast[] = [];
let seq = 0;
const subs = new Set<() => void>();

export function toast(text: string, tone: Toast["tone"] = "info") {
  const t = { id: ++seq, text, tone };
  items = [...items, t];
  subs.forEach((s) => s());
  setTimeout(() => {
    items = items.filter((x) => x.id !== t.id);
    subs.forEach((s) => s());
  }, 4500);
}

export function ToastHost() {
  const [, force] = useState(0);
  useEffect(() => {
    const s = () => force((n) => n + 1);
    subs.add(s);
    return () => void subs.delete(s);
  }, []);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-3 z-[60] mx-auto flex max-w-md flex-col gap-2 px-4"
    >
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pop pointer-events-auto rounded-xl border px-4 py-3 text-sm shadow-lg ${
            t.tone === "error"
              ? "border-down-deep bg-[#2a1018] text-[#ffd6de]"
              : t.tone === "ok"
                ? "border-up-deep bg-[#0d2a20] text-[#c9ffe9]"
                : "border-line bg-raised text-text"
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
