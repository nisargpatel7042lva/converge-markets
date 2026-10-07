# Indexer GraphQL latency (local)

- Endpoint: `http://localhost:8080/v1/graphql`, run at 2026-10-07T07:10:06.784Z
- 200 timed requests per query after 10 warm-up requests; sequential = one client, concurrent = 10 clients. Client-side round trip (fetch to parsed JSON).
- Dataset: {"Market":30,"Trade":131,"UserPosition":143,"NavSnapshot":114}
- **LOCAL measurement**: Hasura + Postgres in Docker on the development machine, tiny dataset, no network. NOT a hosted measurement.
- Threshold: p95 < 300 ms for every query. Worst sequential p95 **7.9 ms**, worst concurrent p95 **20.9 ms**: **PASS**

| query | seq p50 | seq p95 | seq p99 | seq max | conc p50 | conc p95 | conc p99 |
|---|---|---|---|---|---|---|---|
| status (_meta) | 3.3 | 4.1 | 5.1 | 5.8 | 8.3 | 14.3 | 16.6 |
| marketList open+created | 4.3 | 5.7 | 7.8 | 8.6 | 10.4 | 18.0 | 29.8 |
| marketList by asset (BTC) | 3.8 | 4.6 | 6.3 | 6.9 | 7.1 | 12.8 | 17.4 |
| marketList resolved (page of 50) | 5.0 | 6.1 | 7.7 | 8.2 | 11.8 | 17.5 | 23.0 |
| marketDetail + 50 trades | 4.6 | 6.3 | 7.4 | 8.4 | 8.6 | 12.8 | 18.5 |
| recentTrades 50 | 4.0 | 5.1 | 6.6 | 7.2 | 7.6 | 11.5 | 15.4 |
| userPositions | 4.1 | 5.1 | 5.7 | 7.0 | 8.3 | 11.2 | 13.1 |
| userTrades 50 | 3.3 | 4.3 | 5.3 | 5.5 | 7.3 | 10.7 | 12.6 |
| userOrders 50 | 3.3 | 4.5 | 6.9 | 7.1 | 7.2 | 12.9 | 15.8 |
| vaultOverview | 5.9 | 7.3 | 8.4 | 8.6 | 13.6 | 20.9 | 24.2 |
| navHistory 7d | 4.0 | 5.1 | 6.4 | 9.2 | 9.2 | 12.6 | 14.5 |
| epochs 20 | 3.6 | 4.5 | 5.9 | 6.9 | 7.8 | 10.6 | 11.8 |
| lpOverview | 5.3 | 7.9 | 8.4 | 15.2 | 8.4 | 10.9 | 11.9 |
| dailyStats 30 | 3.1 | 4.3 | 5.4 | 6.1 | 5.5 | 8.3 | 9.7 |
| protocolStats | 2.2 | 2.9 | 4.4 | 5.1 | 3.4 | 5.2 | 6.4 |
