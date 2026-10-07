# Indexer GraphQL latency (testnet-rpc-local-hasura)

- Endpoint: `http://localhost:8080/v1/graphql`, run at 2026-10-07T06:48:13.012Z
- 200 timed requests per query after 10 warm-up requests; sequential = one client, concurrent = 10 clients. Client-side round trip (fetch to parsed JSON).
- Dataset: {"Market":6,"Trade":4,"UserPosition":4,"NavSnapshot":4}
- **LOCAL measurement**: local Hasura + Postgres serving the real testnet data (6 markets, 4 trades): NOT a hosted measurement.
- Threshold: p95 < 300 ms for every query. Worst sequential p95 **38.5 ms**, worst concurrent p95 **14.2 ms**: **PASS**

| query | seq p50 | seq p95 | seq p99 | seq max | conc p50 | conc p95 | conc p99 |
|---|---|---|---|---|---|---|---|
| status (_meta) | 3.4 | 38.5 | 47.0 | 49.0 | 5.1 | 11.7 | 34.4 |
| marketList open+created | 4.2 | 6.5 | 10.4 | 11.5 | 6.3 | 9.5 | 11.6 |
| marketList by asset (BTC) | 2.9 | 4.8 | 6.0 | 6.7 | 4.3 | 11.1 | 39.0 |
| marketList resolved (page of 50) | 2.9 | 4.1 | 5.5 | 5.6 | 4.7 | 7.1 | 8.1 |
| marketDetail + 50 trades | 4.1 | 6.2 | 7.8 | 10.1 | 8.3 | 11.0 | 12.1 |
| recentTrades 50 | 3.3 | 5.2 | 7.4 | 18.6 | 5.5 | 8.2 | 9.1 |
| userPositions | 3.3 | 4.7 | 5.5 | 5.8 | 7.0 | 12.3 | 14.4 |
| userTrades 50 | 2.7 | 3.9 | 4.7 | 4.9 | 4.9 | 8.7 | 15.7 |
| userOrders 50 | 2.7 | 4.0 | 5.2 | 6.7 | 4.8 | 7.7 | 9.3 |
| vaultOverview | 5.2 | 7.2 | 8.6 | 10.8 | 10.0 | 14.2 | 15.5 |
| navHistory 7d | 2.7 | 4.0 | 6.0 | 13.4 | 5.9 | 7.7 | 8.4 |
| epochs 20 | 2.6 | 3.3 | 4.4 | 5.1 | 4.5 | 10.0 | 13.0 |
| lpOverview | 4.6 | 6.6 | 7.4 | 7.7 | 8.2 | 11.2 | 12.7 |
| dailyStats 30 | 2.6 | 4.3 | 6.0 | 15.4 | 3.7 | 5.4 | 6.3 |
| protocolStats | 2.2 | 3.0 | 3.9 | 4.3 | 3.4 | 5.9 | 11.6 |
