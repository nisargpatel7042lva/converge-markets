# Phase 1 static analysis

Tools: slither 0.11.6 (`contracts/slither.config.json`, fails on medium or higher) and `forge lint --deny warnings` (forge 1.8.4). Full output: `docs/evidence/phase-1/slither.txt`.

**Result: 0 HIGH, 0 MEDIUM unresolved** (re-run after the review fixes). 14 LOW/Informational remain, all reviewed.

## MEDIUM findings
Each was either fixed or suppressed inline with a written reason.

| Detector | Location | Disposition |
|---|---|---|
| reentrancy-no-eth | `DataStreamsResolver.submit` | **Fixed**: added `nonReentrant`. The call target is the immutable Chainlink VerifierProxy. |
| uninitialized-local | `Market.invalidate` boundary | **Fixed**: now initialized explicitly. |
| reentrancy-no-eth | `Market.open` / `resolve` | False positive. Both are `nonReentrant`, the resolver is admin-fixed and immutable per market, and state is re-read from the resolver after the call. |
| divide-before-multiply | `Market.redeem` fee; `MarketNaming.toDateTime` | False positive. The halving is the INVALID payout itself. Calendar integer division is the algorithm, and is tested against date vectors. |
| incorrect-equality | `Market.redeem` zero checks | False positive. These are intended exact-zero checks on our own balances. |
| uninitialized-local | `MarketFactory.createMarket` `p` | False positive. Every field is assigned. |
| unused-return | resolver `priceAt` / `_round` / `submit`; `Market.invalidate` | False positive. Only the needed fields are used. |
| reentrancy-eth (**HIGH**), added after the fee-forwarding fix | `Market.open` / `resolve`, `DataStreamsResolver.submit` | False positive. All are `nonReentrant` (slither does not model the guard); `msg.value` goes only to the market's immutable resolver and from it to Chainlink's verifier; no other function can be re-entered. |
| locked-ether | `ChainlinkRoundResolver` | False positive. `submit` is payable only to match the interface and reverts on any value (`NoValueAccepted`, tested). |
| arbitrary-send-eth / low-level-calls (forge lint + slither informational) | `DataStreamsResolver.withdrawNative`, `Market._boundaryPrice` | Owner-only refund recovery; value forwarded only to the fixed resolver. |

## LOW / Informational findings
All accepted.

| Detector | Reason |
|---|---|
| `timestamp` | Rounds are wall-clock by design. Windows are on the scale of minutes. |
| `reentrancy-benign` / `reentrancy-events` | Calls only go to our own clones or trusted resolvers. Everything is behind `nonReentrant`. |
| `missing-zero-check` on `setFeeRecipient` | Zero intentionally disables fees. |
| `events-maths` on `Market.initialize` | The factory's `MarketCreated` emits the full params struct. |
| `unindexed-event-address` | Cosmetic. |
