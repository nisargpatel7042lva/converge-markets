"use client";
import type { Round } from "@/lib/data";
import { explorerAddress } from "@/lib/chain";
import { kuruEnabled, useKuruBook } from "@/lib/kuru";
import { Card, Pill } from "@/components/ui";

const cents = (x: number | null) => (x === null ? "no quote" : `${(x * 100).toFixed(1)}¢`);

/**
 * "Also on Kuru": the same UP shares, as an ordinary token on Kuru's order book, quoted there by the
 * Converge Kuru lister around the vault's own fair value. Shown only when the round has a Kuru market.
 */
export function KuruPanel({ round, vaultUpAsk }: { round: Round; vaultUpAsk: number | null }) {
  const book = useKuruBook(round);
  if (!kuruEnabled || !book.data) return null;
  const { market, bid, ask } = book.data;
  const link = explorerAddress(market);
  return (
    <Card className="mt-3.5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">Also on Kuru</p>
        <Pill tone="brand">order book</Pill>
      </div>
      <p className="mt-1 text-xs text-muted">
        Up shares trade as a normal token on Kuru&apos;s spot book, so any Kuru trader can buy or
        sell them.
      </p>
      <div className="tabular mt-3 grid grid-cols-3 gap-2 text-center" data-testid="kuru-book">
        <div className="rounded-2xl bg-raised py-2">
          <p className="text-[11px] text-faint">Kuru bid</p>
          <p className="text-sm font-bold text-down">{cents(bid)}</p>
        </div>
        <div className="rounded-2xl bg-raised py-2">
          <p className="text-[11px] text-faint">Kuru ask</p>
          <p className="text-sm font-bold text-up">{cents(ask)}</p>
        </div>
        <div className="rounded-2xl bg-raised py-2">
          <p className="text-[11px] text-faint">Converge ask</p>
          <p className="text-sm font-bold">
            {vaultUpAsk === null ? "…" : `${(vaultUpAsk * 100).toFixed(1)}¢`}
          </p>
        </div>
      </div>
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="mt-3 block text-center text-xs text-brand underline underline-offset-4"
        >
          View the Kuru market
        </a>
      ) : null}
    </Card>
  );
}
