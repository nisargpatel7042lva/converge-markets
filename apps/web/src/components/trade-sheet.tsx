"use client";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { parseEventLogs, type Hex } from "viem";
import {
  approveTx,
  forwardVenueAbi,
  mockErc20Abi,
  parseUnits6,
  placeOrderTx,
  planBuy,
  type Side,
} from "@converge/sdk";
import { deployment } from "@/config/deployment";
import { recordAttempt, recordOrder } from "@/lib/activity";
import { explainAccountError, withSigner, type Profile } from "@/lib/account";
import { track } from "@/lib/analytics";
import { explorerTx, publicClient } from "@/lib/chain";
import { readOrderResult, type OrderResult, type Round } from "@/lib/data";
import { nativeAmount, price, usd } from "@/lib/format";
import { GAS_RESERVE_WEI } from "@/lib/limits";
import { maxBudget, type LiveMarket } from "@/lib/live";
import { useBalances, useMinReward } from "@/lib/queries";
import { explainTxError, sendAll } from "@/lib/tx";
import { Confetti, Mascot, haptic } from "./delight";
import { toast } from "./toast";
import { Button } from "./ui";

// How much dearer than the displayed share price a bet may fill. The bet is priced about 2 s after the
// tap (plus inclusion), and on the Monad testnet run ETH moved enough in that time (about 4 cents of
// probability per dollar) for 2 % to cancel most bets; 10 % still refunds the difference: the fill
// is at the oracle's price, only the escrow is sized by this limit.
const SLIPPAGE_BPS = 1000;
const PRESETS = [1, 5, 10, 25];
const net = (v: bigint, bps: number) => v - (v * BigInt(bps)) / 10_000n;

type Phase =
  | { k: "idle" }
  | { k: "signing" }
  | { k: "sending"; label: string }
  | { k: "waiting"; id: bigint; hash: string; since: number }
  | { k: "done"; result: OrderResult; hash: string; note?: string }
  | { k: "error"; message: string };

export function TradeSheet({
  round,
  side,
  live,
  profile,
  onClose,
}: {
  round: Round;
  side: Side;
  live: LiveMarket;
  profile: Profile | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState("5");
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const bal = useBalances(profile?.address);
  const dialog = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<Element | null>(null);
  const locked = phase.k === "signing" || phase.k === "sending" || phase.k === "waiting";
  const up = side === "UP";

  // The page behind the sheet is inert while it is open; focus returns to where it was on close.
  useEffect(() => {
    lastFocus.current = document.activeElement;
    dialog.current?.focus();
    const main = document.getElementById("main");
    const nav = document.querySelector("nav[aria-label=Main]");
    main?.setAttribute("inert", "");
    nav?.setAttribute("inert", "");
    return () => {
      main?.removeAttribute("inert");
      nav?.removeAttribute("inert");
      (lastFocus.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !locked) return onClose();
      if (e.key !== "Tab" || !dialog.current) return;
      const f = [
        ...dialog.current.querySelectorAll<HTMLElement>(
          "button, a[href], input, [tabindex]:not([tabindex='-1'])",
        ),
      ].filter((x) => !x.hasAttribute("disabled"));
      if (f.length === 0) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, locked]);

  const dollars = side === "UP" ? live.upAsk : live.downAsk;
  const priceWad = dollars === null ? null : BigInt(Math.round(dollars * 1e9)) * 10n ** 9n;
  // The most the vault can take on this side right now: asking for more used to make the keeper
  // turn the whole bet down (it would breach the market's loss ceiling), leaving it to expire.
  const cap = useMemo(
    () => (priceWad === null ? null : maxBudget(side, live.ladder, priceWad, SLIPPAGE_BPS)),
    [priceWad, side, live.ladder],
  );
  const wanted = useMemo(() => {
    try {
      return parseUnits6(amount || "0");
    } catch {
      return 0n;
    }
  }, [amount]);
  const capped = cap !== null && wanted > cap;
  const budget = cap !== null && wanted > cap ? cap : wanted;
  const plan = useMemo(() => {
    if (priceWad === null || budget <= 0n) return null;
    try {
      return planBuy({
        side,
        budget,
        priceWad,
        slippageBps: SLIPPAGE_BPS,
        redeemFeeBps: round.redeemFeeBps,
      });
    } catch {
      return null;
    }
  }, [priceWad, budget, side, round.redeemFeeBps]);

  const usdc = bal.data?.usdc ?? 0n;
  const native = bal.data?.native ?? 0n;
  const minReward = useMinReward();
  const reward = minReward.data ?? BigInt(deployment.minRewardWei);
  const needsMoney = plan ? usdc < plan.escrow : false;
  const needsGas = native < GAS_RESERVE_WEI + reward;
  const sideName = up ? "Up" : "Down";
  const strike = round.strike > 0n ? Number(round.strike) / 1e18 : null;

  async function confirm() {
    if (!profile || !plan) return;
    setPhase({ k: "signing" });
    let placedHash: Hex | null = null;
    try {
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
        return {
          hashes: await sendAll(account, steps, (label, hash) => {
            // the bet is on its way the moment its transaction is broadcast: no retry from here on
            if (label === "Bet") placedHash = hash;
          }),
        };
      });
      const hash = hashes[hashes.length - 1]!;
      // From here on the bet exists on chain: nothing below may offer a second bet.
      placedHash = hash;
      haptic(14);
      let id: bigint | null = null;
      // The block the bet landed in: where its result is searched from. (It used to be the block
      // before the passkey prompt; a slow prompt then pushed the search past the node's log range.)
      let placedBlock: bigint | null = null;
      try {
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
        placedBlock = receipt.blockNumber;
        const placed = parseEventLogs({
          abi: forwardVenueAbi,
          logs: receipt.logs,
          eventName: "OrderPlaced",
        })[0];
        if (placed) id = placed.args.id;
      } catch {
        // keep going: the order is placed, only its number is unknown for now
      }
      if (id === null) {
        // find the order by its taker so that it is still tracked (and refundable) from My bets;
        // within the node's log range (about 100 blocks)
        try {
          const head = await publicClient.getBlockNumber();
          const logs = await publicClient.getContractEvents({
            address: deployment.venue,
            abi: forwardVenueAbi,
            eventName: "OrderPlaced",
            args: { taker: profile.address },
            fromBlock: head > 80n ? head - 80n : 0n,
            toBlock: head,
          });
          const mine = logs[logs.length - 1]?.args.id;
          if (mine !== undefined)
            recordOrder(profile.address, {
              id: mine.toString(),
              market: round.address,
              side,
              at: Date.now(),
            });
        } catch {
          // the order stays on chain: the note below tells the user where to look
        }
        setPhase({
          k: "done",
          result: { status: "open" },
          hash,
          note: "Your bet is placed. We couldn't read its number yet: check My bets in a moment.",
        });
        return;
      }
      recordOrder(profile.address, {
        id: id.toString(),
        market: round.address,
        side,
        at: Date.now(),
      });
      setPhase({ k: "waiting", id, hash, since: Date.now() });
      const t0 = Date.now();
      let failures = 0;
      const from = placedBlock ?? (await publicClient.getBlockNumber()) - 5n;
      for (;;) {
        try {
          const r = await readOrderResult(id, from);
          failures = 0;
          if (r.status !== "open") {
            setPhase({ k: "done", result: r, hash });
            recordAttempt(profile.address, {
              id: id.toString(),
              market: round.address,
              side,
              at: Date.now(),
              status: r.status === "filled" ? "filled" : "refunded",
              amount: (r.status === "filled" ? (r.premium ?? 0n) : plan.escrow).toString(),
            });
            if (r.status === "filled") {
              track("first_trade", { side });
              haptic([12, 30, 12]);
            } else haptic(30);
            void qc.invalidateQueries();
            return;
          }
        } catch {
          if (++failures >= 8) break; // the node keeps failing: stop asking, the bet stays tracked
        }
        if (Date.now() - t0 > 60_000) break;
        await new Promise((res) => setTimeout(res, 700));
      }
      setPhase({ k: "done", result: { status: "open" }, hash });
    } catch (e) {
      if (placedHash) {
        setPhase({
          k: "done",
          result: { status: "open" },
          hash: placedHash,
          note: "Your bet is placed, but we lost track of it for a moment. Check My bets.",
        });
        return;
      }
      const msg = /passkey|Mera|PRF|NotAllowed/i.test(String(e))
        ? explainAccountError(e)
        : explainTxError(e);
      setPhase({ k: "error", message: msg });
      toast(msg, "error");
    }
  }

  const accent = up ? "text-up" : "text-down";
  // rendered outside #main so that the page behind can be made inert without the sheet going with it
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/65 backdrop-blur-[2px] md:items-center md:p-6"
      onClick={() => !locked && onClose()}
    >
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Bet ${sideName}`}
        onClick={(e) => e.stopPropagation()}
        className="sheet-in safe-bottom w-full max-w-md rounded-t-[32px] border border-line/80 bg-surface px-5 pt-3 outline-none md:rounded-[32px] md:pb-6 md:pt-5"
      >
        <div aria-hidden className="mx-auto mb-3 h-1 w-10 rounded-full bg-line" />
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-extrabold tracking-tight">
            <span
              className={`grid h-8 w-8 place-items-center rounded-full ${up ? "bg-up-soft" : "bg-down-soft"} ${accent}`}
              aria-hidden
            >
              {up ? "▲" : "▼"}
            </span>
            <span>
              Bet <span className={accent}>{sideName}</span> · {round.series.name}
            </span>
          </h2>
          <button
            aria-label="Close"
            onClick={onClose}
            disabled={locked}
            className="grid h-10 w-10 place-items-center rounded-full bg-raised text-faint disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        {phase.k === "done" || phase.k === "waiting" ? (
          <Result phase={phase} side={side} feeBps={round.redeemFeeBps} onClose={onClose} />
        ) : (
          <>
            {strike ? (
              <p className="mt-1 text-sm text-muted">
                {round.series.name} must finish {up ? "above" : "below"}{" "}
                <span className="font-semibold text-text">${price(strike)}</span> when the round
                ends.
              </p>
            ) : null}

            <fieldset disabled={locked} className="mt-5">
              <legend className="sr-only">How much?</legend>
              <div
                className={`flex items-center justify-center gap-1 ${phase.k === "error" ? "shake" : ""}`}
              >
                <span className="text-[40px] font-extrabold text-faint">$</span>
                <input
                  id="amount"
                  data-testid="amount"
                  aria-label="Amount in dollars"
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  style={{ width: `${Math.max(1, amount.length) + 0.4}ch` }}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                  className="tabular bg-transparent text-center text-[52px] font-extrabold leading-none tracking-tight outline-none"
                />
              </div>
              <div
                className="mt-4 flex justify-center gap-2"
                role="group"
                aria-label="Amount presets"
              >
                {PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={amount === String(p)}
                    onClick={() => {
                      setAmount(String(p));
                      haptic(6);
                    }}
                    className={`min-h-11 min-w-14 rounded-full px-4 text-sm font-bold ${amount === String(p) ? "bg-text text-ink" : "bg-raised text-muted"}`}
                  >
                    ${p}
                  </button>
                ))}
                {cap !== null && cap > 0n ? (
                  <button
                    type="button"
                    onClick={() => setAmount((Number(cap) / 1e6).toFixed(2))}
                    className="min-h-11 rounded-full bg-brand-soft px-4 text-sm font-bold text-brand"
                  >
                    Max
                  </button>
                ) : null}
              </div>
            </fieldset>

            <dl
              className="mt-5 grid gap-2.5 rounded-[20px] bg-raised p-4 text-sm"
              aria-live="polite"
            >
              <div className="flex items-center justify-between">
                <dt className="text-muted">Price per share</dt>
                <dd className="tabular font-bold">
                  {dollars !== null ? `${Math.round(dollars * 100)}¢` : "—"}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted">You pay</dt>
                <dd data-testid="pay" className="tabular text-base font-bold">
                  {plan ? usd(plan.expectedCost) : "—"}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted">You win if right</dt>
                <dd data-testid="win" className="tabular text-base font-extrabold text-up">
                  {plan ? `+${usd(plan.profitIfRight)}` : "—"}
                </dd>
              </div>
              <div className="flex items-center justify-between border-t border-line pt-2.5">
                <dt className="text-muted">Back in total</dt>
                <dd className="tabular font-bold">{plan ? usd(plan.payoutIfRight) : "—"}</dd>
              </div>
            </dl>

            {capped ? (
              <p
                role="status"
                data-testid="capped"
                className="mt-3 rounded-2xl bg-brand-soft px-4 py-3 text-sm text-brand"
              >
                That&apos;s more than the market can take on {sideName} right now, so your bet is
                set to the most it can: {usd(cap!)}. Try again in a moment for more room.
              </p>
            ) : null}
            <p className="mt-3 text-xs leading-relaxed text-faint">
              {dollars !== null
                ? `Filled about 2 seconds after you confirm, at the oracle's price then: the unused part comes back (up to ${plan ? usd(plan.escrow) : "—"} is held). If the share price rises more than ${SLIPPAGE_BPS / 100}% first, the bet is cancelled and your money returns.${round.redeemFeeBps > 0 ? ` A ${round.redeemFeeBps / 100}% fee applies to winnings.` : ""}`
                : "No price right now: the market isn't taking bets this second."}
            </p>

            {phase.k === "error" ? (
              <p
                role="alert"
                className="mt-3 rounded-2xl border border-down-deep bg-down-soft px-4 py-3 text-sm text-[#ffd6de]"
              >
                {phase.message}
              </p>
            ) : null}
            {!profile ? (
              <Link
                href="/start"
                className="mt-4 flex min-h-14 items-center justify-center rounded-[18px] bg-brand text-base font-bold text-[#15112e]"
              >
                Create your account to bet
              </Link>
            ) : needsMoney ? (
              <Link
                href="/fund"
                className="mt-4 flex min-h-14 items-center justify-center rounded-[18px] bg-brand text-base font-bold text-[#15112e]"
              >
                Add money first ({usd(usdc)} available)
              </Link>
            ) : needsGas ? (
              <Link
                href="/fund"
                className="mt-4 flex min-h-14 items-center justify-center rounded-[18px] bg-brand text-base font-bold text-[#15112e]"
              >
                Add gas money first ({nativeAmount(native)} {deployment.nativeSymbol})
              </Link>
            ) : (
              <Button
                data-testid="confirm"
                tone={up ? "up" : "down"}
                className="mt-4 w-full"
                disabled={!plan || locked}
                onClick={confirm}
                aria-busy={locked}
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
    </div>,
    document.body,
  );
}

/** Steps of locking a bet in, so waiting feels like progress and not like a freeze. */
function Steps({ since }: { since: number }) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setT((Date.now() - since) / 1000), 300);
    return () => clearInterval(i);
  }, [since]);
  const steps = [
    ["Bet sent", true],
    ["Getting the oracle price", t > 1.5],
    ["Locking it in", t > 3.5],
  ] as const;
  return (
    <ol className="mt-4 grid gap-2 text-left text-sm">
      {steps.map(([label, done], i) => {
        const active = !done && (i === 0 || steps[i - 1]![1]);
        return (
          <li key={label} className="flex items-center gap-3">
            <span
              className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${done ? "bg-up-soft text-up" : active ? "bg-brand-soft text-brand" : "bg-raised text-faint"}`}
            >
              {done ? (
                "✓"
              ) : active ? (
                <span className="h-2 w-2 animate-pulse rounded-full bg-brand" />
              ) : (
                i + 1
              )}
            </span>
            <span className={done ? "text-text" : active ? "text-text" : "text-faint"}>
              {label}
            </span>
          </li>
        );
      })}
      {t > 12 ? (
        <p className="mt-1 text-xs text-muted">
          Taking a little longer than usual. Your money is safe: if the bet can&apos;t be filled it
          comes back by itself.
        </p>
      ) : null}
    </ol>
  );
}

function Result({
  phase,
  side,
  feeBps,
  onClose,
}: {
  phase: Extract<Phase, { k: "waiting" | "done" }>;
  side: Side;
  feeBps: number;
  onClose: () => void;
}) {
  const [burst, setBurst] = useState(true);
  if (phase.k === "waiting")
    return (
      <div className="py-8 text-center" aria-live="polite" data-testid="waiting">
        <div className="relative mx-auto grid h-16 w-16 place-items-center">
          <span className="glow-ring absolute inset-0 rounded-full bg-brand/30" aria-hidden />
          <Mascot mood="think" size={56} />
        </div>
        <p className="mt-3 text-lg font-extrabold">Locking in your bet…</p>
        <p className="text-sm text-muted">Usually a few seconds.</p>
        <Steps since={phase.since} />
      </div>
    );
  const r = phase.result;
  const link = explorerTx(phase.hash);
  const sideName = side === "UP" ? "Up" : "Down";
  return (
    <div
      className="pop flex flex-col items-center gap-3 py-7 text-center"
      aria-live="polite"
      data-testid="result"
    >
      {r.status === "filled" ? (
        <>
          {burst ? <Confetti pieces={34} onDone={() => setBurst(false)} /> : null}
          <div className="relative grid h-20 w-20 place-items-center">
            <span className="glow-ring absolute inset-0 rounded-full bg-up/30" aria-hidden />
            <span className="grid h-16 w-16 place-items-center rounded-full bg-up-soft">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  className="draw-check"
                  d="M5 12.5l4.5 4.5L19 7.5"
                  stroke="#34d99c"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </div>
          <p className="text-2xl font-extrabold">You&apos;re in on {sideName}</p>
          <p className="tabular max-w-xs text-sm leading-relaxed text-muted">
            {usd(r.premium ?? 0n)} for {usd(r.filled ?? 0n)} of {sideName}. If you&apos;re right
            when the round ends, you collect{" "}
            <span className="font-bold text-text">{usd(net(r.filled ?? 0n, feeBps))}</span>
            {feeBps > 0 ? ` (after a ${feeBps / 100}% fee)` : ""}. Good luck!
          </p>
        </>
      ) : r.status === "unfilled" || r.status === "expired" ? (
        <>
          <Mascot mood="calm" size={72} />
          <p className="text-xl font-extrabold">Not filled. Your money is back.</p>
          <p className="max-w-xs text-sm leading-relaxed text-muted">
            The price moved before your bet could be priced, or the market paused for a moment.
            Nothing was spent except network fees. You can try again right away.
          </p>
        </>
      ) : (
        <>
          <Mascot mood="think" size={72} />
          <p className="text-xl font-extrabold">Your bet is placed</p>
          <p className="max-w-xs text-sm leading-relaxed text-muted">
            {phase.note ??
              "It hasn't been filled yet. It is filled or cancelled within seconds; if nobody fills it, you can cancel it from My bets and get your money back."}
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
          {r.status === "unfilled" || r.status === "expired" ? "Try again" : "Done"}
        </Button>
        <Link
          href="/positions"
          className="flex min-h-12 flex-1 items-center justify-center rounded-[18px] bg-brand text-sm font-bold text-[#15112e]"
        >
          My bets
        </Link>
      </div>
    </div>
  );
}
