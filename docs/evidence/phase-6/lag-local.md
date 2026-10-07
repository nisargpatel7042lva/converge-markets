# Indexer lag (local)

- Endpoint `http://localhost:8080/v1/graphql`, 238 samples over 114s (every 500 ms), run at 2026-10-07T07:12:06.374Z
- **LOCAL**: indexer on this machine reading a local anvil chain through RPC (not HyperSync, not hosted).
- Blocks advanced while monitoring: 461; not-ready samples: 0; query errors: 0
- The first 4 samples are excluded from the verdict (monitor/load start-up transient); their worst lag was 1 blocks (all samples are in the JSON).
- Lag = sourceBlock - progressBlock (the indexer's own view of the head, not independent): max 0, p95 0, mean 0.00
- Lag vs the chain head read from RPC (independent): max **1**, p95 1, p50 0
- Threshold: max lag < 5 blocks (independent chain head): **PASS**
