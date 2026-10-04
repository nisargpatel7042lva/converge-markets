# Phase 2: CRE workflow status

## Status: simulation and deployment BLOCKED on a CRE account

History: the first version of this workflow would have failed in CRE regardless of credentials. It needed about 100 EVM reads per run (quota: 15), its gas limit was below a 12-create batch, and its cron ran at the boundary. The Phase 2 hostile review found all three; they are fixed and tested (see the table below).

Every `cre` command that touches the platform (`init`, `workflow simulate`, `workflow deploy`, `workflow supported-chains`, `whoami`) requires `cre login` or `CRE_API_KEY`.
No CRE account or credentials are available in this environment.

Exact output of `cre workflow simulate scheduler -T staging-settings --non-interactive --trigger-index 0` (CRE CLI v1.36.0, 2026-10-04):

```
Initializing...

! You are not logged in

✗ Authentication required: not logged in and no CRE_API_KEY set
  → Run 'cre login' interactively, or
  → Set CRE_API_KEY environment variable for non-interactive use
✗ authentication required: no credentials found: you are not logged in, run cre login and try again
```

## What is verified without an account

| Check | Result | Evidence |
|---|---|---|
| CLI install | CRE CLI **v1.36.0** (`curl -sSL https://app.chain.link/cre/install.sh \| bash`) | `cre version` |
| Workflow typechecks against the real SDK | `@chainlink/cre-sdk@1.23.0` types: `CronCapability`, `EVMClient.callContract/writeReport`, `runtime.report`, `HTTPClient.sendRequest` + `consensusIdenticalAggregation`, `runtime.getSecret`, `getNetwork` | `bun x tsc -p tsconfig.json` (in `make check-2`) |
| Workflow compiles to WASM (Javy/QuickJS) | OK | `cre workflow build` (no login needed; in `make check-2`) |
| Build output | see below | |
| Shared logic | Identical SDK code (`readSnapshotViaLens`, `plan`, `buildReceiverActions`, `encodeSchedulerReport`) is unit-tested and run end to end against the real `SchedulerReceiver` with a forwarder stand-in, on the workflow's `5,35 * * * * *` schedule, with the 9M gas limit | `cre-path-integration.md` |
| CRE quotas | 2 EVM reads per run (quota 15), at most one HTTP request per (feed, boundary) per run (quota 15), report ≤ 12 actions with ≤ 4 creates under a 9M gas limit (quota 10M). The receiver skips rather than reverts when gas runs low | `cre-path-integration.md`, `SchedulerReceiverTest` |
| Receiver | `SchedulerReceiver` implements `IReceiver` + ERC165 per the CRE consumer docs: forwarder check, workflow owner/id from metadata (accepts the 64-byte production metadata), chain + staleness replay protection | Foundry `SchedulerReceiverTest` (15 tests, 100% coverage) |

```
✓ Workflow compiled successfully
  Binary hash: 52942153dc08a37a09d5b5a0390834a96f2882e27a2d5de69765475eb594473f
✓ Build output written to /home/mysterioxplorer/converge/services/scheduler/cre/scheduler/binary.wasm
```

The CRE compiler also enforced the runtime boundary: an early build was rejected because the shared SDK module referenced `fetch` (not available in the CRE runtime). The SDK was split so the workflow imports only fetch-free modules (`round-evidence.ts`, `streams-auth.ts`).

## To finish (needs Nisarg)

1. Create a CRE account (https://app.chain.link), then run `cre login` or set `CRE_API_KEY` in `services/scheduler/cre/.env`.
2. Fund a simulation key (`CRE_ETH_PRIVATE_KEY`) with testnet MON.
3. Deploy Phase 1 contracts, `SchedulerReceiver` and `SchedulerLens` on Monad testnet (`contracts/script/deploy.sh` does all three, using the **MockKeystoneForwarder** `0xB9F79d863261869B234c481D1f9A7af84AeAd192` as forwarder (simulation delivers through the mock forwarder; production uses `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` on testnet and `0x76c9cf548b4179F8901cda1f8623568b58215E62` on mainnet). Then fill `config.staging.json` (factory, receiver, lens).
4. Run `cre workflow simulate scheduler -T staging-settings --non-interactive --trigger-index 0 --broadcast` and save the logs here.
5. Run `cre account` (request deploy access), then `cre workflow deploy scheduler -T production-settings`, and finally `SchedulerReceiver.setWorkflow(owner, workflowId)`.
6. BTC/ETH Data Streams evidence additionally needs Data Streams API credentials (Vault secrets `DATA_STREAMS_API_KEY` / `DATA_STREAMS_API_SECRET`) and the real feed IDs in `config/series.json` (currently zero = blocked).
