# Reconciliation: indexer vs chain (testnet-window)

- Run at 2026-10-11T06:32:23.731Z; indexer `http://localhost:8081/v1/graphql`; chain 10143 via `https://rpc-testnet.monadinfra.com`

- Each entity is fetched with `_meta.progressBlock` in one request and the chain is read at that block. Mismatches are re-fetched up to 3 times.
- Population 29 entities; requested 60; **sampled 29**; **matched 27**; mismatched 2; field comparisons 235; seed 1
- Result: **93.10% matching: FAIL** (fewer than 60 entities sampled)

| entity | sampled | matched |
|---|---|---|
| Market | 5 | 5 |
| UserPosition | 3 | 3 |
| Trade | 3 | 3 |
| NavSnapshotSettlement | 1 | 1 |
| NavSnapshot | 5 | 5 |
| LPPosition | 1 | 0 |
| VaultEpoch | 1 | 1 |
| Order | 9 | 9 |
| Vault | 1 | 0 |

## Indexer-internal invariants (GraphQL only)

- PASS: per market: sum of holder balances (incl. vault and venue) == token total supply (5 markets, 0 violations)
- PASS: no negative balance, escrow or cost (6 positions, 0 violations)
- PASS: costBasis == upCost + downCost (0 violations)
- PASS: sum of LP wallet shares <= vault share supply (701032 <= 2981773114)
- PASS: protocol totals == sum over markets == vault fill totals (trades 3/3, volume 15616119/15616119)
- PASS: Vault apy7d / apy30d / apySinceInception == recomputed from the NavSnapshot rows (6 snapshots; indexer apy7d null, apy30d null; recomputed undefined, undefined)

## Mismatches
- LPPosition `0xe36848e8654a86fd2f7f97ddb3c56042ffd54dd1` (block 69793600):
  - shares: indexer 701032, chain 1000700032
- Vault `0x5dd05ffd80f8959abd25c82a57f5bd106c27b082` (block 69793600):
  - totalSupply: indexer 2981773114, chain 3981773114
  - venue: indexer null, chain 0xb23836fce92ef669ebef742f685ec960ff7630d9
