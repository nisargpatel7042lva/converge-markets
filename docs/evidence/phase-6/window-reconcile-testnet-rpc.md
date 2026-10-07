# Reconciliation: indexer vs chain (testnet-rpc)

- Run at 2026-10-07T05:30:39.201Z; indexer `http://localhost:8080/v1/graphql`; chain 10143 via `http://127.0.0.1:8612`

- Each entity is fetched with `_meta.progressBlock` in one request and the chain is read at that block. Mismatches are re-fetched up to 3 times.
- Population 23 entities; requested 250; **sampled 24**; **matched 23**; mismatched 1; field comparisons 181; seed 1
- Result: **95.83% matching: FAIL**

| entity | sampled | matched |
|---|---|---|
| Market | 4 | 4 |
| UserPosition | 4 | 4 |
| Trade | 4 | 4 |
| NavSnapshotSettlement | 1 | 1 |
| NavSnapshot | 3 | 3 |
| LPPosition | 1 | 1 |
| VaultEpoch | 1 | 1 |
| Order | 4 | 4 |
| Vault | 1 | 0 |
| ProtocolStats | 1 | 1 |

## Indexer-internal invariants (GraphQL only)

- PASS: per market: sum of holder balances (incl. vault and venue) == token total supply (4 markets, 0 violations)
- PASS: no negative balance, escrow or cost (4 positions, 0 violations)
- PASS: costBasis == upCost + downCost (0 violations)
- PASS: sum of LP wallet shares <= vault share supply (0 <= 1000000000)
- PASS: protocol totals == sum over markets == vault fill totals (trades 4/4, volume 4290000/4290000)
- PASS: Vault apy7d / apy30d / apySinceInception == recomputed from the NavSnapshot rows (4 snapshots; indexer apy7d null, apy30d null; recomputed undefined, undefined)

## Mismatches
- Vault `0xbeaf85d2682bad7ca09fd869037065350cf4a3b5` (block 68726000):
  - venue: indexer null, chain 0x28dbcf1631f51c9021d999b46e5d9439b4ed913c
