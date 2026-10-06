# Phase 6 plan: the Envio indexer

Goal (prompt): one source of truth for all read-side data (positions, market lists, vault NAV/APY, public stats), fast enough for live UI and verifiably consistent with the chain.

## Orientation (what exists, what that means)

- Phase 4 replaced keeper-posted quotes with the vault + forward venue (ADR-004/005). **There is no Kuru adapter and no pm-AMM pool contract in this repo**, and the Kuru leg is blocked (EXTERNAL.md). The spec's "KuruAdapter/PmAmmPool" handlers therefore have nothing to index. The trade source is `ConvergeVault.Fill` (one event per ladder level, carries market, side, size, premium, taker) joined with `ForwardVenue` order events. A Kuru `Trade` handler is kept as an inert, documented stub only if Envio's config accepts a contract without addresses cleanly (decided in T1, result recorded in the report). No Kuru or pm-AMM contract is invented.
- Deployed contracts to index (`deployments/testnet.json`, chain 10143): `marketFactory` (deploy block 68426048), `vault.vault` v3 `0xcd20...0748` and `vault.forwardVenue` `0xDf59...98Aa` (deploy block 68615979). Markets, `OutcomeToken`s are discovered through `contractRegister` on `MarketCreated`. `vault_v1_pre_audit` is superseded and not indexed.
- Phase 5 (keeper) runs in parallel and may redeploy the vault (halt flag, ADR-006). Config is therefore **generated from `deployments/*.json`** (`indexer/scripts/gen-config.mjs`, `--check` in `make check-6`), so a redeploy is one command.
- **The ENVIO_API_TOKEN is not available** and the live testnet RPC must not be touched. Envio docs (EXTERNAL.md Phase 6 rows): a token is only needed when HyperSync is the data source; with `rpc:` as the source of a chain no token is needed and `createTestIndexer().process({simulate})` needs no network. So: handlers, schema, math, SDK and tooling are built and unit-tested here; the **local** run uses `rpc:` against a local anvil chain (labelled LOCAL, not hosted, not HyperSync); everything that needs the token or Envio Cloud is BLOCKED with exactly what is needed.

## Assumptions

1. Envio HyperIndex v3.14.0 (npm `latest` on 2026-10-06). v3 API differs from v2 (`indexer.onEvent`, `chains:`, `context.chain.X.add`, `createTestIndexer`): everything is taken from docs.envio.dev v3 pages, never from memory.
2. Events are declared by human-readable signature in `config.yaml` (docs: recommended). A test cross-checks every declared signature's topic0 against the contract ABIs.
3. Money is integer collateral units (6 dp, USDC); prices are BigDecimal; shares and NAV per share are WAD (18 dp).
4. Cost basis is average cost. UP+DOWN pairs from `split` are costed 50/50. Tokens that move between two ordinary wallets carry their proportional cost. Tokens received with no economic event carry zero cost. Tokens held in an open ForwardVenue sell order still count as the seller's holdings (escrow).
5. APY = compound annualisation of the lower price per share over the actual elapsed time between two NavSnapshots (the baseline is the last snapshot at or before `now - window`), reported only when the history covers at least the window; the lower NAV carries the 5-point mark band so short windows are noisy (stated in QUERIES.md).

## Tasks and the acceptance criteria they serve

| # | Task | AC |
|---|---|---|
| T1 | `indexer/` scaffold: `config.yaml` (generated from deployments), `schema.graphql`, codegen green; Kuru stub decision | 1 |
| T2 | Pure libs with unit tests: cost-basis / PnL, APY, ids, day buckets | 1 |
| T3 | Handlers: factory (+ contractRegister), Market, OutcomeToken, ConvergeVault (requests, epochs, NAV, shares, fills, flags), ForwardVenue; mock-event tests with `createTestIndexer` incl. a full-lifecycle scenario | 1 |
| T4 | `packages/sdk/src/indexer.ts`: typed query helpers, response parsing, APY/PnL helpers + tests; `indexer/QUERIES.md` | 1 |
| T5 | `scripts/reconcile`: reconcile (random sample, pinned block, indexer vs RPC), latency harness (p50/p95/p99 of the app's main queries), lag monitor (`_meta`), all runnable the moment a token / endpoint exists | 3, 4, 5 |
| T6 | LOCAL evidence: anvil + deploy stack + scripted activity + `envio` with `rpc:` source + Postgres/Hasura (docker): backfill time, reconcile >= 200 entities, p95 latency, lag | 2, 3, 4, 5 (local) |
| T7 | Hosted: testnet config + mainnet config prepared (generated from `deployments/mainnet.json`, which does not exist yet), deployment runbook | 2, 5 |
| T8 | `make check-6`, evidence, hostile review (subagent), fixes, report, STATUS | 6 |

## Acceptance criteria and how each is met (or why it is blocked)

1. `make check-6`: codegen + handler tests with mock events + SDK tests + ABI parity + config freshness. Runnable here.
2. Full backfill from the deploy block with time recorded: **hosted/HyperSync = BLOCKED (no token, and the public RPC is reserved)**; a LOCAL backfill (anvil, `rpc:` source) is run and labelled local.
3. Reconciliation >= 200 entities, 100% matching: LOCAL run here; the same script against testnet is pending the token and a free RPC budget.
4. p95 < 300 ms: LOCAL measurement (Hasura on this machine) labelled local; hosted measurement BLOCKED.
5. Lag < 5 blocks during the keeper's live run: BLOCKED (needs the hosted indexer, which needs the token and the GitHub deploy); the lag monitor is ready and a LOCAL lag run is recorded.
6. No open CRITICAL/HIGH in the hostile review.
