# Phase 6 evidence

All of it is a **local indexer** (Envio HyperIndex 3.14.0 with an RPC data source, Postgres and Hasura in Docker). Nothing was measured against the hosted Envio service or HyperSync (blocked: no `ENVIO_API_TOKEN`).

| Files | What they are |
|---|---|
| `check-6.txt` | `make check-6` output. |
| `*-local.*` | LOCAL anvil chain (31337), mock prices, scripted history (30 markets, 786 transactions): backfill, reconcile (201 of 516 entities, two seeds), latency, lag. The lag file measures the independent chain head (max 1 block). |
| `backfill-testnet-rpc.*`, `reconcile-testnet-rpc.*`, `latency-testnet-rpc-local-hasura.*`, `rpc-usage-testnet.json`, `latency-testnet-rpc.txt`, `reconcile-testnet-rpc.txt` | REAL Monad testnet data, blocks 68,644,575 to 68,726,000 (vault v3 deploy to the end of the Phase 5 keeper run), a LOCAL indexer behind a rate-limited proxy (10 rps ceiling, request volume in `rpc-usage-testnet.json`). The factory's own deploy block was skipped to bound the run. Only 26 entities exist on testnet, all were checked. |
| `window-*` | An earlier bounded run (blocks 68,718,000 to 68,726,000). Its reconcile has one FAIL (`Vault.venue` is null: the event that sets it is before the window). Kept to show the window artefact, not a defect of the full run. |
| `local-event-counts.txt` | Events processed by handler. |

What the reconcile compares with the chain, and what it does not, is stated in `docs/phases/PHASE-6-report.md` (criterion 3).
