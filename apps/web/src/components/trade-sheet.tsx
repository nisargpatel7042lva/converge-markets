"use client";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseEventLogs } from "viem";
import {
  approveTx,
  askFromLadder,
  forwardVenueAbi,
  mockErc20Abi,
  parseUnits6,
  placeOrderTx,
  planBuy,
  type Side,
} from "@converge/sdk";
import { deployment } from "@/config/deployment";
import { explainAccountError, withSigner, type Profile } from "@/lib/account";
import { track } from "@/lib/analytics";
import { publicClient, explorerTx } from "@/lib/chain";
import { readOrderResult, type Ladder, type OrderResult, type Round } from "@/lib/data";
import { nativeAmount, pct, usd } from "@/lib/format";
import { useBalances } from "@/lib/queries";
import { explainTxError, sendAll } from "@/lib/tx";
import { toast } from "./toast";
import { Button } from "./ui";

const SLIPPAGE_BPS = 200;
const PRESETS = [1, 5, 10, 25];
const MIN_GAS_WEI = 8n * 10n ** 15n;

type Phase =
  | { k: "idle" }
  | { k: "signing" }
  | { k: "sending"; label: string }
  | { k: "waiting"; id: bigint; hash: string }
  | { k: "done"; result: OrderResult; hash: string }
  | { k: "error"; message: string };

export function TradeSheet({
  round,
  side,
  ladder,
  profile,
  onClose,
}: {
  round: Round;
  side: Side;
  ladder: Ladder | undefined;
  profile: Profile | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState("5");
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const bal = useBalances(profile?.address);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && phase.k !== "signing" && phase.k !== "sending" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, phase.k]);

  const ask = ladder ? askFromLadder(side, ladder) : null;
  const plan = useMemo(() => {
    if (!ask) return null;
    try {
      return planBuy({
        side,
        budget: parseUnits6(amount || "0"),
        priceWad: ask.priceWad,
        slippageBps: SLIPPAGE_BPS,
        redeemFeeBps: round.redeemFeeBps,
      });
    } catch {
      return null;
    }
  }, [ask, amount, side, round.redeemFeeBps]);

  const usdc = bal.data?.usdc ?? 0n;
  const native = bal.data?.native ?? 0n;
  const reward = BigInt(deployment.minRewardWei);
  const needsMoney = plan ? usdc < plan.escrow : false;
  const needsGas = native < MIN_GAS_WEI;
  const busy = phase.k === "signing" || phase.k === "sending" || phase.k === "waiting";
  const sideName = side === "UP" ? "Up" : "Down";

  async function confirm() {
    if (!profile || !plan) return;
    setPhase({ k: "signing" });
    try {
      const fromBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
      const { hashes } = await withSigner(profile, async (account) => {
        setPhase({ k: "sending", label: "Placing your bet…" });
        const allowance = await publicClient.readContract({
          address: deployment.usdc,
          abi: mockErc20Abi,
          functionName: "allowance",
          args: [account.address, deployment.venue],
        });
        const steps = [
          ...(allowance < plan.escrow
            ? [{ label: "Approve", tx: approveTx(deployment.usdc, deployment.venue, plan.escrow) }]
            : []),
          {
            label: "Bet",
            tx: placeOrderTx({ venue: deployment.venue, market: round.address, plan, reward }),
          },
        ];
        return { hashes: await sendAll(account, steps) };
      });
      const hash = hashes[hashes.length - 1]!;
      const receipt = await publicClient.getTransactionReceipt({ hash });
      const placed = parseEventLogs({
        abi: forwardVenueAbi,
        logs: receipt.logs,
        eventName: "OrderPlaced",
      })[0];
      if (!placed) throw new Error("The bet was sent but we couldn't find it. Check My bets.");
      const id = placed.args.id;
      setPhase({ k: "waiting", id, hash });
      const t0 = Date.now();
      for (;;) {
        const r = await readOrderResult(id, fromBlock);
        if (r.status !== "open") {
          setPhase({ k: "done", result: r, hash });
          if (r.status === "filled") track("first_trade", { side });
          void qc.invalidateQueries();
          return;
        }
        if (Date.now() - t0 > 45_000) {
          setPhase({ k: "done", result: { status: "open" }, hash });
          return;
        }
        await new Promise((res) => setTimeout(res, 500));
      }
    } catch (e) {
      const msg = /passkey|Mera|PRF|NotAllowed/i.test(String(e))
        ? explainAccountError(e)
        : explainTxError(e);
      setPhase({ k: "error", message: msg });
      toast(msg, "error");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60"
      onClick={() => !busy && onClose()}
    >
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Bet ${sideName}`}
        onClick={(e) => e.stopPropagation()}
        className="sheet-in safe-bottom w-full max-w-md rounded-t-3xl border border-line bg-surface px-5 pt-5 outline-none"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">
            Bet <span className={side === "UP" ? "text-up" : "text-down"}>{sideName}</span> ·{" "}
            {round.series.name}
          </h2>
          <button
            aria-label="Close"
            onClick={onClose}
            disabled={busy}
            className="min-h-10 min-w-10 rounded-full text-faint disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        {phase.k === "done" || phase.k === "waiting" ? (
          <Result phase={phase} side={side} onClose={onClose} />
        ) : (
          <>
            <fieldset disabled={busy} className="mt-4">
              <legend className="text-xs text-faint">How much?</legend>
              <div className="mt-2 grid grid-cols-4 gap-2" role="group" aria-label="Amount presets">
                {PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={amount === String(p)}
                    onClick={() => setAmount(String(p))}
                    className={`min-h-12 rounded-xl border text-sm font-semibold ${amount === String(p) ? "border-brand bg-[#1d1a40]" : "border-line bg-raised"}`}
                  >
                    ${p}
                  </button>
                ))}
              </div>
              <label className="mt-3 block text-xs text-faint" htmlFor="amount">
                Or type an amount
              </label>
              <div className="mt-1 flex items-center rounded-xl border border-line bg-raised px-3">
                <span className="text-muted">$</span>
                <input
                  id="amount"
                  data-testid="amount"
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                  className="tabular min-h-12 w-full bg-transparent px-2 text-base outline-none"
                />
              </div>
            </fieldset>

            <dl
              className="mt-4 grid grid-cols-2 gap-3 rounded-2xl bg-raised p-4 text-sm"
              aria-live="polite"
            >
              <div>
                <dt className="text-xs text-faint">You pay</dt>
                <dd data-testid="pay" className="tabular text-base font-semibold">
                  {plan ? usd(plan.expectedCost) : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-faint">You win if right</dt>
                <dd data-testid="win" className="tabular text-base font-semibold text-up">
                  {plan ? usd(plan.payoutIfRight) : "—"}
                </dd>
              </div>
              <div className="col-span-2 text-xs text-muted">
                {ask
                  ? `The market says ${sideName} is ${pct(Number(ask.priceWad) / 1e18)} likely. If the price moves more than ${SLIPPAGE_BPS / 100}% before we fill you, the bet is cancelled and your money comes back.`
                  : "No price right now: the market isn't taking bets this second."}
              </div>
            </dl>

            {phase.k === "error" ? (
              <p
                role="alert"
                className="mt-3 rounded-xl border border-down-deep bg-[#1e0d14] px-4 py-3 text-sm text-[#ffd6de]"
              >
                {phase.message}
              </p>
            ) : null}
            {!profile ? (
              <Link
                href="/start"
                className="mt-4 flex min-h-14 items-center justify-center rounded-2xl bg-brand text-base font-semibold text-[#0b0820]"
              >
                Create your account to bet
              </Link>
            ) : needsMoney ? (
              <Link
                href="/fund"
                className="mt-4 flex min-h-14 items-center justify-center rounded-2xl bg-brand text-base font-semibold text-[#0b0820]"
              >
                Add money first ({usd(usdc)} available)
              </Link>
            ) : needsGas ? (
              <Link
                href="/fund"
                className="mt-4 flex min-h-14 items-center justify-center rounded-2xl bg-brand text-base font-semibold text-[#0b0820]"
              >
                Add gas money first ({nativeAmount(native)} {deployment.nativeSymbol})
              </Link>
            ) : (
              <Button
                data-testid="confirm"
                tone={side === "UP" ? "up" : "down"}
                className="mt-4 w-full"
                disabled={!plan || busy}
                onClick={confirm}
                aria-busy={busy}
              >
                {phase.k === "signing"
                  ? "Waiting for Face ID…"
                  : phase.k === "sending"
                    ? phase.label
                    : phase.k === "error"
                      ? "Try again"
                      : `Bet ${plan ? usd(plan.expectedCost) : ""} on ${sideName} · confirm`}
              </Button>
            )}
            <p className="mt-3 pb-1 text-center text-xs text-faint">
              One confirmation. You can lose the whole amount.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Result({
  phase,
  side,
  onClose,
}: {
  phase: Extract<Phase, { k: "waiting" | "done" }>;
  side: Side;
  onClose: () => void;
}) {
  if (phase.k === "waiting")
    return (
      <div
        className="flex flex-col items-center gap-3 py-10 text-center"
        aria-live="polite"
        data-testid="waiting"
      >
        <div
          className="h-10 w-10 animate-spin rounded-full border-2 border-line border-t-brand"
          aria-hidden
        />
        <p className="text-base font-semibold">Your bet is in. Getting you a price…</p>
        <p className="text-sm text-muted">This takes a few seconds.</p>
      </div>
    );
  const r = phase.result;
  const link = explorerTx(phase.hash);
  const sideName = side === "UP" ? "Up" : "Down";
  return (
    <div
      className="pop flex flex-col items-center gap-3 py-8 text-center"
      aria-live="polite"
      data-testid="result"
    >
      {r.status === "filled" ? (
        <>
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#0d2a20] text-2xl text-up">
            ✓
          </div>
          <p className="text-xl font-bold">You&apos;re in on {sideName}</p>
          <p className="tabular text-sm text-muted">
            {usd(r.premium ?? 0n)} for {usd(r.filled ?? 0n)} of {sideName}. If you&apos;re right
            when the round ends, you collect{" "}
            <span className="font-semibold text-text">{usd(r.filled ?? 0n)}</span>.
          </p>
        </>
      ) : r.status === "unfilled" || r.status === "expired" ? (
        <>
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#2e2410] text-2xl text-warn">
            ↩
          </div>
          <p className="text-xl font-bold">Not filled. Your money is back.</p>
          <p className="text-sm text-muted">
            The price moved too far, or the market paused. Nothing was spent except network fees.
          </p>
        </>
      ) : (
        <>
          <p className="text-xl font-bold">Still working on it</p>
          <p className="text-sm text-muted">
            Your bet hasn&apos;t been filled yet. It will be filled or cancelled within a minute.
            Check My bets.
          </p>
        </>
      )}
      {link ? (
        <a
          className="text-xs text-faint underline underline-offset-4"
          href={link}
          target="_blank"
          rel="noreferrer"
        >
          View on the explorer
        </a>
      ) : null}
      <div className="mt-2 flex w-full gap-2">
        <Button
          tone="quiet"
          size="md"
          className="flex-1"
          onClick={onClose}
          data-testid="close-result"
        >
          Done
        </Button>
        <Link
          href="/positions"
          className="flex min-h-12 flex-1 items-center justify-center rounded-2xl bg-brand text-sm font-semibold text-[#0b0820]"
        >
          My bets
        </Link>
      </div>
    </div>
  );
}
