# Full backfill from the deploy block (LOCAL)

- LOCAL: anvil chain 31337, Envio HyperIndex 3.14.0 with an RPC data source (no HyperSync), Postgres + Hasura in Docker, mock prices. NOT HyperSync, NOT hosted.
- Range: block 1 to 898 (898 blocks), 1424 events processed by handlers, 30 markets, 786 transactions
- Wall clock from launching `envio dev -r` to `_meta.isReady = true`: **10.79 s** (includes codegen, TypeScript check of the handlers, Hasura metadata, index creation)
- Indexer log: storage initialised to `Ready. Fully indexed for queries.`: **5.91 s**
- The HyperSync (hosted / testnet) backfill time is NOT measured: it needs the Envio hosted deployment (see the Phase 6 report, BLOCKED).
