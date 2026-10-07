# Reconciliation: indexer vs chain (local-after-live)

- Run at 2026-10-07T07:12:18.992Z; indexer `http://localhost:8080/v1/graphql`; chain 31337 via `http://127.0.0.1:8611`

- Each entity is fetched with `_meta.progressBlock` in one request and the chain is read at that block. Mismatches are re-fetched up to 3 times.
- Population 521 entities; requested 200; **sampled 201**; **matched 201**; mismatched 0; field comparisons 1393; seed 2
- Result: **100.00% matching: PASS**

| entity | sampled | matched |
|---|---|---|
| Market | 30 | 30 |
| UserPosition | 68 | 68 |
| Trade | 36 | 36 |
| NavSnapshotSettlement | 7 | 7 |
| NavSnapshot | 12 | 12 |
| LPPosition | 3 | 3 |
| VaultEpoch | 8 | 8 |
| Order | 35 | 35 |
| Vault | 1 | 1 |
| ProtocolStats | 1 | 1 |

## Indexer-internal invariants (GraphQL only)

- PASS: per market: sum of holder balances (incl. vault and venue) == token total supply (30 markets, 0 violations)
- PASS: no negative balance, escrow or cost (148 positions, 0 violations)
- PASS: costBasis == upCost + downCost (0 violations)
- PASS: sum of LP wallet shares <= vault share supply (1157773452 <= 1157774453)
- PASS: protocol totals == sum over markets == vault fill totals (trades 131/131, volume 471489741/471489741)
- PASS: Vault apy7d / apy30d / apySinceInception == recomputed from the NavSnapshot rows (114 snapshots; indexer apy7d 0, apy30d 0; recomputed 0, 0)


