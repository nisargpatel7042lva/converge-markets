# Final end-to-end checks of the four sponsor tracks (2026-10-11)

Each track was exercised live where gas allowed, and the checks found real bugs. Gas ran out part-way (the deployer and keeper wallets hold under 0.2 MON between them), so some checks are marked blocked rather than claimed.

## Kuru: "Bring New Assets and Markets to Kuru"

| Check | Result | Evidence |
|---|---|---|
| Lister runs end to end with the current code on a live round | **PASS.** Market created for the 06:15 round's UP token, seeded, two-sided quotes posted. | `docs/evidence/kuru/rounds.md` (round `2026-10-11T06:15Z`), `deployments/kuru-testnet.json` |
| The re-quote policy fix, re-measured live | **PASS.** 3 quotes in 7 minutes (the earlier policy posted 18 in 11 minutes). Whole round so far 4,011,104 gas (about 0.41 MON at 102 gwei) including creation and seeding. | same |
| The app finds the lister's market from its own copy of the parameters | **PASS** for both live markets: `Router.computeAddress` equals the lister's market, and code exists at it. | script run 2026-10-11 |
| The app shows the book correctly | **BUG FOUND AND FIXED.** `bestBidAsk()` returns a different price scale on a market created on 2026-10-11 (1e18 per dollar, 4.48e17 for a 0.448 bid) than on the 2026-10-09 market (1e14 per dollar). The old decoding would have shown 4,480. Fixed in the app and the service by taking the one scale that gives a price in the quoting band, with the empty-book sentinel as "no quote"; 4 new unit tests (13 total). | `services/kuru/test/quote.test.ts` |
| Taker fills against the new market; teardown and redeem | **BLOCKED on gas.** The round 06:15 position is still quoting on Kuru and resumes with the lister once the maker wallet is funded (about 0.25 MON to close it out). The taker fill and full teardown on the older market are in the submission. | `deployments/kuru-testnet.json` |

## Chainlink CRE: "Best workflow with CRE"

| Check | Result | Evidence |
|---|---|---|
| Workflow compiles to WASM with the official CLI | **PASS**, same binary hash (`ee076fc1…3317`) on 2026-10-10 and 2026-10-11 | `cre workflow build scheduler -T staging-settings` |
| Simulation against live testnet, logged in | **PASS**, twice. 2026-10-10: 2 chain reads, 8 planned actions. 2026-10-11, after the scheduler's sweep had cleaned up: 2 chain reads, 1 planned action. | `docs/evidence/cre/simulate-testnet.txt`, `simulate-testnet-2026-10-11.txt` |
| Deployed, or a broadcast write through the forwarder | **NOT DONE.** Deployment needs CRE Early Access (the account shows "Deploy Access: Not enabled"); a broadcast simulation needs gas. | `cre whoami` |

## Monad Foundation: "Best Mera-Powered UX"

| Check | Result | Evidence |
|---|---|---|
| Passkey flow on a local chain | **PASS**, 10 of 10 end-to-end tests, in the working tree and in a fresh clone | `docs/evidence/phase-10/e2e.txt`, `fresh-clone.md` |
| A passkey account created on the live testnet app | **PASS.** Account created with a virtual authenticator with PRF; its address `0xa0fC3431…E670` holds 100 tUSDC from the faucet (verified on chain). | [explorer](https://testnet.monadvision.com/address/0xa0fC3431A859117EA2671d0C6b58f1643086E670) |
| The faucet works for a new account | **BUG FOUND AND FIXED.** Every new account got HTTP 500: the gas drip and the mint, sent back to back, are rejected by the public RPC (`Missing or invalid parameters`). Reproduced with a script; the fix waits for the first receipt. | commit `b3e8ec8`; `apps/web/src/server/relayer.ts` |
| A bet from that account on a live round, filled by the keeper | **BLOCKED on gas.** The faucet's 0.1 MON gas drip could not be funded, so the account had no gas. Two earlier attempts also hit a round in its last minute. The test (`apps/web/e2e-testnet/`) is ready and records timings and the reason if a bet is not possible. | `apps/web/e2e-testnet/first-trade-testnet.spec.ts` |

## Envio: "Best Use of Envio"

| Check | Result | Evidence |
|---|---|---|
| Indexer runs on real testnet data | **PASS.** 7,600-block window, 91 events. Indexed volumes equal what the keeper logged on chain. | `docs/evidence/phase-10/envio-testnet-window.md` |
| Reconcile against the chain | **27 of 29 sampled entities match; the tool's own verdict is FAIL** (it wants 60 samples; the window has 29; the 2 differences are exactly the first LP deposit, which settled before the window). All 6 internal invariants pass. | `envio/reconcile-testnet-window.md` |
| Query latency | **PASS**: worst p95 6.1 ms sequential, 8.6 ms concurrent (local Hasura) | `envio/latency-testnet-window.md` |
| The app reads it | **PASS**: the stats page issues 4 indexer queries, Earn issues 2, with no console errors | same |
| Stats page reliability | **BUG FOUND AND FIXED.** `/api/stats` took 12 s and failed under the public RPC's rate limit. Now parallel, patient, stale-while-revalidate and warmed at start: 12 s cold, 21 ms warm, 22 ms for the first visitor after a restart. | `apps/web/src/app/api/stats/route.ts`, `src/instrumentation.ts` |
| Hosted on Envio Cloud | **NOT DONE (owner's step).** | |

## The keeper's price-health flicker

**Fixed.** Root cause, measurements and the test that pins it: `docs/evidence/phase-10/price-feed-flicker.md`. After the fix, one funded keeper ran about 50 minutes with 0 quote pulls, 0 risk events and 0 event-loop stalls, against roughly one pull a minute before.

## What these checks changed

Five real defects, none visible without running things live: the price-health flicker (one stale-feed threshold), the faucet's back-to-back transactions, Kuru's changed price scale, the stats endpoint's cold start, and a duplicate-keeper restart mistake. All fixed and committed except where marked blocked.
