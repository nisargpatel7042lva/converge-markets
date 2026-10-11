# Envio HyperIndex against real Monad testnet data (2026-10-11)

**What was run.** The real indexer (`indexer/`, `envio` 3.14.1) with Postgres and Hasura in Docker, indexing a real window of the live testnet deployment through the public RPC (`scripts/indexer/run-local-testnet.sh` with `FACTORY_FROM_BLOCK=VAULT_FROM_BLOCK=69786000`, `END_BLOCK=69793600`): 7,600 blocks, **91 events processed**, covering the 09:15, 09:30 and 09:45 UTC rounds of 2026-10-10, which contain the live bets. The whole history (750,000 blocks) was not indexed: the public RPC source reads about 60 blocks a second, so the full backfill needs HyperSync (Envio Cloud).

## 1. The indexed numbers equal what happened on chain

| Round (UTC) | Indexed | On chain |
|---|---|---|
| 09:15 | status RESOLVED_UP, 0 trades | resolved UP at 09:30:23 (scheduler log); my two bets there were unfilled and refunded, so no trades |
| 09:30 | RESOLVED_DOWN, **2 trades, volume 13,655,339** | the keeper logged order 19 premium 1,995,795 and order 20 premium 11,659,544; their sum is **13,655,339** |
| 09:45 | OPEN at the window's end, **1 trade, volume 1,960,780** | my $1.96 fill: "net cost 1.96078 USDC" |
| Protocol totals | trades 3, volume **15,616,119** | 13,655,339 + 1,960,780 = 15,616,119 |

## 2. The project's reconcile tool (indexer vs chain at the indexer's own block)

Full report: [`envio/reconcile-testnet-window.md`](envio/reconcile-testnet-window.md). **The tool's verdict is FAIL, and the reasons are:**

- It requires 60 sampled entities and this window only has **29**, so the sampling rule cannot be met.
- **27 of the 29 sampled entities match the chain** (Market 5/5, Trade 3/3, Order 9/9, UserPosition 3/3, NavSnapshot 5/5, VaultEpoch 1/1, NavSnapshotSettlement 1/1). The 2 that do not are explained by starting mid-history: the Vault's `totalSupply` is **1,000,000,000 lower** in the index than on chain, which is exactly the first LP deposit, settled before block 69,786,000 and never seen by this window; the same deposit makes one LP position's `shares` differ; and the vault's `venue` field is set at deploy, before the window. A full-history run (HyperSync) would not have these gaps.
- **All six indexer-internal invariants pass**: token supply equals holder balances for all 5 markets, no negative balance or escrow, `costBasis = upCost + downCost`, LP shares at most the vault supply, protocol totals equal the sum over markets and the vault's fill totals (trades 3/3, volume 15,616,119 on both sides), and the APY fields agree with the NAV snapshots.

## 3. Query latency (local Hasura)

Worst p95 across the 13 queries the app runs: **6.1 ms** sequential, **8.6 ms** at concurrency 5 ([`envio/latency-testnet-window.md`](envio/latency-testnet-window.md)). This is a local database; it says nothing about the hosted service.

## 4. The app reads it

With `NEXT_PUBLIC_INDEXER_URL` set, a browser load of the stats page issued **4 indexer queries** (ProtocolStats, DailyStats, VaultOverview, IndexerStatus) and the Earn page issued **2** (VaultOverview, NavHistory), with no console errors (the content-security policy admits the indexer origin). The markets page reads the chain directly, by design: exits and claims never depend on the indexer.

## What this does not show

The indexer is **not hosted**; the Envio Cloud deployment is the owner's step. Lag against the chain head was not measured on testnet (the window ended in the past). Backfill speed through HyperSync was not measured.
