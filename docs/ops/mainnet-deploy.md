# Mainnet deployment

The deployer is `scripts/mainnet` (TypeScript, viem). It is **idempotent** (re-running changes
nothing and checks what exists), **resumable** (state is written after every transaction to
`deployments/mainnet.json`), and it **refuses** an unsafe configuration before it sends anything.
It has been rehearsed end to end on a local anvil fork of Monad mainnet with the real USDC, the
real VerifierProxy and the real Safe v1.4.1 contracts (`pnpm --filter @converge/mainnet test:fork`,
evidence `docs/evidence/phase-9/mainnet-rehearsal.json`). It has **not** been run on mainnet.

## What it deploys, in order

| # | Step | Notes |
| --- | --- | --- |
| 0 | `OwnerTimelock` | Delay 0 at birth (boot state); the Safe is its only proposer, executor and canceller; **no admin**. The handover batch raises the delay to `TIMELOCK_DELAY_SEC` (24 h) |
| 1 | `MarketFactory` (+ market and token implementations) | Admin is the deployer until the handover; roles are granted to the right keys and the deployer renounces them |
| 2 | `DataStreamsResolver`, `ChainlinkRoundResolver` | Real VerifierProxy `0xEd81…48c8`; finalization window 120 s, grace 30 min |
| 3 | Assets | BTC/USD and ETH/USD on the Data Streams resolver with the **real stream ids** from `config/series.json`; MON/USD on the round resolver. Irreversible, so zero or malformed ids are refused |
| 4 | `SchedulerLens`, `SchedulerReceiver` | CRE forwarder `0x76c9…5E62`; leader = FALLBACK until the CRE workflow is registered |
| 5 | `ConvergeVault`, `ForwardVenue` | Parameters from `config/strategy.default.json`; TVL cap 5,000 USDC; quoting is **paused** until launch |
| 6 | (optional, `ENABLE_PARTNERS=1`) `PartnerRegistry`, `ThresholdResolver` | Off for the beta unless Nisarg says otherwise (see "Decisions") |
| 7 | Handover | `transferOwnership` / admin roles to the **timelock** (the Safe gets only the scheduler's OPERATOR role, to switch the leader quickly); the Safe runs the handover batch through the timelock (`acceptOwnership()` on each contract, then the delay) |

## Prerequisites (all are Nisarg's, see the phase report)

1. A **Safe** on Monad (`app.safe.global`, threshold at least 2, hardware-wallet signers). The deployer refuses an address with no code, a Safe with fewer than 2 owners or a threshold below 2, and a Safe in which the deployer key is a signer (it prints the Safe's owners, threshold and version for you to check against the Safe app).
2. Four separate keys: **deployer** (used once, then emptied), **guardian**, **keeper**, **scheduler**. The tool refuses two roles with the same address.
3. MON: the rehearsal bills **about 3.8 MON** for the deployment (`docs/evidence/phase-9/mainnet-rehearsal.json`: 37.09 M gas limit x 102 gwei, Monad bills the limit). Fund the deployer with at least 6 MON. The keeper and the scheduler need a few MON each.
4. **Real Data Streams stream ids** for BTC/USD and ETH/USD on Monad, in `config/series.json` (`streamsFeedId`), with API credentials for the keeper. The deploy is blocked until these exist.
5. An RPC with headroom (paid), and the explorer (MonadVision / Monadscan) reachable for verification.

## Run it

```bash
cd ~/converge && pnpm install --frozen-lockfile && (cd contracts && forge build)

export NETWORK=mainnet RPC_URL=...  SAFE_ADDRESS=0x... GUARDIAN_ADDRESS=0x... \
       KEEPER_ADDRESS=0x... SCHEDULER_ADDRESS=0x...  TVL_CAP_USDC=5000  TIMELOCK_DELAY_SEC=86400
read -rs DEPLOYER_PRIVATE_KEY && export DEPLOYER_PRIVATE_KEY     # silent prompt; never in a file or shell history

pnpm --filter @converge/mainnet plan                                  # validates everything, sends nothing
CONFIRM_MAINNET=I_UNDERSTAND_THIS_SPENDS_REAL_MONEY \
  pnpm --filter @converge/mainnet deploy -- --execute                 # the deployment (resumable)
pnpm --filter @converge/mainnet verify                                # read only; must end "0 FAIL"
pnpm --filter @converge/mainnet explorer                              # prints the forge verify-contract commands
pnpm --filter @converge/mainnet safe-batch                            # writes deployments/safe-{handover,launch-schedule,launch-execute}.mainnet.json
pnpm --filter @converge/mainnet gen                                   # keeper config + app deployment JSON (APP_RPC_URL=...)
pnpm --filter @converge/indexer gen:config                            # indexer config from deployments/mainnet.json
```

`verify` reports `WARN` for the two expected states between deployment and launch (ownership
acceptance pending; quoting paused) and `FAIL` for anything wrong: an owner that is not the Safe,
a role held by the deployer, parameters that differ from `config/strategy.default.json`, a TVL cap
that differs, a feed id that is not the configured one, and a VerifierProxy with a fee manager or an
access controller. It also prints the vault's share supply (zero before the seed).

If a transaction in the middle fails, fix the cause and run `deploy` again: finished steps are
skipped after being re-checked on chain. If the chain state and `deployments/mainnet.json` ever
disagree, the tool stops and says which; do not hand-edit the file.

## Handover to the Safe (through the timelock)

1. In the Safe app, import `deployments/safe-handover.mainnet.json` (Transaction Builder) and execute it. It is
   two transactions to the timelock, `scheduleBatch` then `executeBatch` (delay 0 while the timelock is in its boot
   state): `acceptOwnership()` on the vault, the Data Streams resolver, the round resolver and (if present) the
   partner registry, then `updateDelay(86400)` on the timelock itself. From that moment every owner action waits 24 h.
   Read the batch before signing: the targets must be the addresses in `deployments/mainnet.json`.
2. `pnpm --filter @converge/mainnet verify` again: the `PENDING` warnings are gone, "timelock delay is 86400 s",
   "the Safe can propose / execute / cancel on the timelock", "nobody but the timelock itself administers the timelock".
3. Start `timelock-watch` (see the runbook) so every scheduled owner action reaches the alert channels.
4. Empty the deployer: send the leftover MON away. It is never used again.

## Launch (after the checklist)

Quoting is turned on by the timelocked `resumeQuoting()`:

1. Right after the handover, import and execute `deployments/safe-launch-schedule.mainnet.json`. It schedules
   `resumeQuoting()` with the full delay. `timelock-watch` announces it.
2. Work through the checklist during the delay (verification, services, alerts, seed deposit).
3. When every box above "launch" is ticked, and not before, execute `deployments/safe-launch-execute.mainnet.json`.
   Anyone can see the operation; the Safe can cancel it (`cancel(bytes32)`) if something is found.

The seed deposit (a normal `requestDeposit` from the seeding wallet) is made before that and settles in the next epoch.

## Explorer verification

`pnpm --filter @converge/mainnet explorer` prints one `forge verify-contract` command per
contract with the constructor arguments read from the creation transactions. MonadVision (Sourcify)
needs no key; Monadscan needs an API key. Verification is part of the launch checklist.

## Rollback

The contracts are immutable. "Rollback" means: pause quoting, let everyone exit (a redeem request is
always accepted; the keeper merges pairs), and deploy a fixed system next to it. A new vault needs
a new venue and a new indexer config; the factory and the resolvers can be reused. Funds are never moved by an upgrade, because there is none.

## Decisions that are the owner's (flagged in the phase report)

- **Partner programme at launch.** Recommended off. It adds a second class of markets chosen by outside parties (audit findings F9-03, F9-06, F9-14) and is not needed to prove the core loop.
- **TVL cap.** 5,000 USDC (the default in this repository). Raise it only after the external review.
- **MON markets.** The scheduler creates the hourly MON/USD rounds, but the vault cannot quote them (no Data Streams stream for MON, and the keeper has no second price source for it), so they have no liquidity. The app lists BTC and ETH only.
