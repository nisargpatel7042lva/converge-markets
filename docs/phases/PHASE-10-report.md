# Phase 10 report: package Converge for the judges and for first users

**Status: COMPLETE WITH CAVEATS.** Every deliverable exists, every figure in the public documents traces to a ledger row (checked by a script), the fresh-clone test passes after one documentation fix, and `make check-all` passes. The caveats are real and are in the documents themselves: it is testnet only, testnet uptime is 3.6%, the demo video, the Kizzy post-mortem link and the raise amount are Nisarg's to supply, and nothing about this phase makes the product audited or on mainnet.

## What was built

- **`README.md`**: the problem, the solution (with the failed first backtest told first), why Monad with the cost table and the method shown, a "Not a new format" section on Polymarket, a mermaid architecture diagram, live links (app, stats, contracts on the explorer), how to run locally, security status, team.
- **`docs/submission.md`**: track, one-liner, description, links, and for each of Kuru, Chainlink CRE, Mera and Envio: what we built, why it matters, file-and-line links, transactions, and a "gaps, stated plainly" paragraph.
- **`docs/demo-script.md`**: the 3-minute script with shot list, on-screen text and voiceover; **`scripts/docs/check-demo-script.mjs`** counts it (317 words, 127 s at 150 wpm).
- **`docs/pitch-outline.md`**: 10 slides with speaker notes, including competition and a table of where a skeptical investor will push.
- **`docs/launch/x-thread.md`** (10 posts, each at most 280 characters, **`scripts/docs/check-thread.mjs`**) and **`docs/launch/outreach.md`** (three DM templates and a tracking table).
- **`docs/numbers.md`**: the ledger (44 rows, each with a value, a source and a type), and **`scripts/docs/check-numbers.mjs`**, which fails if a dollar figure or percentage in the five public documents is not in the ledger.
- **`scripts/docs/check-links.mjs`**: every repo path and line anchor exists, every transaction exists on Monad testnet, every contract address has code, external links answer.
- **Stats page for judges** (`apps/web/src/app/stats/page.tsx`, `apps/web/src/app/api/stats/route.ts`): all-time volume, money in the vault, rounds settled, return since launch, uptime by 15-minute slot, how rounds ended. It reads the chain with no indexer; volume comes from a resumable log scan (`services/keeper/scripts/stats-volume.ts`, snapshot in `apps/web/src/config/stats-snapshot.json`) topped up live.
- **Evidence** in `docs/evidence/phase-10/`: `cost-comparison.{md,json}` (script `scripts/numbers/cost-comparison.mjs`), `chain-facts.md` (`scripts/numbers/chain-facts.mjs`), `live-params.md`, `stats-reading.json`, `e2e.txt`, `indexer-tests.txt`, `check-all.md`, `fresh-clone.md`, `hostile-review.md`.
- **Make targets**: `make check-docs-10` (a fast documents gate) and `make check-10` (= `check-all` + documents + files present).

## How to verify it yourself

```bash
git clone https://github.com/nisargpatel7042lva/converge-markets.git && cd converge-markets
pnpm install --frozen-lockfile
(cd contracts && forge build)
make check-docs-10          # about 10 s; ends with the link check
export PATH=$HOME/.foundry/bin:$HOME/.local/bin:$PATH
make check-10               # about 8 min; last line "check-10 OK"
node scripts/numbers/cost-comparison.mjs    # refreshes the live cost inputs
```

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Every number in the README, submission, pitch and thread traces to `docs/evidence/` or a live link, with a ledger `docs/numbers.md` | **PASS.** 44 ledger rows; `check-numbers.mjs` finds 0 figures outside the ledger. One citation (Kizzy) is deliberately **unsourced and flagged** (N0) instead of invented. | `docs/numbers.md`; `scripts/docs/check-numbers.mjs` output in `make check-docs-10` |
| 2 | Fresh-clone test passes, log saved | **PASS after one fix.** A real GitHub clone: install, `check-docs-10`, the demo stack up in 48 s, pages and `/api/stats` answering, and the clone's 10 end-to-end tests pass. The first run failed (the README never said to run `forge build`); fixed in `15456cf`. | `docs/evidence/phase-10/fresh-clone.md` |
| 3 | The submission covers the track and all 4 bounties, code links resolve | **PASS.** 99 links checked, including 3 transactions and 8 contracts on chain, 0 failures; 2 external links answer 451/403 to automated checks (reachable by people). | `docs/submission.md`; `scripts/docs/check-links.mjs` |
| 4 | The demo script fits 3:00 at 150 wpm | **PASS.** 317 words = 127 s; each of 6 segments is within its word budget. | `scripts/docs/check-demo-script.mjs` |
| 5 | Hostile review (a VC persona) has no open CRITICAL or HIGH; weak points are addressed in the pitch | **PASS for Phase 10 findings** (1 CRITICAL and 4 HIGH found and fixed; 7 MEDIUM and 1 LOW listed). The one HIGH inherited from Phase 9 (Data Streams never ran on a real report) stays open by nature, is in the README and the ask. | `docs/evidence/phase-10/hostile-review.md`; pitch slide 6 and the table at its end |

## Test summary

- `make check-all`: lint, format, typecheck and all unit tests pass (strategy 102, SDK 97, indexer 100, mainnet tooling 55, web 21, partner demo 9, reconcile 9, Kuru 9, backtest 45, and more), **412 contract tests pass, 0 fail, 2 skipped** (fork tests without an RPC), forge lint and Slither clean at medium and high (113 informational results). `docs/evidence/phase-10/check-all.md`.
- End to end: **10 of 10** Playwright tests passed in the working tree and again in the fresh clone on 2026-10-11 early on. Later that day, in full single-worker runs, the settlement test failed in about half of the runs and passed alone 3 of 3 (see the addendum), so a full run shows 9 or 10 passing. `docs/evidence/phase-10/e2e.txt`, `fresh-clone.md`.
- One honest note: earlier in the phase a full end-to-end run showed 2 failures. One was a real bug I had introduced (the stats route used a multicall that a local chain lacks); the other (settlement) is an order-dependent flake that passes alone and passed in the final runs.

## Hostile review

Found and fixed: a claim contradicted by its own log (CRITICAL); three places that presented simulated or partial integrations as fully live, the missing answer to Polymarket, a stats number that flattered reliability (46% against a real 3.6% uptime), and a cost comparison that could be read as "cheaper than every chain" (HIGH). Open: the Kizzy link, the demo video, the raise amount, the public app's older build, the keeper's price-health flicker (all MEDIUM, all in "Needs from Nisarg" or "Known issues").

## Deviations from the spec

1. **"Show the book updating per block" (demo, 1:00).** The Kuru lister re-quotes when fair value moves 6 cents or after 4 minutes, never faster than every 30 s, because that is what the measured cost and benefit support (ADR-004 removed per-block re-quoting). The script shows the book updating as fair value moves and says so; it does not claim per-block updates.
2. **"Cost per re-quote".** The product's recurring cost is a volatility refresh and a trade execution, not a per-block re-quote. The README reports the measured refresh and execution costs and the Kuru re-quote separately.
3. **"Vault APY since launch".** The stats page shows the return since launch (+1.19% over 2.6 days) and hides the annualised figure until there are seven days of history, because annualising days of play-money results would mislead.
4. **"Uptime".** Defined as normally settled rounds over 15-minute slots since the first round: 19 of 535 (3.6%).
5. **"All-time volume"** covers the current venue only (the vault v5 deployment), from its deploy block.
6. **Kizzy's post-mortem** is not linked: it could not be found. **"Team"** is one person.
7. **Mera, CRE, Kuru, Envio status wording** in the submission is deliberately conservative: CRE simulated, not deployed; Kuru run for one live round; Envio local, hosting in progress.
8. **Market size** cites the figures we could open (The Block; CertiK via Decrypt) and states we have no figure for short crypto markets.

## Known issues and risks

- **Testnet uptime is 3.6%.** The scheduler is a script on one laptop funded from one wallet; it stops when the machine sleeps or the wallet empties. A sweep now closes out stranded rounds. A long run on a funded host has not been done.
- **The keeper's price-health flicker is fixed** (see the addendum); the fix needs a long soak on a funded host to be called settled, and the keeper must run as a single process (a duplicate keeper on one wallet burned gas during the investigation).
- **The vault's +1.19% is not performance**: a few days, play money, mostly my own test bets. The NAV includes a 3,000 test-USDC deposit I made.
- **No users, a mock oracle with a test signer on testnet, no external audit**, and the Chainlink Data Streams path has never run on a real report.
- **The public Vercel app is an older build** than `main` and answers HTTP 451 in some regions by design; the stats link there shows that older page.
- **The public testnet RPC rate-limits (HTTP 429)** under bursts; the stats route retries, and a long volume scan competes with the keeper for the same quota.
- **Block time is 0.302 s on Monad**, not the 400 ms in our early notes (CLAUDE.md); that file is protected and was not edited.
- **Lighthouse scores** in the documents are from the Phase 7 build, before the later redesign.

## Needs from Nisarg

1. **The link to Kizzy's post-mortem on empty pools** (README and ledger N0), or confirmation to drop the reference.
2. **Record the demo video** with `docs/demo-script.md`, and add its URL to `docs/submission.md` and `docs/launch/x-thread.md`.
3. **The raise amount and any ask beyond the four unlocks** (pitch slide 10).
4. **Redeploy the public app?** It is an older build; this needs your decision.
5. **Envio Cloud**: tell me the hosted endpoint when the build finishes, so the stats page and the submission can say "hosted".
6. **CRE Early Access**: run `cre account access` in your own terminal (my attempt could not be confirmed).
7. ~~Approve the keeper debounce~~ Done: the flicker was fixed with a per-source freshness window, not a debounce (addendum). Nothing needed from you.
8. **Fund and keep the testnet stack running** before recording (about 1 MON per hour for the scheduler; the machine must not sleep), then refresh `docs/evidence/phase-10/stats-reading.json` and the ledger rows N39 to N41.
9. **Confirm the "team" line** (one person) and the voice of the thread.

## Readiness for the next step

**Yes, for submission, once items 1 to 3 are done.** Phase 10 is the last phase in `docs/STATUS.md`. What remains is recording the video, posting, and the owner decisions above. Mainnet is not a Phase 10 outcome and remains blocked on the items in the Phase 9 report.

## Addendum, 2026-10-11 (afternoon): the keeper flicker and the final sponsor-track checks

You asked for the price-health flicker to be fixed and for every sponsor track to be checked end to end. Full matrix: [docs/evidence/phase-10/sponsor-final-checks.md](../evidence/phase-10/sponsor-final-checks.md).

**The flicker is fixed, and it was not a bug to debounce.** Measured with three listeners side by side, Binance's `bookTicker` goes quiet for 2.5 to 3.3 s at a time (identically on a direct connection and through the relay) and the keeper's 3 s freshness limit read that as a dead feed. A per-source limit of 8 s for Binance (under the 10 s socket watchdog) fixes it without loosening any check; a test reads the shipped configs. About 50 minutes on testnet afterwards: 0 quote pulls, 0 risk events, against roughly one pull a minute before. [Root cause](../evidence/phase-10/price-feed-flicker.md).

**Five real defects found by running things live, all fixed:** the flicker; the faucet returning HTTP 500 for every new account (two back-to-back transactions are rejected by the public RPC); Kuru's `bestBidAsk()` price scale changing between market implementations (the app would have shown 4,480 for a 0.448 bid); the stats endpoint taking 12 s cold (now 21 ms warm, warmed at boot); and my own restart leaving two keepers running. Also found and fixed: a startup warm-up that disturbed the first end-to-end test (now opt-in), and `deployments/kuru-testnet.json` breaking `make check-all`'s format check (now in `.prettierignore`).

**Per track.** Kuru: lister re-run live (the new re-quote policy posted 3 quotes in 7 minutes against 18 in 11 minutes); the app's market lookup matches both live markets. Chainlink CRE: re-simulated against live testnet, same WASM hash, plan shrank from 8 actions to 1 once the stranded rounds were cleaned. Mera: a passkey account was created on the live testnet app and funded by the faucet (verified on chain). Envio: indexed a 7,600-block window of real data; volumes equal the keeper's logged premiums, 6 of 6 invariants pass, 27 of 29 sampled entities match (the tool's verdict is FAIL: too few samples, and the 2 mismatches are the pre-window first LP deposit); the stats and Earn pages query it.

**Blocked on gas, not claimed.** The deployer and keeper wallets are nearly empty (under 0.2 MON between them). So: a bet from the new passkey account on a live round (the test exists in `apps/web/e2e-testnet/`), the Kuru round's teardown and a fresh taker fill, and a CRE broadcast write. The scheduler costs about 0.1 MON per round and each faucet account 0.1 MON; funding for the live checks is about 3 to 5 MON.

**Still open.** The settlement end-to-end test is order-dependent flaky in a full single-worker run (failed in about half of today's full runs, passed alone 3 of 3, and also failed in the first full run today before any keeper change). I did not weaken it. CRE Early Access and the Envio Cloud deployment remain the owner's steps.
