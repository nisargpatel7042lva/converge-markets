# Launch checklist: capped mainnet beta

**Every box must be ticked, by a person who ran the command and looked at the output, before the app
is made public.** A box that cannot be ticked stops the launch; there is no "ticked with a caveat".
Record the date, the person and the evidence file next to each box. Nothing here has been done on
mainnet yet: this file is the gate, not a report. "Ready" marks what the repository already provides
(built, tested, rehearsed on a fork); the action itself still has to happen.

Reminder of the shape of the beta: **5,000 USDC cap**, internally reviewed and **not externally
audited**, BTC and ETH 15-minute and 1-hour rounds, partner programme off unless decided otherwise.

## A. Decisions and inputs (Nisarg)

- [ ] Seed amount for the vault chosen and written here: ______ USDC (must be at most the TVL cap; the canary needs enough to quote, a few hundred USDC is plenty)
- [ ] TVL cap confirmed: 5,000 USDC (or the number chosen: ______)
- [ ] Partner programme at launch: off / on (recommended off)
- [ ] The Safe exists on Monad: address ______, threshold ____ of ____, signers on hardware wallets, not the deployer key. Ready: the deployer checks code, owners, threshold and that the deployer is not a signer
- [ ] Four distinct keys exist (deployer, guardian, keeper, scheduler), each created on a clean machine and stored as a secret file or in a hardware wallet. Ready: the deployer refuses duplicates
- [ ] Real Data Streams stream ids for BTC/USD and ETH/USD are in `config/series.json`; Data Streams API key and secret are in the keeper's secret store. Ready: placeholders are refused by the deployer
- [ ] Contact sheet filled in `docs/ops/runbook.md` section 1 (who is owner, guardian, on call, and a second person who can read a Safe transaction)
- [ ] The external review is chosen (see the audit document) and the date written here: ______

## B. Funds

- [ ] Deployer has at least 6 MON (the Safe signer who runs the handover also pays gas for its transactions: give the signer 1 MON) (the rehearsal bills about 3.8 MON; the rehearsal file is `docs/evidence/phase-9/mainnet-rehearsal.json`)
- [ ] Keeper has at least 2 MON; scheduler has at least 2 MON; guardian has 0.5 MON (enough to send a pause)
- [ ] Canary trader wallet has about 40 USDC and 3 MON
- [ ] Seed wallet holds the seed amount in USDC and a little MON

## C. Deployment

- [ ] **Before anything is deployed**, the stream ids in `config/series.json` pass `STREAMS_API_KEY=... STREAMS_API_SECRET=... RPC_URL=... pnpm --filter @converge/mainnet check-streams` in its pre-deployment mode (windows contiguous across boundaries, 18-decimal prices near the exchange price). The ids are written to an immutable resolver: a wrong one means a redeploy. Run it with `SAMPLE_SECONDS=1800` or more and across a 15-minute boundary

- [ ] `pnpm --filter @converge/mainnet plan` prints "configuration is valid; nothing was sent"
- [ ] `deploy -- --execute` finished; `deployments/mainnet.json` exists and is committed
- [ ] `pnpm --filter @converge/mainnet verify` ends with **0 FAIL** (save the output to `docs/evidence/phase-9/mainnet-verify.txt`)
- [ ] The Safe executed the handover batch (through the timelock); `verify` shows no PENDING, "timelock delay is 86400 s", the Safe can propose/execute/cancel, nobody else administers the timelock, and "the deployer does not own" passes for the vault, the streams resolver and the registry
- [ ] `deployments/safe-launch-schedule.mainnet.json` executed (the resume is scheduled; it can only run 24 h later). Date and time: ______
- [ ] `timelock-watch` is running and a scheduled operation (the launch one) reached Discord and Telegram
- [ ] All contracts are verified on the explorer (`pnpm --filter @converge/mainnet explorer` commands, then open each address and see the source)
- [ ] **Live Data Streams check passes** (the one part never run against a real report): `STREAMS_API_KEY=... STREAMS_API_SECRET=... pnpm --filter @converge/mainnet check-streams` prints no FAIL for BTC and ETH, and `docs/evidence/phase-9/streams-live-check.json` is committed. This proves: report windows are contiguous and contain the requested second, prices are 18-decimal, and the real VerifierProxy accepts a real report when called as the vault, the venue and the resolver. Ready: the tool and its unit tests; it needs credentials
- [ ] The deployer key is emptied and archived

## D. Services

- [ ] Keeper config generated from the deployment (`pnpm --filter @converge/mainnet gen`) and the keeper started in `dry-run`, then `paper` (an hour of logs with no halt flapping), then `live`
- [ ] Fallback scheduler running as the leader; `curl <scheduler>/health` returns 200. CRE workflow deployed and its owner/workflow id set on the receiver (`setWorkflow`) **or** the decision to launch on the fallback alone is written here: ______
- [ ] Indexer running on mainnet (`pnpm --filter @converge/indexer gen:config` from `deployments/mainnet.json`); `status` shows it within 2 blocks of the head
- [ ] App built with `NEXT_PUBLIC_DEPLOYMENT_JSON` from `deployments/generated/mainnet/app-deployment.json`, `NEXT_PUBLIC_APP_ENV=production`, a paid RPC, and **deployed behind the region block** (`apps/web/config/regions.json`); a request with a restricted country header gets the 451 page
- [ ] `<app>/api/status` answers `"level":"ok"` once quoting is on

## E. Monitoring and alerts

- [ ] Prometheus, Alertmanager, Grafana and the blackbox exporter are up with `docker compose -f docker-compose.yml -f docker-compose.mainnet.yml up -d`
- [ ] `ops/prometheus/targets/{app,status,indexer,scheduler}.yml` hold the real URLs; Prometheus shows all four probe jobs **UP** (and `ProbeTargetsMissing` is not firing)
- [ ] Grafana dashboard "Converge mainnet beta" loads with data
- [ ] **Test alert fired on every channel:** `pnpm --filter @converge/mainnet alert-test` prints `PASS discord` and `PASS telegram`, **and** a person confirms they saw both messages on their phone. Save the output to `docs/evidence/phase-9/alert-test.txt`
- [ ] The `Watchdog` heartbeat goes to an external service that alerts when it stops
- [ ] One real alert was provoked on purpose: kill the keeper (`/kill`) and see `KeeperHalted` reach Discord (it is a warning, so not Telegram); stop the keeper process and see `KeeperDown` page both channels; bring them back
- [ ] The public status line shows on `/stats`. Until the launch step it says "paused", so `StatusNotOk` pages: silence that one alert in Alertmanager until `launch-execute` runs, and remove the silence then

## F. Rehearsal of the playbooks (each once, on mainnet, with the seed in)

- [ ] Guardian pauses (`pauseQuoting`) and the status line says "paused". (The Safe's timelocked resume takes the full delay: rehearse it only if you accept a day of paused quoting; the fork rehearsal already ran it)
- [ ] The Safe schedules `setKeeper` to a second key through the timelock, **cancels** it, and a cancelled operation is announced (proves the cancel path without a day of downtime)
- [ ] A redeem request is made and claimed by the seed wallet (a small amount) to prove exits work end to end
- [ ] The kill switch and a keeper restart were exercised

## G. Seed and canary

- [ ] Seed deposited (`requestDeposit`), epoch settled, shares claimed
- [ ] `safe-launch-execute.mainnet.json` executed by the Safe (the delay has passed); quoting is live
- [ ] `pnpm --filter @converge/mainnet canary:report -- --start` recorded
- [ ] Canary trader running (`canary:trade`) and manual phone trades made (at least 5, both sides, at least one claim made on the phone)
- [ ] **At least 12 hours** elapsed; `canary:report -- --min-hours 12` prints **PASS**: 0 missed rounds, 0 failed claims, 0 stuck orders
- [ ] Vault PnL from the report is written into the phase report as it is, including a loss
- [ ] Any alert that fired during the canary has a note (cause, action)

## H. Final gate before making the app public

- [ ] Another person has read the runbook top to bottom and can name the first three actions of a SEV1
- [ ] Nobody has the owner key on a machine that also runs a service
- [ ] The external-review plan and the cap rationale are written on `/legal` or in the app's risk text (the product says what it is: capped, unaudited, can lose money)
- [ ] **Nisarg has said "go".** The repository never announces anything.
