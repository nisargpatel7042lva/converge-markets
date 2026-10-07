# Full backfill from the deploy block on Monad testnet (LOCAL indexer, RPC source)

- REAL Monad testnet data (chain 10143), LOCAL indexer (Envio HyperIndex 3.14.0) with an RPC data source behind a rate-limited proxy (10 rps ceiling, see rpc-usage-testnet.json), Postgres + Hasura in Docker. NOT HyperSync, NOT the hosted Envio service.
- Range: block 68644575 to 68726000 (81426 blocks), 79 events processed by handlers
- Wall clock from launching `envio dev -r` to `_meta.isReady = true`: **1211.1 s** (includes codegen, handler type check, Hasura metadata, index creation)
- Indexer log: storage initialised to `Ready. Fully indexed for queries.`: **1206.2 s**
- Request volume and peak rate: `rpc-usage-testnet.json`.
- This is NOT the HyperSync / hosted backfill (BLOCKED: needs the Envio hosted deployment).
