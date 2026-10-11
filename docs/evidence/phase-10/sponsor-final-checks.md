# Final end-to-end checks of the four sponsor tracks (2026-10-11)

Each track was exercised live where gas allowed, and the checks found real bugs. Gas ran out part-way (the deployer and keeper wallets hold under 0.2 MON between them), so some checks are marked blocked rather than claimed.

## Kuru: "Bring New Assets and Markets to Kuru"

| Check | Result | Evidence |
|---|---|---|
| Lister runs end to end with the current code on a live round | **PASS.** Market created for the 06:15 round's UP token, seeded, two-sided quotes posted. | `docs/evidence/kuru/rounds.md` (round `2026-10-11T06:15Z`), `deployments/kuru-testnet.json` |
| The re-quote policy fix, re-measured live | **PASS.** 3 quotes in 7 minutes (the earlier policy posted 18 in 11 minutes). Whole round so far 4,011,104 gas (about 0.41 MON at 102 gwei) including creation and seeding. | same |
| The app finds the lister's market from its own copy of the parameters | **PASS** for both live markets: `Router.computeAddress` equals the lister's market, and code exists at it. | script run 2026-10-11 |
| The app shows the book correctly | **BUG FOUND AND FIXED.** `bestBidAsk()` returns a different price scale on a market created on 2026-10-11 (1e18 per dollar, 4.48e17 for a 0.448 bid) than on the 2026-10-09 market (1e14 per dollar). The old decoding would have shown 4,480. Fixed in the app and the service by taking the one scale that gives a price in the quoting band, with the empty-book sentinel as "no quote"; 4 new unit tests (13 total). | `services/kuru/test/quote.test.ts` |
| Taker fills against the new market | **PASS** (2026-10-11 08:07 UTC, round 08:00). A second wallet bought 3.5906 UP for $2.00 at an average 0.5570 ([buy](https://testnet.monadvision.com/tx/0x9a855a36ab0473372ff9d03f35f3a3b58c88338889e5a19cf4e57d0941fc4e44)) and sold it back for $1.7091 ([sell](https://testnet.monadvision.com/tx/0x2d7e42983b78234ab909f3481e1324ae85a140edc917ec87b37881471217bef0)): the spread cost $0.29 on $2.00. Book at the time: bid 0.476 / ask 0.557. | `deployments/kuru-testnet.json` |
| A stranded position is closed out | **PASS.** The 06:15 round's position was left open when the maker ran out of gas; after funding, the lister closed it ("it was left open past its end": quotes pulled, margin withdrawn) and redeemed it. The lister now closes any listed round past its end on startup. | `services/kuru/src/main.ts`; `.testnet/kuru3.log` |

## Chainlink CRE: "Best workflow with CRE"

| Check | Result | Evidence |
|---|---|---|
| Workflow compiles to WASM with the official CLI | **PASS**, same binary hash (`ee076fc1…3317`) on 2026-10-10 and 2026-10-11 | `cre workflow build scheduler -T staging-settings` |
| Simulation against live testnet, logged in | **PASS**, twice. 2026-10-10: 2 chain reads, 8 planned actions. 2026-10-11, after the scheduler's sweep had cleaned up: 2 chain reads, 1 planned action. | `docs/evidence/cre/simulate-testnet.txt`, `simulate-testnet-2026-10-11.txt` |
| Broadcast write through the forwarder | **PASS.** Tx `0xf84bf488…b76d`: the forwarder emitted `ReportProcessed` with result = true; the 08:30 round was created and the stranded 07:00 round invalidated; verified on chain. The first attempt (`0xfde5065c…48c3`) was correctly refused by the receiver because the simulator stamps a placeholder workflow owner. | `docs/evidence/cre/broadcast-testnet-2026-10-11.md` |
| Deployed workflow | **NOT DONE.** Deployment needs CRE Early Access (the account shows "Deploy Access: Not enabled"). | `cre whoami` |

## Monad Foundation: "Best Mera-Powered UX"

| Check | Result | Evidence |
|---|---|---|
| Passkey flow on a local chain | **PASS**, 10 of 10 end-to-end tests, in the working tree and in a fresh clone | `docs/evidence/phase-10/e2e.txt`, `fresh-clone.md` |
| A passkey account created on the live testnet app | **PASS.** Account created with a virtual authenticator with PRF; its address `0xa0fC3431…E670` holds 100 tUSDC from the faucet (verified on chain). | [explorer](https://testnet.monadvision.com/address/0xa0fC3431A859117EA2671d0C6b58f1643086E670) |
| The faucet works for a new account | **BUG FOUND AND FIXED.** Every new account got HTTP 500: the gas drip and the mint, sent back to back, are rejected by the public RPC (`Missing or invalid parameters`). Reproduced with a script; the fix waits for the first receipt. | commit `b3e8ec8`; `apps/web/src/server/relayer.ts` |
| A bet from a passkey account on a live round, filled by the keeper | **PASS** (2026-10-11 08:05 UTC). Fresh account `0xF0FF1381…1275` (handle eager-badger-35): created, funded by the faucet, bet placed and **filled by the keeper in 18.7 s** from landing page to "You're in" (landing 0.2 s, account 0.4 s, funded 4.3 s, market ready 9.4 s, confirmed 9.8 s, result 18.7 s). Earlier attempts failed for three reasons, all fixed: no gas in the deployer, a round in its last minute, and the keeper's `setSigma` refused by `rpc-testnet.monadinfra.com` (see below). | `docs/evidence/phase-10/mera-testnet-trade.{json,webm}`, `mera-testnet-result.png` |

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

## The "market paused" defect (found by the live trade)

The keeper fails over between public RPC endpoints. `rpc-testnet.monadinfra.com` rejects every JSON-RPC batch ("Restricted JSON RPC method"), so each volatility refresh (`setSigma`) sent through it failed, sigma went stale and the vault stopped quoting: the app showed "Betting is paused for this round". Fix: `unbatchOnRestricted` in `services/keeper/src/chain/clients.ts` remembers an endpoint that refuses a batch and re-sends its calls one by one; 5 unit tests in `services/keeper/test/unit/rpc-batch.test.ts`. After the fix: 0 send failures and the live trade above.

## What these checks changed

Six real defects, none visible without running things live: the price-health flicker (one stale-feed threshold), the faucet's back-to-back transactions, Kuru's changed price scale, the stats endpoint's cold start, the keeper's batched RPC calls refused by one endpoint, and a duplicate-keeper restart mistake. All fixed and committed except where marked blocked.
