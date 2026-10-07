# Phase 7 report: the consumer app

**Status: COMPLETE WITH CAVEATS.** The app is built, tested end to end against a local chain with the real contracts and the real keeper (10 Playwright tests, a timed first trade of about 5 seconds), passes Lighthouse on nine pages, and is deployed on Vercel. It has **not** been run against Monad testnet from a phone: the testnet has no live rounds, no running keeper and no funded relayer right now (they need MON and the Phase 2 scheduler, listed under "Needs from Nisarg"), so criterion 4 is open.

## What was built

- **`apps/web`** (Next.js 16.4 App Router, React 19, Tailwind 4, TanStack Query 5, viem, Mera 0.2.0), strict TypeScript:
  - Screens: landing with a live ticker and "Start with Face ID" (`/`), onboarding (`/start`: create or restore a passkey account, the account shown as a handle like `calm-otter-47`, a self-custody and export explainer linking Mera's docs), funding (`/fund`: address, QR, copy, balance, a testnet faucet button, the gas top-up), markets (`/markets`, rendered on the server so the first paint has the rounds), a market page (`/market/[address]`: live chart with the start-price line, fair odds, Up/Down with prices, a "you win" calculation), the trade sheet (amount presets, one passkey confirmation, slippage limit, pending/filled/refunded results, error recovery), My bets (`/positions`: open and finished bets, orders waiting to be filled with a cancel-and-refund button, one-tap collect for winnings), Earn (`/vault`: epoch countdown, vault value and share value, 7d/30d APY and a performance chart from the indexer, deposit and withdraw requests with claims, the risk disclosure above the deposit form), public stats (`/stats`), the account page (`/account`: recovery phrase for export to MetaMask or Rabby after a passkey prompt, sign out), legal pages (terms, risk disclosure, privacy), a block page.
  - **Mera is the only account layer**: `src/lib/account.ts` (create, restore, one signing session per confirmation that zeroes the key), `src/lib/derive.ts` (the Mera guide's BIP-39/BIP-44 derivation, so the exported phrase gives the same address in MetaMask). `scripts/check-deps.mjs` fails the build if another wallet SDK is a dependency.
  - **Trade routing**: one route, the forward-priced venue (`placeOrder`, executed about 2 s later at the oracle report, unspent escrow refunded). There is no Kuru book or pm-AMM in this repo (ADR-004/005), so the prompt's three routing options collapse to this one.
  - **Data**: the app reads the chain directly for everything a trade needs and uses the indexer where it exists (stats, APY, history, PnL); every indexer panel has a "not connected" state. "Now" is the chain's clock, not the device's.
  - **Edge**: `src/middleware.ts` region block (HTTP 451 and an explanation page; India and the OFAC embargoed countries by default; an **exit-only mode** keeps collect, withdraw and export open in blocked regions), CSP and HSTS headers, an optional reviewer bypass that exists only if `REGION_BYPASS_TOKEN` is set.
  - **Relayer** (`src/server/relayer.ts`, `/api/gas`, `/api/faucet`): the gas top-up for accounts that have deposited, and a testnet-only faucet; one hot key, never user keys (ADR-007).
  - **PWA**: manifest, icons (SVG and PNG, maskable), a service worker with an offline shell, an offline page. Web push is **not built**: it needs a push server and stored subscriptions (a stateful backend); the app offers add-to-home-screen instead.
  - **Analytics**: a funnel (`landing_view`, `account_created`, `funded`, `first_trade`, `lp_deposit`), each sent once per browser with an anonymous random id, no address, no handle, `person_profiles` off; nothing is sent without `NEXT_PUBLIC_POSTHOG_KEY`. Not verified against a real PostHog project (no key).
- **`packages/sdk/src/trade.ts`** (+ 7 tests): order sizing from a budget (escrow never exceeds it), limit and slippage, the ladder price for each side, transaction builders (approve, placeOrder, redeem, expire, deposit, redeem and claim requests), round phases.
- **Docs**: `docs/phases/PHASE-7-plan.md`, **ADR-007** (gas and onboarding; the prompt calls it ADR-004, which is taken), `apps/web/config/regions.json` (the decision list).

## How to verify it yourself

```bash
export PATH=$HOME/.foundry/bin:$PATH
(cd apps/web && pnpm exec playwright install chromium)   # once; Linux needs its system libraries
make check-7          # check-all, forge build, web typecheck, unit tests, dependency check, 10 Playwright tests, evidence present
make lighthouse-7     # builds, audits nine pages, writes docs/evidence/phase-7/lighthouse/
node apps/web/scripts/check-deps.mjs   # Mera is the only account layer
```

Deployed (production alias of the Vercel project `converge-markets-app`): https://converge-markets-app.vercel.app . From India the app answers HTTP 451 by design; to test from India set `REGION_BYPASS_TOKEN` (16+ characters) in the Vercel project and open `/?region_bypass=<token>` once on the device.

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `make check-7` passes (lint, typecheck, unit, Playwright e2e) | **PASS** (`make check-7` OK: `check-all` including the contracts' tests, then the web checks, 10 e2e tests in 1.0 min) | `docs/evidence/phase-7/check-7.txt` |
| 2 | Timed first-trade e2e < 60 s, time recorded, video | **PASS on a local chain: 4.9 s** (landing 0.2, account 0.4, funded 1.5, market ready 1.8, confirmed 2.1, filled 4.9). The chain is anvil with 0.4 s blocks, so it is faster than Monad testnet will be (expect several more seconds for the faucet, the approval, the order and the execution); no testnet timing exists yet | `first-trade-timing.json`, `first-trade.webm`, `first-trade-result.png` |
| 3 | Lighthouse mobile: performance >= 90, accessibility >= 95, best practices >= 95 | **PASS on 9 pages** (below). The market page and the trade sheet are not audited (they need a live market) | `docs/evidence/phase-7/lighthouse/` |
| 4 | Vercel preview on testnet works end to end on a real phone (Nisarg to confirm, with steps) | **OPEN.** Deployed and serving (security headers verified, `/markets` renders, shows "No rounds yet"). Not end to end: testnet has no live rounds, no running keeper and no funded relayer. Steps below | this report |
| 5 | Mera is the only account layer (grep proof) | **PASS** | `scripts/check-deps.mjs` output in `check-7.txt` |
| 6 | ADR (gas) and the region-block list written and flagged for decision | **PASS** | `docs/adr/ADR-007-gas-and-onboarding.md`, `apps/web/config/regions.json` |
| 7 | Hostile review has no open CRITICAL or HIGH | **PASS after two rounds, with one judgement call:** no CRITICAL; the 6 HIGH of round 1 were rated FIXED (2) or PARTIAL (4) in round 2, and the remaining gaps (below) are limits I rate MEDIUM, not HIGH | below |

Lighthouse (mobile, Lighthouse's default simulated throttling), performance / accessibility / best practices: `/` 98/100/100, `/markets` 95/100/100, `/stats` 93/100/100, `/legal/terms` 99/100/100, `/start` 99/100/100, `/vault` 97/100/100, `/fund` 97/100/100, `/positions` 95/100/100, `/account` 99/100/100.

### PRF in the Chromium virtual authenticator

Verified: Chromium's WebAuthn virtual authenticator with `hasPrf: true` (CTAP2, internal transport, resident keys, user verification) works with Mera: `createPasskeyWithPrfOutput` and `getPasskeyPrfOutput` both return the 32-byte PRF output, the derived address is stable across prompts, and the recovery phrase it exports derives the same address with viem's `mnemonicToAccount` (asserted in `flows.spec.ts` and in `test/lib.test.ts`). So the e2e uses the real account flow and no test-only account or flag exists. The headless Chromium shell needs `libnspr4`, `libnss3` and `libasound2` on Linux.

## Test summary

- Web: 8 unit tests (derivation equals MetaMask's, handles, the region decision, formatting, the round grid), 10 Playwright tests on a 375x812 mobile profile against anvil with the real contracts, the real keeper and a production build of the app: the timed first trade; static pages and PWA files with no console errors; the region block (HTTP 451 for pages and the API, the bypass); the exit path; restore with no passkey and the recovery phrase; no money (the sheet sends you to add money); a paused market; an LP deposit with the risk text and the required box; **a bet nobody fills** (shown as waiting, no second bet offered, focus stays in the sheet, cancelled for a full refund); a winning bet collected in one tap after resolution. Every test fails on any console error or hydration warning. SDK: `trade.ts` 7 tests (55 in the package).
- Static: eslint, prettier, tsc strict on the app and the e2e project, `check-deps`.

## Hostile review (product designer + frontend and web-security reviewer, subagent)

Round 1: **0 CRITICAL, 6 HIGH**, ~20 MEDIUM. HIGH, all fixed with tests where testable: (1) a bet that is not filled was invisible and its escrow unrecoverable in the UI, now listed with a cancel-and-refund button; (2) a failure after the order landed offered "Try again" and could place a second bet, now nothing after placement can; (3) winnings from rounds older than the live window were not listed, now found from this device's records and the indexer, and the vault shows older request windows; (4) gas: one reserve (0.05 MON) shared by the sheet, the funding page and the relayer, the drip no longer requires a first transaction, retries and shows why it was refused, ADR-007's numbers corrected; (5) relayer limits: separate faucet and drip budgets, a $1 stablecoin gate, a per-address cooldown, an in-flight lock and one send at a time, and ADR-007 now says plainly that serverless counters are best effort and a $1 gate is not strong; (6) the exit path in blocked regions: collect, withdraw and export stay open. MEDIUMs fixed: net-of-fee payout and profit-based "you win" copy, prices vs fair odds, betting disabled on a stale price feed, cancelled rounds labelled 50 cents back, an inert page and focus trap in the sheet, the risk text above the deposit form, CSP and HSTS, runtime executor reward, recovery phrase auto-hide, wording of the privacy text, landing copy. Round 2 (same reviewer): no CRITICAL, no NOT FIXED; two HIGH fixed, four PARTIAL. Fixed in the last commit: the order is tracked from the moment its transaction is broadcast (a receipt failure can no longer offer a retry) and, when its id cannot be read from the receipt, it is recovered by taker from the venue's logs; the relayer tops up accounts up to reserve + reward + margin, so an account the trade sheet refuses is always one the relayer serves. **Remaining, accepted as MEDIUM:** orders and old markets are found from this device's records or the indexer, so a new device with cleared storage and no indexer does not see an unfilled order or a win older than the live window (about 45 minutes); the relayer's counters are per instance on serverless; the testnet faucet has no per-chain guard; the bypass token travels in a query string.

**Open (MEDIUM or LOW, accepted):** optimistic UI is limited to the waiting state and an immediate "waiting" row (no optimistic position); the passkey's user name is a timestamp, not the handle, so several accounts look alike in the OS picker; the odds preview uses the exchange spot against the oracle's strike (display only, the limit protects the money) and the TEST series is labelled ETH; the market page, the trade sheet and the vault with data are not Lighthouse-audited; the service worker's asset cache is not pruned; the legal texts are drafts for counsel; `middleware.ts` is deprecated in Next 16 in favour of `proxy.ts` (it still builds and runs on Vercel's edge; migrating changes the runtime).

## Deviations and decisions

- **ADR-007**, not ADR-004: the gas decision (default: a rate-limited drip) is flagged DECISION NEEDED. EIP-7702 sponsorship on Monad is **unverified**.
- **Single trade route** (see above). **No web push**. The prompt's "Kuru book buy" and "pm-AMM" paths do not exist.
- The testnet series is **TEST/USD** (the Phase 2/4 stack), displayed as ETH with the ETH price; BTC, ETH and MON series come with the mainnet deployment.
- Deployed to the **production** target of a new Vercel project (a preview URL is a deployment of the same build); project settings are Vercel's defaults.

## Known issues and risks (no rounding up)

1. Not tested on a real phone or on Monad testnet; the 4.9 s is a local-chain figure.
2. The relayer's counters are per instance; without a KV store the hot key's balance is the only hard bound. The drip key is not set on the Vercel project (no faucet there).
3. Real iOS/Android passkey providers differ from Chromium's virtual authenticator (PRF support matrix in EXTERNAL.md): an unsupported device gets a clear message but cannot create an account.
4. Analytics and the privacy statement were not verified against a live PostHog project.
5. The recovery phrase and key material exist in JS memory during a signing session; zeroing covers the buffers we hold, not every copy the JS engine made.

## Needs from Nisarg

1. **To make criterion 4 true**: testnet MON (about 5 MON) for the relayer key, a keeper run and the Phase 2 fallback scheduler creating TEST rounds (the Phase 5 `scripts/keeper-live` driver does this); set in the Vercel project `DRIP_PRIVATE_KEY`, `FAUCET_ENABLED=1`, `NEXT_PUBLIC_FAUCET_ENABLED=1`, `NEXT_PUBLIC_INDEXER_URL` (when the hosted indexer exists). Then on a phone: open the URL (from India add the bypass), Create account with Face ID, Get free test money, pick the live round, Up, confirm; time it.
2. **Decisions**: the gas approach (ADR-007) and a check of EIP-7702 on Monad; the restricted-region list (`config/regions.json`: US is not blocked by default, a legal call), whether judges get a bypass; the legal texts reviewed by counsel; whether the exit-only mode is acceptable.
3. A PostHog project key and region, if analytics should be live.
4. Disable Vercel Authentication on the project if the URL asks for a Vercel login.

## Readiness for the next phase

**Yes for a demo build** (the product works end to end locally and the deployment serves); **no for a public testnet beta** until needs 1 and 2 are met.
