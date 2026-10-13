# Demo video (no captions, no audio)

Real footage only. Two parts, joined with a short crossfade (about 2:22 in all).

1. **The product, end to end** (`record-journey.mjs`): the real app, contracts, keeper and scheduler on the local demo stack
   (`DEMO_END=up bash .demo/start.sh`). Passkey account, test money, a live round, a bet and its fill, a time-lapse of the chain
   clock to settlement, collecting the winnings, the vault's deposit flow, and the live stats. Recorded at about 40 fps through the
   browser's screencast with a smooth in-page cursor, and written at 30 fps. The price on this chain is synthetic (flat, with a small
   random end) and `DEMO_END=up` makes the round end above its start so the walkthrough can show a winning bet.
2. **Under the hood on the live Monad testnet deployment** (`terminal.html`, `render-terminal.mjs`): real command output replayed at an
   even pace: the CRE workflow simulation reading the live factory, the receipt of the CRE broadcast, the vault's three enabled assets,
   the scheduler's and Kuru lister's logs, and the test summaries. The output text is not edited (a `grep` is shown where a log is filtered).

Build: `node record-journey.mjs` (stack running), `node render-terminal.mjs`, then join `work/journey.mp4` and `work/terminal.mp4` with
an `xfade` of 0.8 s. The renderers need Playwright's Chromium (`LD_LIBRARY_PATH` as in docs/ops/local-demo.md) and an `ffmpeg` binary.
