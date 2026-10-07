# ADR-006: The keeper and the vault's halt switch

- Status: **Accepted** (Phase 5)
- Date: 2026-10-06
- Builds on: ADR-004 (forward-priced execution), ADR-005 (vault)

## Context

Phase 5 asks for a keeper that "pulls quotes instantly" on price shocks, source divergence, RPC errors or inventory above a cap, and "recovers without manual action". In the Phase 4 vault the only way to stop fills is `pauseQuoting`, which only the guardian or the owner may call and only the **owner may clear**. A keeper that had to wait for the owner to resume could not recover by itself; a keeper holding the guardian key could pause but still not resume.

## Decision

1. Add `keeperHalt` to `ConvergeVault`: `haltQuoting(bytes32 reason)` and `unhaltQuoting()`, both **keeper-only**, independent of `quotingPaused`.
2. Fills (`venueView`, `venueFill`) require `!quotingPaused && !keeperHalt`. Splitting, merging, settlement, claims and every exit are unaffected by the halt.
3. The keeper can never clear the guardian pause or the breaker; the owner can never be overridden by it. A compromised keeper gains nothing it did not have: it could already set sigma, and halting only stops quoting (a denial of quotes, visible and reversible by rotating the keeper, which is an owner action).
4. The keeper's pull-all is: send `haltQuoting`, stop executing orders. It resumes by calling `unhaltQuoting` after the sources have been healthy for a hysteresis period.

## Consequences

- One more flag in the vault (40.2 KB, Monad limit 128 KB), 3 unit tests, 2 invariant handlers (a legitimate toggle and a non-keeper attack), threat model rows.
- Orders priced while halted are refunded to takers (the executor still gets the reward); nothing is stuck.
- The halt is a transaction: pull-all latency is detection time plus inclusion time (one or two Monad blocks). Between detection and inclusion a taker's order priced at a bad second can still be executed by anyone; the vault's loss ceilings and the breaker bound that, as in Phase 4.

## Alternatives rejected

- Keeper holds the guardian key: can pause but can not resume, so recovery would be manual.
- Letting the guardian role resume: would let a pause-only key override the owner's pause and the breaker.
- Stale sigma as the pull mechanism: takes up to 15 minutes.

## Addendum (2026-10-06): what the testnet and the review changed

Findings from running the keeper against Monad testnet and from the hostile review. Each is fixed
in code and covered by a test unless noted.

1. **The public RPC allows 15 calls a second per IP** (`requests limited to 15/sec`), not the 50 the
   docs row said. The keeper batches reads with Multicall3, caps itself at 10 calls a second in a
   bulk lane and has a separate urgent lane (submission, receipts, nonces) so a halt is never
   queued behind reads. A call that would wait over 2 s fails at once (`RateLimitedLocally`) and is
   not counted as an RPC failure.
2. **A halt must not queue behind anything.** With local nonces a stuck lower nonce blocks every
   later transaction, halts included. A halt now takes the lowest unconfirmed nonce and replaces
   what sits there (30 % over what was sent); a transaction that times out after its replacements is
   cancelled with a self-transfer. A halt is signed locally and sent raw (no node round trips).
3. **A kill and a halt must survive a restart.** `POST /kill` writes the kill file; the keeper never
   unhalts before the price has been healthy for `risk.warmupMs`, so a restart in the middle of a
   crash (empty price history, start-up grace) cannot put quotes back.
4. **A halt that fails is retried with a back-off and an alert** (it was once per block), and the
   wallet keeps a reserve (`reserveMon`): below it only halts are sent.
5. **A halt supersedes an unhalt in flight** (separate flags), and a halt/unhalt of ours that landed
   while a state read was in flight is not overwritten by that read.
6. **Coinbase's ticker is trade-driven** (gaps up to 7.4 s on ETH-USD): staleness is per source.
7. **Kill no longer blocks exits**: while killed the keeper adds no exposure but still settles,
   resolves, redeems, merges and expires.
8. **Quote age has a floor on Monad**: a transaction is included in 0.5 to 1.5 s, so the keeper's
   `executeOrder` lands 4 to 6 blocks after the order's second, and a pull-all about 1 s (2 to 4
   blocks) after detection. The 2-block targets of the prompt hold on anvil, not on Monad testnet.
   The venue's `maxLateness` of 4 s (10 blocks) leaves a margin of 4 to 6 blocks; if testnet shows
   misses, raise it (owner-set within the contract's limit of 10).
9. **No automatic pull when the keeper is dead.** Quotes stay live until sigma goes stale (15 min)
   or the guardian pauses; `KeeperDown` pages a human. A dead-man guardian (a second process or
   a Chainlink Automation job holding the guardian key and pausing when the keeper's heartbeat
   stops) is the mainnet answer and is not built.
