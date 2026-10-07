# Indexer runbook (Envio HyperIndex)

Facts below are from the Envio v3 docs (see `docs/EXTERNAL.md`, "Phase 6 additions"). Everything marked **needs Nisarg** was not done in Phase 6.

## What is where

| Thing | Path |
|---|---|
| Project (Envio root directory for the hosted deployment) | `indexer/` |
| Testnet config (generated from `deployments/testnet.json`) | `indexer/config.yaml` |
| Mainnet config (generated from `deployments/mainnet.json` once it exists) | `indexer/config.mainnet.yaml` (not present yet) |
| Schema, handlers | `indexer/schema.graphql`, `indexer/src/handlers/*.ts`, pure math `indexer/src/lib/*.ts` |
| Queries and SDK helpers | `indexer/QUERIES.md`, `packages/sdk/src/indexer.ts` |
| Reconcile, latency, lag, local run | `scripts/reconcile/` |
| Evidence | `docs/evidence/phase-6/` |

After any redeploy of the factory or the vault (Phase 5 may redeploy the vault for the halt flag): update `deployments/testnet.json`, run `pnpm --filter @converge/indexer gen:config`, commit, push. The config, the start blocks and the vault's constructor defaults (keeper, TVL cap) all come from that file.

## Deploy to Envio Cloud (testnet) - needs Nisarg

1. Log in at https://envio.dev/app/login with GitHub, install the **Envio Deployments GitHub App** on `nisargpatel7042lva/converge-markets`.
2. "Add Indexer": repository `converge-markets`, **root directory `indexer`**, config file `config.yaml`, deployment branch e.g. `envio-testnet`.
3. Push the code to the deployment branch (`git push origin main:envio-testnet`). Each push is a new deployment that re-indexes from the start block; the previous deployment keeps serving until the new one is synced; "Promote to Production" switches the static endpoint.
4. Cloud-side requirements (docs): `envio` pinned in `indexer/package.json` (it is: `3.14.0`), pnpm compatible with 10.32.0, node >= 22 (24 recommended), all imports inside `indexer/`. **Open risk:** the repo root is a pnpm 11 workspace; whether the Cloud build installs from the root lockfile or from `indexer/` alone was not verifiable offline. If the first build fails on install, the fix is a standalone `indexer/pnpm-lock.yaml` (or `indexer/.npmrc`), not a code change.
5. **No `ENVIO_API_TOKEN` is needed for a Cloud deployment** (docs: "Indexers deployed to Envio Cloud have their own access to HyperSync"). A token is needed only to run the indexer yourself against HyperSync (`pnpm --filter @converge/indexer dev` with `ENVIO_API_TOKEN` in the environment, never committed).
6. Development plan limits (docs): 3 indexers per organisation, 3 deployments per indexer, soft limits 100,000 events / 5 GB / no requests for 7 days, hard limits 30 days / 20 GB. The testnet history so far is far below 100,000 events; a long soak will cross it, then a paid plan is needed. API-key protection of the endpoint and alerts (Discord/Telegram) are paid-plan features.
7. Copy the GraphQL endpoint (`.../v1/graphql`) into the app config and, if the key option is enabled, the API key.

## Verify against the hosted endpoint (needs Nisarg's endpoint)

```
export INDEXER_URL=https://<endpoint>/v1/graphql       # INDEXER_API_KEY=<key> if gated
# 1. reconciliation against the chain at the indexer's own block (public RPC budget: 15 rps, stay at 10)
pnpm --filter @converge/reconcile reconcile --addresses deployments/testnet.json --rpc https://testnet-rpc.monad.xyz --rps 10 --concurrency 4 --n 300 --aggregates --label testnet
# 2. p95 latency of the app's queries
pnpm --filter @converge/reconcile latency --label hosted --n 200 --concurrency 10
# 3. lag while the keeper runs (no RPC needed: _meta.sourceBlock is the data source's head)
pnpm --filter @converge/reconcile lag --label hosted --duration 600 --max-lag 5
```

Outputs land in `docs/evidence/phase-6/` (`reconcile-testnet.*`, `latency-hosted.*`, `lag-hosted.*`). The backfill time of the hosted deployment is on the deployment page of the Envio dashboard (Historical Sync Complete notification, or `envio-cloud deployment status`); record it in the Phase 6 report.

## Mainnet (prepared, not deployable yet)

`deployments/mainnet.json` does not exist (Phase 9). When it does, `gen:config` writes `indexer/config.mainnet.yaml` and adds the chain-143 defaults; create a second Cloud indexer with config file `config.mainnet.yaml` on its own branch. HyperSync for Monad mainnet: `https://143.hypersync.xyz` (used implicitly by Envio Cloud).

## Operating notes

- Health: Cloud dashboard, or GraphQL `_meta { progressBlock sourceBlock isReady }`; self-hosted: `/healthz` and `/metrics` on port 9898 (`envio_progress_block`, `envio_progress_ready`, `envio_progress_latency`).
- Reorgs: handled by Envio (`rollback_on_reorg` default true); handlers keep no state outside entities.
- A schema or handler change re-indexes from the start block (the deployment keeps its old version serving meanwhile).
- The indexer must not be the only source for safety-critical decisions: exits, redemptions and claims read the chain.
- Constructor state that no event carries (the vault's initial keeper, TVL cap, fee) comes from `deployments/*.json`; `reconcile` checks it against the chain. Recommendation for the next vault build: emit `KeeperSet` / `TvlCapSet` / `FeeSet` / `GuardianSet` from the constructor so an indexer needs nothing out of band.

## Run everything locally (no token, no hosted service)

```
cd contracts && forge build && cd ..
DOCKER_CONFIG_DIR=<dir with config.json {"cliPluginsExtraDirs":[".../.docker/cli-plugins"]}> bash scripts/reconcile/run-local.sh
```

This starts its own anvil, deploys the stack, replays a scripted history, runs Envio with an RPC data source plus Postgres/Hasura in Docker, and writes the `*-local` evidence. It is **not** a HyperSync or hosted measurement.
