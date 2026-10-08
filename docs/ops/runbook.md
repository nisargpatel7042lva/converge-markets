# Mainnet beta runbook

Read this before the first deposit, and keep it open during an incident. It covers the whole system:
the vault, the markets, the keeper, the schedulers, the indexer, the app and the alerts. The
component runbooks it leans on: [keeper](keeper-runbook.md), [scheduler](scheduler-runbook.md),
[indexer](indexer-runbook.md). Deployment and rollback: [mainnet-deploy.md](mainnet-deploy.md).
The gate before the app is public: [launch-checklist.md](launch-checklist.md).

The beta is capped at **5,000 USDC of vault deposits**, internally reviewed and **not externally
audited** ([internal-audit.md](../security/internal-audit.md)). When in doubt, pause the vault's quoting: it
never blocks an exit. The honest cost: resuming goes through the timelock, so a pause is a day.

## 1. Who does what

| Role | Holds | Can do on chain | Is who (fill in before launch) |
| --- | --- | --- | --- |
| **Owner** | The Safe multisig (threshold of at least 2, hardware-wallet signers on separate devices) **behind the `OwnerTimelock`** (24 h by default) | Proposes and executes owner actions *through the timelock*: resume quoting, rotate the keeper or the guardian, set the TVL cap, change risk parameters, change the treasury. Every one is visible on chain for the full delay before it takes effect. The Safe itself (no delay) only switches the scheduler leader and cancels | Nisarg + the other signers |
| **Guardian** | One hot key on a separate machine from the keeper | `pauseQuoting` on the vault, `pause` on the factory and on the partner registry. Nothing else, and it can never resume | Nisarg |
| **Keeper** | One hot key on the keeper host (a few MON of gas, no USDC) | `setSigma` inside the owner's band, `splitForInventory`, `mergeInventory`, `haltQuoting`, `unhaltQuoting`. It cannot move funds, pause, resume or change a parameter | The keeper service |
| **Scheduler** | One hot key for the fallback scheduler (holds `CREATOR_ROLE`), plus the CRE workflow once it runs | Create markets on the grid; `open`, `resolve` and `invalidate` are permissionless | The scheduler service |
| **Anyone** | Nothing | `settleEpoch`, `checkpoint`, `redeemResolved`, `pruneEmpty`, `executeOrder`, `expireOrder`, `open`, `resolve`, `invalidate`, claims | You, with `cast`, when the services are down |

Keys: the owner, the guardian, the keeper and the scheduler are four different keys. No key is
ever pasted into a chat, a ticket or a log. If you do not know which key you are holding, stop.

**On call.** One person owns each incident from the first page to the all-clear and says so in the
alert channel ("I have it"). Anyone with the guardian key can pause. Only the owner (the Safe, through the timelock) resumes. The public
statement, if any, is Nisarg's decision; until then the status line on `/stats` is the only public
communication.

Severity:

| Level | Means | Response time | Example |
| --- | --- | --- | --- |
| **SEV1** | Funds at risk, or quotes live on bad prices | Pause within 5 minutes | Keeper key compromised; a wrong price is being quoted |
| **SEV2** | Users cannot trade or settle, funds are safe | 30 minutes | Rounds are not being created; epoch not settling; oracle down |
| **SEV3** | Degraded, nothing user-visible is broken | Same day | Indexer behind; one RPC provider down; certificate expiring |

## 2. First five minutes (every incident)

1. Say you have it, in the alert channel.
2. Look at the public status line (`<app>/api/status`) and Grafana "Converge mainnet beta".
3. Decide: **is money or a bad quote at stake?** If yes (or unsure), pause now (section 3.1), then
   investigate. Pausing costs at least a day of quoting (the resume is timelocked); not pausing can cost the cap. Decide with that number in mind.
4. Write down the time and what you saw. Every action below goes into the incident notes with its
   transaction hash.

Environment for the commands below (values from `deployments/mainnet.json`):

```bash
export RPC_URL=...            # a paid endpoint; the public ones allow ~15 requests/s per IP
export VAULT=0x...  VENUE=0x...  FACTORY=0x...  STREAMS=0x...  RECEIVER=0x...  REGISTRY=0x...
# the key is read from a keystore or a hardware wallet, never typed on the command line:
#   cast send ... --account guardian        (an encrypted keystore)   or   --ledger
```

### The owner timelock (read this once)

Everything the owner can do (`resumeQuoting`, `setKeeper`, `setGuardian`, `setTvlCap`,
`setQuoteParams`, `setRiskConfig`, `setSigmaBand`, `setSigmaConfig`, `setTreasury`, `setPerformanceFee`, resolver
and registry configuration) is owned by the `OwnerTimelock`, whose only proposer, executor and canceller is the
Safe. The Safe **schedules** a call, **waits the delay** (24 h; it was raised from 0 by the handover batch and can
only be changed through the timelock itself), then **executes** it. Anyone can read the pending operations on chain
(`CallScheduled` events, `isOperationPending`), and `timelock-watch` posts each one to the alert channels.
What the delay is for: if the Safe is compromised, the LPs have a day to ask for their money back. What it costs: a
fix that needs the owner takes a day. The guardian's `pauseQuoting` has no delay, which is why the guardian is a
separate key.

Schedule / execute / cancel with `cast` (replace the target and the calldata; the salt must be unique per operation):

```bash
TL=0x...                                   # deployments/mainnet.json: timelock
DATA=$(cast calldata "resumeQuoting()")
SALT=$(cast keccak "resume-$(date +%s)")
# Safe transaction 1 (day 0):  schedule(target, value, data, predecessor, salt, delay)
cast calldata "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" $VAULT 0 $DATA 0x$(printf '0%.0s' {1..64}) $SALT 86400
# Safe transaction 2 (day 1 or later): execute(target, value, data, predecessor, salt)
cast calldata "execute(address,uint256,bytes,bytes32,bytes32)" $VAULT 0 $DATA 0x$(printf '0%.0s' {1..64}) $SALT
# cancel an operation by id (Safe only)
cast calldata "cancel(bytes32)" $(cast call $TL "hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)" $VAULT 0 $DATA 0x$(printf '0%.0s' {1..64}) $SALT)
```

(Each printed calldata is the `data` of a Safe transaction to `$TL`.) The launch has ready-made batch files:
`deployments/safe-launch-schedule.mainnet.json` and `safe-launch-execute.mainnet.json`.

## 3. Playbooks

### 3.1 Pause quoting (stop new trades, keep every exit open)

Who: the guardian (instant), or the Safe.

```bash
cast send $VAULT "pauseQuoting()" --account guardian --rpc-url $RPC_URL --gas-limit 120000
cast call $VAULT "quotingPaused()(bool)" --rpc-url $RPC_URL      # expect true
```

Effect: no order fills, no splits. **Unchanged**: deposit and redeem requests, `settleEpoch`,
claims, merge, redeem of resolved rounds, order expiry (escrow comes back), market creation and
resolution. Verified by `ConvergeVault` tests `test_redeem_neverBlockedByPauseOrBreaker` and the
`invariant_noViolation` claim handler.

To also stop the keeper acting, kill it (section 3.2). **Do not reach for the factory or registry pause lightly**:
`MarketFactory.pause()` blocks `split` *and* `createMarket`, and only the owner can `unpause`, which is a timelocked
24 h action. It stops new rounds for at least a day. Merge, redeem and every exit keep working.

**Resume** (Safe only, after you know why it stopped and it is fixed): schedule `resumeQuoting()` through
the timelock (above) and execute it after the delay. Plan for a day of paused quoting after any pause. The daily breaker keeps its baseline, so if the
drawdown limit is still breached the vault pauses again by itself; that is intended.

### 3.2 Pull the quotes without pausing (keeper)

```bash
curl -X POST -H "Authorization: Bearer $KILL_TOKEN" http://<keeper>:9100/kill     # halts quotes on chain
curl -X POST -H "Authorization: Bearer $KILL_TOKEN" http://<keeper>:9100/unkill   # only when clear
```

If the keeper host is unreachable, the guardian pauses (3.1). A halt by the keeper is cleared by
the keeper (`unhaltQuoting`) once its checks are clean; a pause is cleared by the Safe.

### 3.3 Stuck market (a round is not created, opened or resolved)

Symptoms: `StatusNotOk`, `SchedulerDown`, the status line says "round is late" or "settlement is late".

1. Which scheduler leads? `cast call $RECEIVER "leader()(uint8)"`: 0 CRE, 1 FALLBACK.
2. Fallback `/health` and logs (`docs/ops/scheduler-runbook.md`). Restart the container if it is
   unhealthy for a reason that is not an oracle error.
3. If the CRE leads and is late: the Safe switches the leader, `setLeader(1)` on `$RECEIVER`
   (`OPERATOR_ROLE`, held by the Safe directly: no timelock). The fallback takes over on its next tick.
4. Do it by hand. All three are permissionless:

   ```bash
   cast send $MARKET "open(bytes)" 0x --rpc-url $RPC_URL --account ops --gas-limit 600000          # CREATED -> OPEN
   cast send $MARKET "resolve(bytes)" 0x --rpc-url $RPC_URL --account ops --gas-limit 600000       # after the end + finalization window
   cast send $MARKET "invalidate()" --rpc-url $RPC_URL --account ops --gas-limit 300000            # only after the oracle grace (30 minutes)
   ```

   For a Data Streams round the evidence (`data`) is the signed report for the boundary; the
   scheduler fetches it. `open("0x")` and `resolve("0x")` only work when a report has already been
   proposed to the resolver for that boundary (`DataStreamsResolver.submit`).
5. A round that cannot be resolved turns INVALID after the grace period and pays **half per token**
   to both sides. That is the designed failure mode; count it as a missed round in the canary and
   in the post-mortem.

### 3.4 Epoch not settling (LPs waiting)

Symptoms: LPs ask why a deposit or withdrawal is pending; `NavStale`; keeper alert `no-epoch-price`.

`settleEpoch` is permissionless and needs the canonical Data Streams report for the epoch end for
each asset the vault holds an unbalanced position in.

```bash
cast call $VAULT "currentEpoch()(uint256)" --rpc-url $RPC_URL
cast call $VAULT "settlementPlan(uint256)" <epochId> --rpc-url $RPC_URL   # feeds needed, rounds to resolve first
```

Resolve any listed round first (3.3), then call `settleEpoch(epochId, reports)` with the reports
(the keeper does this within seconds of the epoch end). The settlement window is 10 minutes. If it
is missed the epoch **expires**: deposits are refunded and redemptions are requeued into the next
epoch. Nobody loses money; they wait one more epoch (15 minutes). While a settlement is pending the
vault does not fill orders and `redeemResolved` waits; both resume as soon as the epoch settles.

### 3.5 Oracle outage (Data Streams or Chainlink)

Effects, in order of how soon they bite:

1. Orders cannot be executed (they need a report); unexecuted orders are refunded by `expireOrder`
   after the lateness window. The keeper pulls the quotes when it has no healthy price.
2. Epochs with an unbalanced position cannot settle and expire (3.4).
3. Rounds cannot be proposed; after the grace period they become INVALID (pay half).

Do: pause (3.1) if the outage is longer than a couple of minutes, check
`https://status.chain.link` and the Data Streams API from the keeper host, and tell nobody
anything the status line does not already say. Nothing can be done on chain to "fix" an oracle: the
response is to stop taking new risk and wait. **Do not** switch the vault to another price source;
there is none by design.

If the Data Streams API credentials were revoked or expired, the same applies: only the keeper has
them. Renew them (Chainlink account), update the keeper secret, restart.

### 3.6 Keeper key compromised, lost, or the host is untrusted

The keeper key can at worst mis-set sigma inside the owner's band, split inventory within the caps,
and halt quoting. The loss it can cause is bounded by the vault's ceilings (1 % of NAV per market, 8 % in total,
5 % daily breaker; at the 5,000 USDC cap, about 50 USDC per market and 400 USDC in total before the breaker pauses). The key cannot move funds.

1. **Pause** (3.1). This is the one step that cannot wait.
2. Generate a new key on a clean machine. Fund it with a few MON. Store it as a secret file.
3. The Safe schedules `setKeeper(<new address>)` through the timelock and executes it after the delay.
   It **discards the old key's sigma values and halts quoting** until the new key sets fresh values and unhalts. While
   you wait, the pause (step 1) holds the vault: the old key can set a sigma but nothing can fill against it.
4. Move the old key's remaining MON out. Treat the old host as burned: rebuild it.
5. Chain the operations so that you wait once, not twice: schedule `setKeeper` and then `resumeQuoting` with the `setKeeper` operation id as the *predecessor* of the resume (both with their own salt; `safe-batch` uses `LAUNCH_LABEL=v2` for a second resume salt). Start the new keeper in `dry-run`, then `paper`, then `live` ([keeper runbook](keeper-runbook.md)).
6. Check the damage: share price vs. the day's start, `keeper_total_loss_ratio`, `Fill` events since the suspected time.
7. Safe: schedule `resumeQuoting()` through the timelock; execute it after the delay.
8. Post-mortem: how the key leaked, what the key could have done in that time (read the vault's events), and what changes.

### 3.7 Guardian key compromised

It can only pause: an attacker can deny service, not take money. The Safe schedules
`setGuardian(<new>)` through the timelock, then resumes if the attacker paused. Rotate the guardian machine too.

### 3.8 A Safe signer is compromised

Below the threshold nothing happens. Remove the signer and add a replacement with a Safe owner
transaction signed by the remaining owners **now**, and review every pending Safe transaction and every pending
timelock operation (`timelock-watch` lists them). If the threshold may be compromised: pause (guardian), tell the
other signers out of band, and treat it as SEV1. A hostile Safe cannot act instantly: whatever it schedules sits
visible for the delay, and during that time LPs can withdraw (`requestRedeem`, claimed after the next epoch). Cancel
it if the Safe is still yours; if not, the cap (5,000 USDC) and the exits are the defence. Finding F9-01 in the audit.

### 3.9 RPC outage or throttling

- The public endpoints rate-limit per IP (about 15 requests/s) and return 429 first; **nothing else
  may share the keeper's address**. Use a paid endpoint as primary and the others as fall-over
  (`RPC_URLS` is an ordered list).
- Keeper: five consecutive RPC failures or a block gap above 5 s pull the quotes on their own, then
  it sends the halt through whichever endpoint works. Alert `RpcErrors`.
- App: users see the "network is busy" states; the status line shows "can't reach the network"
  (`down`). Their money is unaffected.
- Switch the app's RPC by changing `NEXT_PUBLIC_DEPLOYMENT_JSON.rpcUrl` and redeploying, or switch
  the provider's routing. Keep a second provider account ready *before* launch.

### 3.10 Scheduler outage

CRE down or late: switch the leader to FALLBACK (3.3 step 3). Fallback host down: the CRE keeps
working if it leads; if neither works, create/open/resolve by hand (3.3 step 4) — the grid for the
next three rounds is already created ahead of time (lookahead 3), so a short outage is invisible.

### 3.11 Collateral (USDC) issue

Circle can pause or blacklist. A blacklisted address cannot move USDC: if it is the vault, every
payout stops and nothing in this system can fix it. Fees to the treasury are pulled, never pushed,
so a blacklisted treasury cannot block users (fork test
`test_fork_aBlacklistedTreasuryCannotBlockPartnersOrUsers`). Response: pause, preserve evidence,
read Circle's notice, tell LPs plainly. This risk is accepted in the audit (R5) and is part of why the cap is 5,000.

### 3.12 Chainlink turns on verifier fees

The vault and the venue forward no value to the verifier. If the fee manager is ever set, every
verification that needs a fee reverts: orders can only be expired, epochs with reports cannot
settle. The daily check `scripts/mainnet verify` reads the proxy's fee manager and fails when it is
not zero. If it flips: pause, tell the Safe signers, and plan a redeploy of the vault and the venue
(finding F9-05: accepted; the contracts are immutable). Funds stay safe: LPs exit through
`requestRedeem` on epochs whose inventory is pairs only, and the keeper merges pairs.

### 3.13 Indexer or app down

SEV3. Trading, settlement and exits work from the chain. Restart the indexer
([indexer runbook](indexer-runbook.md)); redeploy the app from the last good build. The app falls back
to chain reads for balances and rounds. If the app is the problem, users can still collect
winnings and withdraw with any wallet tool against the contracts; the addresses are in
`deployments/mainnet.json` and on the explorer.

### 3.14 Region block and legal

The app blocks restricted regions at the edge (`apps/web/config/regions.json`) and keeps exits open.
The contracts do not block anyone. A request to remove a user or an address is **not** an ops task:
send it to Nisarg.

### 3.15 Changing a parameter

Only through the Safe and the timelock, one change per operation, with the reason in the Safe
transaction description. A parameter change is announced to the alert channels by `timelock-watch` the moment it is
scheduled. **Looser needs a second reviewer** and a note in the incident log. Never raise the TVL
cap above what the internal audit and the external review allow. Parameters and their hard limits:
`ConvergeVault.setQuoteParams`, `setRiskConfig`, `setSigmaBand`, `setSigmaConfig`, `setTvlCap`. A venue
replacement is timelocked for two days.

### 3.16 Losing a credential or a signer

- **Data Streams API key and secret.** Only the keeper host holds them, and every manual recipe in 3.3 to 3.5
  needs them to fetch a report. Keep a second, sealed copy with a second person, and a second Chainlink API key
  pair on file (issued under the same account). Without any: orders cannot execute, epochs expire and requests
  roll over, rounds turn INVALID and pay half; nothing can be forced through. Rotating the key is a keeper secret change and a restart.
- **A Safe signer below the threshold.** The Safe can no longer schedule or execute: no resume, no rotation, no cap
  change. The guardian can still pause. Keep at least one more signer than the threshold and test a signature
  from every signer once before the launch (checklist F).
- **Liquidity at settlement.** The proceeds of a round that ended at the epoch end are realised only after the epoch
  settles (`redeemResolved` waits for the settlement), so a large withdrawal can partially fill and the rest rolls
  to the next epoch. That is 15 minutes, not a loss.

## 4. Routine

| When | What |
| --- | --- |
| Daily | Look at Grafana (share price, NAV, missed rounds, keeper wallet), `pnpm --filter @converge/mainnet verify` (must print `0 FAIL`), the status line |
| Weekly | Rehearse one playbook: pause, resume, a keeper restart. Check key custody. Review alert noise: an alert that always fires is an alert nobody reads |
| Before any parameter change | Read the Safe transaction, simulate it on a fork, have a second person read it |
| After any incident | Post-mortem within 48 hours: timeline, cause, what limited the damage, what to change |

Alert routing: Discord receives every alert; pages (`severity=page`) also go to Telegram. The test
alert is `pnpm --filter @converge/mainnet alert-test` (it proves delivery per channel). A dead-man
alert (`Watchdog`) always fires; route it to an external heartbeat service so silence is noticed.

## 5. What to tell people

Until Nisarg decides otherwise: nothing beyond the status line, which already says, in plain words,
whether rounds are opening and settling, whether new bets are paused, and that exits stay open. Do
not speculate in public about causes. Do not announce the beta.
