# Phase 2: CRE workflow status

## Status: simulation and deployment BLOCKED on a CRE account

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
| Shared logic | Identical SDK code (`readSnapshot`, `plan`, `buildReceiverActions`, `encodeSchedulerReport`) is unit-tested and run end to end against the real `SchedulerReceiver` with a forwarder stand-in | `cre-path-integration.md` |
| Receiver | `SchedulerReceiver` implements `IReceiver` + ERC165 per the CRE consumer docs: forwarder check, workflow owner/id from metadata (accepts the 64-byte production metadata), chain + staleness replay protection | Foundry `SchedulerReceiverTest` (15 tests, 100% coverage) |

```
✓ Workflow compiled successfully
  Binary hash: 8e4ad9611d6c120b419b487396aea54cdc971dbc8ece212af8b5cfb7dfd6ad25
✓ Build output written to /home/mysterioxplorer/converge/services/scheduler/cre/scheduler/binary.wasm
```

The CRE compiler also enforced the runtime boundary: an early build was rejected because the shared SDK module referenced `fetch` (not available in the CRE runtime). The SDK was split so the workflow imports only fetch-free modules (`round-evidence.ts`, `streams-auth.ts`).

## To finish (needs Nisarg)

1. Create a CRE account (https://app.chain.link), then run `cre login` or set `CRE_API_KEY` in `services/scheduler/cre/.env`.
2. Fund a simulation key (`CRE_ETH_PRIVATE_KEY`) with testnet MON.
3. Deploy Phase 1 contracts and `SchedulerReceiver` on Monad testnet with the **MockKeystoneForwarder** `0xB9F79d863261869B234c481D1f9A7af84AeAd192` as forwarder (simulation delivers through the mock forwarder; production uses `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` on testnet and `0x76c9cf548b4179F8901cda1f8623568b58215E62` on mainnet). Then fill `config.staging.json` (factory, receiver).
4. Run `cre workflow simulate scheduler -T staging-settings --non-interactive --trigger-index 0 --broadcast` and save the logs here.
5. Run `cre account` (request deploy access), then `cre workflow deploy scheduler -T production-settings`, and finally `SchedulerReceiver.setWorkflow(owner, workflowId)`.
6. BTC/ETH Data Streams evidence additionally needs Data Streams API credentials (Vault secrets `DATA_STREAMS_API_KEY` / `DATA_STREAMS_API_SECRET`) and the real feed IDs in `config/series.json` (currently zero = blocked).
