# Reconciliation: indexer vs chain (testnet-rpc)

- Run at 2026-10-07T06:47:55.681Z; indexer `http://localhost:8080/v1/graphql`; chain 10143 via `http://127.0.0.1:8612`

- Each entity is fetched with `_meta.progressBlock` in one request and the chain is read at that block. Mismatches are re-fetched up to 3 times.
- Population 26 entities; requested 250; **sampled 27**; **matched 27**; mismatched 0; field comparisons 216; seed 1
- Result: **100.00% matching: PASS**

| entity | sampled | matched |
|---|---|---|
| Market | 6 | 6 |
| UserPosition | 4 | 4 |
| Trade | 4 | 4 |
| NavSnapshotSettlement | 1 | 1 |
| NavSnapshot | 3 | 3 |
| LPPosition | 1 | 1 |
| VaultEpoch | 2 | 2 |
| Order | 4 | 4 |
| Vault | 1 | 1 |
| ProtocolStats | 1 | 1 |

## Indexer-internal invariants (GraphQL only)

- PASS: per market: sum of holder balances (incl. vault and venue) == token total supply (6 markets, 0 violations)
- PASS: no negative balance, escrow or cost (4 positions, 0 violations)
- PASS: costBasis == upCost + downCost (0 violations)
- PASS: sum of LP wallet shares <= vault share supply (0 <= 1000000000)
- PASS: protocol totals == sum over markets == vault fill totals (trades 4/4, volume 4290000/4290000)
- PASS: Vault apy7d / apy30d / apySinceInception == recomputed from the NavSnapshot rows (4 snapshots; indexer apy7d null, apy30d null; recomputed undefined, undefined)


