# Indexer GraphQL latency (testnet-window)

- Endpoint: `http://localhost:8081/v1/graphql`, run at 2026-10-11T06:32:39.362Z
- 100 timed requests per query after 10 warm-up requests; sequential = one client, concurrent = 5 clients. Client-side round trip (fetch to parsed JSON).
- Dataset: {"Market":5,"Trade":3,"UserPosition":6,"NavSnapshot":6}
- Hosted measurement (network round trip included).
- Threshold: p95 < 300 ms for every query. Worst sequential p95 **6.1 ms**, worst concurrent p95 **8.6 ms**: **PASS**

| query | seq p50 | seq p95 | seq p99 | seq max | conc p50 | conc p95 | conc p99 |
|---|---|---|---|---|---|---|---|
| status (_meta) | 2.5 | 4.0 | 5.8 | 7.8 | 3.1 | 5.1 | 9.0 |
| marketList open+created | 3.5 | 5.0 | 5.3 | 5.4 | 5.2 | 8.6 | 9.2 |
| marketList by asset (BTC) | 2.9 | 4.3 | 5.8 | 10.2 | 4.0 | 6.9 | 7.2 |
| marketList resolved (page of 50) | 2.7 | 4.1 | 4.9 | 5.2 | 4.6 | 6.7 | 7.5 |
| marketDetail + 50 trades | 3.1 | 4.5 | 5.5 | 9.9 | 5.2 | 6.9 | 7.2 |
| recentTrades 50 | 2.4 | 3.2 | 4.5 | 17.0 | 3.8 | 6.8 | 7.8 |
| userPositions | 2.8 | 3.7 | 4.3 | 4.4 | 4.1 | 6.0 | 6.4 |
| userTrades 50 | 2.6 | 3.1 | 3.8 | 3.9 | 3.5 | 4.9 | 6.3 |
| userOrders 50 | 3.0 | 4.4 | 5.4 | 8.1 | 3.4 | 7.8 | 11.6 |
| vaultOverview | 5.0 | 6.1 | 7.0 | 17.4 | 6.4 | 8.0 | 9.5 |
| navHistory 7d | 2.6 | 3.3 | 4.4 | 4.8 | 4.2 | 6.1 | 6.5 |
| epochs 20 | 2.0 | 2.4 | 3.6 | 4.8 | 2.4 | 3.8 | 4.0 |
| lpOverview | 3.2 | 4.2 | 4.9 | 5.0 | 4.9 | 6.2 | 6.8 |
| dailyStats 30 | 2.3 | 2.8 | 3.7 | 3.9 | 2.8 | 4.8 | 5.5 |
| protocolStats | 2.1 | 2.7 | 3.9 | 5.1 | 2.2 | 6.0 | 9.5 |
