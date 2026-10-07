"use client";

import {
  ConvergeError,
  createConvergeClient,
  mockErc20Abi,
  type ConvergeClient,
  type Fill,
  type MarketView,
  type Position,
  type Quotes,
} from "@converge/sdk";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chainOf, type DemoConfig } from "../lib/config";
import {
  chanceYes,
  cents,
  question,
  sharesToUsd,
  sideCard,
  statusLine,
  winText,
  type Side,
} from "../lib/view";

const KEY = "converge-partner-demo-key";

type Wallet = { client: WalletClient; address: Address; kind: "browser wallet" | "demo account" };

declare global {
  interface Window {
    ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
  }
}

export function MarketEmbed({ cfg }: { cfg: DemoConfig }) {
  const chain = useMemo(() => chainOf(cfg), [cfg]);
  const publicClient = useMemo(
    () => createPublicClient({ chain, transport: http(cfg.rpcUrl) }),
    [chain, cfg.rpcUrl],
  );
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const converge: ConvergeClient = useMemo(
    () =>
      createConvergeClient({
        publicClient,
        walletClient: wallet?.client,
        addresses: cfg.addresses,
        indexer: cfg.indexerUrl ? { url: cfg.indexerUrl } : undefined,
      }),
    [publicClient, wallet, cfg.addresses, cfg.indexerUrl],
  );

  const [view, setView] = useState<MarketView | null>(null);
  const [quotes, setQuotes] = useState<Quotes | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [spot, setSpot] = useState<number | null>(cfg.spotFixed);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [side, setSide] = useState<Side>("UP");
  const [amount, setAmount] = useState("5");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fills, setFills] = useState<Fill[]>([]);

  // ---- the market, its prices and my position, every two seconds
  const market = cfg.market;
  const refresh = useCallback(async () => {
    if (!market) return;
    try {
      const m = await converge.getMarket(market);
      setView(m);
      const s = spot ?? m.strikeNumber;
      if (m.phase.phase === "LIVE") setQuotes(await converge.getQuotes(market, { spot: s }));
      if (wallet) setPosition(await converge.getPosition(market, wallet.address));
    } catch (e) {
      setError(messageOf(e));
    }
  }, [converge, market, spot, wallet]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
      void refresh();
    }, 2_000);
    return () => clearInterval(t);
  }, [refresh]);

  // ---- an indicative spot price (the vault itself prices from the oracle)
  useEffect(() => {
    if (cfg.spotFixed !== null) return;
    let stop = false;
    const load = async () => {
      try {
        const r = await fetch(
          `https://api.binance.com/api/v3/ticker/price?symbol=${cfg.spotSymbol}`,
        );
        const j = (await r.json()) as { price?: string };
        if (!stop && j.price) setSpot(Number(j.price));
      } catch {
        // the strike stands in until a price arrives
      }
    };
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [cfg.spotFixed, cfg.spotSymbol]);

  // ---- every fill in this market, as the SDK sees it
  useEffect(() => {
    if (!market) return;
    return converge.subscribeFills({ market }, (f) => setFills((xs) => [f, ...xs].slice(0, 5)));
  }, [converge, market]);

  // ---- accounts: an injected wallet, or a throwaway key kept in this browser (testnet only)
  const useBrowserWallet = async () => {
    if (!window.ethereum) return setError("No browser wallet found. Use a demo account instead.");
    const client = createWalletClient({ chain, transport: custom(window.ethereum) });
    const [address] = await client.requestAddresses();
    if (address) setWallet({ client, address, kind: "browser wallet" });
  };
  const useDemoAccount = () => {
    let key = localStorage.getItem(KEY) as `0x${string}` | null;
    if (!key) {
      key = generatePrivateKey();
      localStorage.setItem(KEY, key);
    }
    const account = privateKeyToAccount(key);
    const client = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
    setWallet({ client, address: account.address, kind: "demo account" });
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const buy = () =>
    run("Placing your bet…", async () => {
      if (!market) return;
      const order = await converge.buy({
        market,
        side,
        amount,
        spot: spot ?? view?.strikeNumber ?? 0,
      });
      setBusy("Waiting for the fill (about 2 seconds)…");
      const fill = await converge.waitForFill(order.orderId);
      setBusy(
        fill.status === "EXECUTED"
          ? `Filled: ${sharesToUsd(fill.filled).toFixed(2)} shares for $${sharesToUsd(fill.premium).toFixed(2)}`
          : "Not filled (the price moved past your limit). Your money is back.",
      );
      await new Promise((r) => setTimeout(r, 2_500));
    });

  const redeem = () =>
    run("Collecting…", async () => void (market && (await converge.redeem(market))));

  const mint = () =>
    run("Getting test dollars…", async () => {
      if (!wallet) return;
      const hash = await wallet.client.writeContract({
        address: cfg.addresses.collateral,
        abi: mockErc20Abi,
        functionName: "mint",
        args: [wallet.address, 100_000_000n],
        account: wallet.address,
        chain,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    });

  if (!market) {
    return (
      <section className="card">
        <p>
          No market is configured. Create one with <code>pnpm create-market</code> and set{" "}
          <code>NEXT_PUBLIC_MARKET</code>.
        </p>
      </section>
    );
  }
  if (!view) {
    return (
      <section className="card">
        <p className="muted">Loading the market…</p>
        {error ? <p className="err">{error}</p> : null}
      </section>
    );
  }

  const q = view.phase.phase === "LIVE" ? quotes : null;
  const chance = chanceYes(q);
  const card = (s: Side) => sideCard(q, s);
  const price = q ? (side === "UP" ? q.up.ask?.price : q.down.ask?.price) : undefined;
  const settled = view.phase.phase === "SETTLED";
  const claim = position ? sharesToUsd(position.claimable) : 0;

  return (
    <>
      <section className="card" aria-live="polite">
        <p className="q">{question(cfg.assetLabel, view.strikeNumber, view.endTime, now)}</p>
        <p className="muted">{statusLine(view, now)}</p>
        {chance !== null ? (
          <>
            <div className="bar" role="img" aria-label={`${chance}% chance of yes`}>
              <span style={{ width: `${chance}%` }} />
            </div>
            <p className="muted">{chance}% chance of yes</p>
          </>
        ) : null}
        {!settled ? (
          <>
            <div className="row">
              {(["UP", "DOWN"] as const).map((s) => {
                const c = card(s);
                return (
                  <button
                    key={s}
                    className={`side ${s === "UP" ? "yes" : "no"}`}
                    aria-pressed={side === s}
                    disabled={!c.enabled}
                    onClick={() => setSide(s)}
                  >
                    <strong>
                      {c.label} {c.price}
                    </strong>
                    <br />
                    <span className="muted">{c.depth}</span>
                  </button>
                );
              })}
            </div>
            {!view.quoting && view.phase.phase === "LIVE" ? (
              <p className="muted">Waiting for the vault&apos;s liquidity to arrive…</p>
            ) : null}
          </>
        ) : null}
      </section>

      {!settled ? (
        <section className="card">
          {wallet ? (
            <>
              <p className="muted">
                {wallet.kind}: <code>{wallet.address}</code>
              </p>
              <label htmlFor="amount" className="muted">
                Amount in test dollars
              </label>
              <input
                id="amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              {price ? (
                <p className="muted">{winText(Number(amount), price, view.redeemFeeBps)}</p>
              ) : null}
              <button
                className="primary"
                disabled={!!busy || !price}
                onClick={buy}
                title={price ? undefined : "No depth on this side right now"}
              >
                Buy {side === "UP" ? "Yes" : "No"} {price ? `at ${cents(price)}` : ""}
              </button>
              <button disabled={!!busy} onClick={mint} style={{ marginTop: 8, width: "100%" }}>
                Get 100 test dollars (testnet)
              </button>
            </>
          ) : (
            <div className="row">
              <button onClick={useDemoAccount}>Use a demo account</button>
              <button onClick={useBrowserWallet}>Connect a wallet</button>
            </div>
          )}
        </section>
      ) : (
        <section className="card">
          {claim > 0 ? (
            <button className="primary" disabled={!!busy} onClick={redeem}>
              Collect ${claim.toFixed(2)}
            </button>
          ) : (
            <p className="muted">Nothing to collect.</p>
          )}
        </section>
      )}

      {busy ? <p role="status">{busy}</p> : null}
      {error ? (
        <p role="alert" className="err">
          {error}
        </p>
      ) : null}

      {fills.length > 0 ? (
        <section className="card">
          <strong>Live fills</strong>
          <ul className="fills">
            {fills.map((f) => (
              <li key={`${f.txHash}-${f.block}-${f.shares}`}>
                {f.action === "BUY" ? "Bought" : "Sold"} {f.side === "UP" ? "Yes" : "No"}{" "}
                {sharesToUsd(f.shares).toFixed(2)} at {cents(f.price)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="muted">
        Liquidity by the Converge Vault. Testnet only: these are test dollars.
      </p>
    </>
  );
}

function messageOf(e: unknown): string {
  if (e instanceof ConvergeError) return e.message;
  const m = e instanceof Error ? e.message : String(e);
  return m.split("\n")[0] ?? "Something went wrong";
}
