# Phase 10 plan: package Converge for the judges and for first users

Acceptance criteria (AC) from the phase prompt: **AC1** every number traces to `docs/evidence/` or a live link, with a ledger in `docs/numbers.md`; **AC2** a fresh-clone test passes, log saved; **AC3** the submission covers the track and all four bounties, code links resolve; **AC4** the demo script fits 3:00 at 150 wpm; **AC5** a hostile VC-judge review leaves no open CRITICAL or HIGH, and the weak points are addressed in the pitch.

## Orient: assumptions

1. There is no traction. Everything runs on Monad testnet with test money; no outside user has traded. Traction slides state exactly that, with the measured engineering numbers instead.
2. Kizzy's "post-mortem on empty pools" (CLAUDE.md) could not be found with web search on 2026-10-10. It is cited only as an unverified claim until Nisarg supplies the link (AC1 forbids an unverifiable citation).
3. The Phase 3 verdict is "unprofitable as specified, profitable under pessimistic assumptions only with forward pricing, and only against leads under the 2 s delay". The pitch leads with that, not around it.
4. The product does not re-quote every block (ADR-004 replaced that), so the "cost per re-quote" is the measured `setSigma` refresh, and the cost to serve a trade is the measured `executeOrder`. The Kuru lister's cancel-and-replace is a separate, also measured, number.
5. No demo video, no team beyond Nisarg, no partner conversations exist. None are invented.

## Tasks

| # | Task | AC |
|---|---|---|
| 1 | Cost comparison: measured Monad cost (Phase 5, Kuru) versus the same gas on Ethereum at live gas and ETH prices, method and inputs saved with timestamps (`scripts/numbers/cost-comparison.mjs`, `docs/evidence/phase-10/cost-comparison.md`) | 1 |
| 2 | Numbers ledger `docs/numbers.md`: claim, value, source, for every figure used in the documents below | 1 |
| 3 | `README.md` with problem, solution, why Monad (method shown), mermaid architecture, live links, local run, security status, team | 1, 2 |
| 4 | `docs/submission.md`: track, one-liner, description, demo link, repo, and per bounty (Kuru, Chainlink CRE, Mera, Envio) what was built, why it matters, file and tx links | 1, 3 |
| 5 | `docs/demo-script.md`: 3:00 script, shot list, on-screen text, voiceover; word count checked at 150 wpm | 4 |
| 6 | `docs/pitch-outline.md`: 10 slides with speaker notes; market size from cited sources | 1, 5 |
| 7 | `docs/launch/x-thread.md` (8-10 posts) and `docs/launch/outreach.md` (DM templates, tracking table) | 1 |
| 8 | Stats page for judges: all-time volume, TVL, rounds settled, return since launch, settlement reliability, from the chain with a resumable volume snapshot (`/api/stats`) | 1 |
| 9 | Link checker (`scripts/docs/check-links.mjs`): every repo path, line anchor and explorer link in the new documents resolves; word-count check for the demo script | 3, 4 |
| 10 | `make check-10`, `make check-all`, fresh-clone test following the README exactly, log in `docs/evidence/phase-10/fresh-clone.md` | 2 |
| 11 | Hostile review (VC judge persona, a separate clean pass), fix CRITICAL and HIGH | 5 |
| 12 | Phase report and STATUS update | all |
