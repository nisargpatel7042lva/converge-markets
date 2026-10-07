# Phase 7 plan: the consumer app

Goal (prompt): a production-quality mobile-first PWA where Mera is the entire account layer, users trade UP/DOWN in two taps, and LPs deposit into the vault with clear risk disclosure. Landing to first trade in under 60 seconds.

## Orientation: what exists and what that means

- **Trading is forward-priced** (ADR-004/005): a trade is `ForwardVenue.placeOrder(market, kind, shares, limit)` with a small native reward; anyone (the keeper) executes it two seconds later at the report for that second; the unspent escrow is refunded. There is no Kuru book and no pm-AMM pool in this repo (Kuru is blocked, ADR-001 was superseded by ADR-004/005), so the prompt's routing options "Kuru book buy / split + sell / pm-AMM" collapse to one route: the venue. The SDK gets `trade.ts` with the order builder, the quote preview (`ForwardVenue.quoteAt`), approvals, claims and the LP calls.
- **Data**: the Phase 6 indexer is the source for lists, history, stats and APY, but it is only available locally (Envio hosted is BLOCKED on a token). So the app reads **the chain directly** for what a trade needs (the grid of rounds is deterministic: `factory.getMarket(assetId, duration, start)`; market state, strike, balances, the vault's view) and uses the indexer when `NEXT_PUBLIC_INDEXER_URL` is set (stats, positions history, vault APY and PnL, volume). Every indexer panel has a "not available yet" state, so the app still works with no indexer.
- **Account**: Mera 0.2.0 (`@category-labs/mera`): a passkey with the WebAuthn PRF extension gives 32 bytes; the key is derived as in the Mera guide (BIP-39 `entropyToMnemonic(prf)` -> BIP-44 `m/44'/60'/0'/0/0`), wrapped in a viem account with `toViemAccount`. One passkey prompt per confirmation creates a signing session, which signs the approval and the order and is then ended (key zeroed). The "username-style handle" is the passkey's user name that the app generates (`calm-otter-47`); the address is secondary.
- **Gas**: ADR-007 (DECISION NEEDED): a rate-limited gas drip route is the default.
- **No custody backend**: the only server code is the drip/faucet relayer (holds a small hot key, never user keys) and the region middleware.

## Assumptions

1. Next.js 16.4 (App Router, current stable on 2026-10-07), React 19, Tailwind 4, TanStack Query 5, viem 2.57. Verified in EXTERNAL.md.
2. Testnet only for the demo (TEST/USD series, MON gas, open-mint test USDC). The app is network-agnostic through config; a mainnet deployment needs real series and a real faucet-free funding flow.
3. Spot prices in the browser come from public exchange WebSockets (Binance book ticker, Coinbase fallback) for the chart and the probability preview only. Fills are priced on chain by the oracle report, so the display is not security relevant.
4. Web push needs a push server and stored subscriptions (a backend with state); skipped, noted in the report (the app offers "add to home screen" and an in-app resolved banner instead).

## Tasks and the acceptance criteria they serve

| # | Task | AC |
|---|---|---|
| T1 | Scaffold `apps/web` (Next 16, Tailwind 4, TanStack Query, strict TS), config from env/deployments, chain and indexer clients | 1 |
| T2 | SDK `trade.ts` (order builder, limit/slippage, quote preview, approve, claim, LP calls) + unit tests | 1 |
| T3 | Mera account layer: create/restore, handle, session per confirmation, export explainer; analytics wrapper | 1, 5 |
| T4 | Screens: landing, onboarding, funding (QR, faucet, gas drip), markets list, market page + trade sheet, positions + claim | 1, 2 |
| T5 | Screens: vault (deposit/redeem, epoch countdown, NAV, APY, PnL chart, risk text), public stats, legal pages | 1 |
| T6 | Edge middleware region block + block page + `config/regions.json`; ADR-007; decisions list | 6 |
| T7 | PWA: manifest, icons, service worker, offline shell | 3 |
| T8 | Playwright e2e on anvil with the real contracts and the real keeper, Chromium virtual authenticator (PRF), timed first trade, video | 1, 2 |
| T9 | Lighthouse mobile runs (performance, accessibility, best practices), fixes | 3 |
| T10 | Vercel preview deploy (if the connector allows) and phone test steps | 4 |
| T11 | `make check-7`, dependency grep proof (Mera only), hostile review (product designer + frontend), report, STATUS | 1, 5, 7 |
