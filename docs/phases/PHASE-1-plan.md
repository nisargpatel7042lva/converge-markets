# Phase 1 plan: Outcome market core contracts

## Orient: assumptions and inputs

- **ADR-002 overrides the prompt's round-proof default.** Resolution goes through `IPriceResolver`, which has two implementations:
  - `DataStreamsResolver`, primary. The verified v3 report whose window `[validFromTimestamp, observationsTimestamp]` contains T is canonical, with a fixed finalization window from the first proposal and a `keccak256(reportData)` tie-break.
  - `ChainlinkRoundResolver`, alternative and MON fallback. The first round with `updatedAt ≥ T` is proven by roundId: the previous round must be in the same phase with `updatedAt < T`.
- **`Market.open(bytes)` / `resolve(bytes)` replace `open(roundId)` / `resolve(roundId)`.** The bytes are forwarded to the resolver (an abi-encoded roundId or a signed report), and the resolver is permissionless. This is a deviation the prompt itself allows ("behind the same interface").
- **ADR-003:** USDC, 6 dp. Tests also cover 18 dp. Outcome-token decimals equal collateral decimals.
- **Boundary records:** one record P(asset, T) per resolver. A market's strike is P(start) and its settlement is P(end). Adjacent rounds share the boundary record, and a void voids both rounds touching T (ADR-002 §2, §4).
- **INVALID** pays 0.5 per UP and per DOWN token. Pause stops only creation and split. Merge and redeem are never pausable.
- **Testnet funding:** deployer `0xe368…4dd1` has 0 MON. The testnet lifecycle (AC5) is scripted and proven on a local anvil, and is BLOCKED on funds unless MON arrives.
- **Testnet resolver:** testnet push feeds have a 24h heartbeat and there is no testnet Data Streams verifier. The testnet lifecycle therefore uses a `MockStreamsVerifierProxy` (test signer), which is clearly labelled.

## Tasks → acceptance criteria

| # | Task | AC |
|---|---|---|
| 1 | Interfaces: `IPriceResolver`, `IAggregatorV3` (standard Chainlink), `IVerifierProxy` (from Chainlink docs) | 1, 6 |
| 2 | `OutcomeToken` (clone, market-only mint/burn, collateral decimals, human name/symbol) | 1, 2 |
| 3 | `Series` lib (aligned 15m/1h UTC boundaries) + `DateTimeLib` for names | 1, 2 |
| 4 | `ChainlinkRoundResolver` (first-round proof, phase check, maxOracleDelay, liveness fallback) | 1, 2, 6 |
| 5 | `DataStreamsResolver` (verify via proxy, window containment, fixed finalization window, hash tie-break, grace → UNRESOLVABLE; no push sanity bound per ADR-002 §5) | 1, 2, 6 |
| 6 | `Market` (split, merge, open, resolve, invalidate, redeem, events, reentrancy guard, FoT rejection) | 1, 2 |
| 7 | `MarketFactory` (roles, registry, clones, pause, redeem fee ≤ 1%) | 1, 2 |
| 8 | Mocks: aggregator with phases/gaps/stale data, verifier proxy, 6/18 dp ERC-20 | 1 |
| 9 | Unit tests for every function and revert; fuzz split/merge; handler invariants (≥256 runs, depth ≥100) | 1, 2, 3 |
| 10 | `forge snapshot` committed; coverage ≥95% on Market, Factory, Token | 2 |
| 11 | Static analysis: slither (or aderyn), triage → `docs/security/phase-1-static-analysis.md` | 4 |
| 12 | Deploy script → `deployments/testnet.json`; lifecycle script → `docs/evidence/phase-1/lifecycle.md` | 5 |
| 13 | `docs/security/phase-1-notes.md` (trust assumptions, pause/exit) | 6 |
| 14 | `make check-1`, evaluation loop, hostile review, report | 1–7 |
