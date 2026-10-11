# Hostile review: a venture investor reading the Phase 10 materials

A separate, adversarial pass over `README.md`, `docs/submission.md`, `docs/demo-script.md`, `docs/pitch-outline.md`, `docs/launch/` and the stats page, as an investor who asks "why would I fund this, what is fake, what is weak". It was done by the same author after a break from writing, not by an independent reviewer. Severities: CRITICAL = a claim contradicted by its own evidence; HIGH = an overclaim or a missing answer a judge will find in minutes.

## Findings and what was done

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | CRITICAL | The submission said "all 10 end-to-end tests pass" and linked a log that showed **8 passed, 2 failed** (saved before a fix). | **Fixed.** The stats route used a multicall that does not exist on a local chain; fixed. Log regenerated from a clean run: `docs/evidence/phase-10/e2e.txt`, **10 passed**. |
| 2 | HIGH | README, submission description, thread and demo script said rounds *are* created by a Chainlink CRE workflow, every round's UP token *is* on Kuru, and an indexer *serves* history. Reality: the CRE workflow is simulated, not deployed; Kuru was run for one round; the indexer runs locally. | **Fixed.** Each statement now says what is true (CRE simulated, a TypeScript scheduler runs testnet; Kuru run for one live round; indexer local, hosting in progress). |
| 3 | HIGH | No answer to "Polymarket already runs 15-minute up/down markets." | **Fixed.** README section "Not a new format", pitch slide 8, ledger N43, sourced to Crypto Briefing (2026-09-28). The pitch says we have no users and the open question is whether a pooled vault beats professional market makers. |
| 4 | HIGH | The stats page counted only rounds that were *created*, which made reliability look like 46% when only **19 of 535 fifteen-minute slots (3.6%)** had a normally settled round. | **Fixed.** The page and API now report slot-based uptime and the number of slots that never got a round; the pitch leads with 3.6%. |
| 5 | HIGH | "About 57 times cheaper" could be read as cheaper than every other chain. Layer-2s are far cheaper than Ethereum mainnet and were not compared. | **Fixed.** README method point 3 and the pitch notes say mainnet only and never "cheaper than other chains". |
| 6 | MEDIUM | The Kizzy post-mortem named in our own notes could not be found, and the prompt asks for it to be linked. | **Handled, not closed.** Not cited as fact; flagged as unverified (ledger N0) and in README. **Needs Nisarg: the link.** |
| 7 | MEDIUM | The backtest's forward-priced edge excludes keeper gas, Data Streams fees and failed executions. | Stated in ledger N17 and on pitch slide 7, with the measured gas costs beside it. |
| 8 | MEDIUM | The vault's +1.19% is mostly my own test deposit and bets on play money; Lighthouse scores are from an older build. | Both labelled in the ledger (N39, N28) and pitch notes ("not performance"). |
| 9 | MEDIUM | The pitch had no spoken answer for "Passkeys remove the wallet barrier." | Marked "our thesis, not a measured result". |
| 10 | MEDIUM | The public Vercel app is an older build and returns HTTP 451 in some regions (by design). | Stated in README. **Open: Nisarg decides on a redeploy.** |
| 11 | MEDIUM | No demo video exists; the raise amount is not set. | Placeholders are explicit (`submission.md`, `x-thread.md`, pitch slide 10). **Open: Nisarg.** |
| 12 | MEDIUM | The keeper flickered into a one-second "price unhealthy" halt that pulled quotes for about 15 s, so a live demo could show "Prices are temporarily pulled". | **Fixed later the same day.** Root cause: Binance's book ticker goes quiet for up to 3.3 s and the keeper's 3 s freshness limit read that as a dead feed. A per-source window of 8 s for Binance fixes it without loosening a check; see `docs/evidence/phase-10/price-feed-flicker.md`. |
| 13 | LOW | Two sources could not be opened (Gambling Insider 403, CertiK's own report). | Not cited; the CertiK figure is attributed to Decrypt as secondary reporting. |

## Inherited from Phase 9 (not a Phase 10 finding)

The Chainlink Data Streams path has never run on a real report (no credentials). That HIGH stays open by nature; it is in the README's security status, on pitch slide 9 and in the ask.

## Verdict

No open CRITICAL or HIGH finding from this review. The weak points a VC would press (52% then 3.6% uptime, a copyable format, no users, a mock oracle, no audit, edge assumptions) are in the pitch itself, on the slide where they arise, not only in this file.
