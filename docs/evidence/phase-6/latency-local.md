# Indexer GraphQL latency (local)

- Endpoint: `http://localhost:8080/v1/graphql`, run at 2026-10-06T16:11:26.113Z
- 200 timed requests per query after 10 warm-up requests; sequential = one client, concurrent = 10 clients. Client-side round trip (fetch to parsed JSON).
- Dataset: {"Market":30,"Trade":131,"UserPosition":143,"NavSnapshot":114}
- **LOCAL measurement**: Hasura + Postgres in Docker on the development machine, tiny dataset, no network. NOT a hosted measurement.
- Threshold: p95 < 300 ms for every query. Worst sequential p95 **6.4 ms**, worst concurrent p95 **19.0 ms**: **PASS**

| query | seq p50 | seq p95 | seq p99 | seq max | conc p50 | conc p95 | conc p99 |
|---|---|---|---|---|---|---|---|
| status (_meta) | 2.1 | 3.3 | 4.1 | 10.9 | 6.1 | 9.3 | 12.8 |
| marketList open+created | 3.2 | 4.7 | 6.5 | 20.7 | 7.4 | 9.7 | 14.0 |
| marketList by asset (BTC) | 2.2 | 3.2 | 3.7 | 4.2 | 4.4 | 19.0 | 19.9 |
| marketList resolved (page of 50) | 3.0 | 4.2 | 4.8 | 5.2 | 10.5 | 15.0 | 17.1 |
| marketDetail + 50 trades | 3.4 | 4.9 | 5.4 | 6.4 | 12.2 | 16.1 | 18.0 |
| recentTrades 50 | 2.9 | 3.9 | 5.3 | 5.7 | 6.9 | 12.0 | 17.4 |
| userPositions | 3.1 | 4.2 | 5.2 | 5.8 | 7.6 | 13.4 | 16.5 |
| userTrades 50 | 2.8 | 3.7 | 4.6 | 8.9 | 6.7 | 8.6 | 9.6 |
| userOrders 50 | 2.8 | 3.6 | 4.5 | 8.0 | 6.4 | 8.5 | 9.0 |
| vaultOverview | 4.3 | 6.4 | 8.2 | 10.9 | 8.9 | 12.5 | 13.9 |
| navHistory 7d | 2.5 | 3.2 | 4.1 | 8.7 | 6.5 | 8.4 | 9.3 |
| epochs 20 | 2.5 | 3.4 | 4.9 | 10.9 | 5.9 | 8.4 | 9.5 |
| lpOverview | 4.1 | 5.4 | 6.4 | 8.7 | 8.3 | 13.1 | 14.8 |
| dailyStats 30 | 3.1 | 4.7 | 5.4 | 5.6 | 8.3 | 12.2 | 24.2 |
| protocolStats | 2.3 | 3.5 | 4.1 | 5.1 | 4.5 | 6.5 | 10.3 |
