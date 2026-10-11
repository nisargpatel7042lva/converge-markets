# CRE workflow broadcast on Monad testnet (2026-10-11)

The real scheduler workflow (`services/scheduler/cre/scheduler`) was run in the official CRE simulator with `--broadcast` against the live testnet factory, receiver and lens, signing with the deployer key (passed only through the environment). Command: `BROADCAST=1 CRE_ETH_PRIVATE_KEY=… bash scripts/cre/simulate-testnet.sh`. The workflow read the live state in 2 EVM reads and planned two actions: invalidate the stranded 07:00 round and create the 08:30 round.

## Attempt 1: the receiver correctly refused the report

Transaction [`0xfde5065c…48c3`](https://testnet.monadvision.com/tx/0xfde5065c658dbefa3d8858d779935a6f4910935644d0b45183c7f5a3d1cd48c3) went to the forwarder `0xB9F79d86…d192` and succeeded, but the forwarder's `ReportProcessed` event carries `result = false`: the receiver's `onReport` reverted and nothing happened (round 08:30 absent, round 07:00 still CREATED).

Decoding the report showed why. **The simulator stamps placeholder identities on its reports** (workflow ID `0x1111…1111`, workflow owner `0xaaaa…aaaa`), and `SchedulerReceiver` only accepts reports from the configured workflow owner (the deployer on this testnet). That is the receiver's designed protection against anyone else driving it, working as intended.

## Attempt 2: the full path, with a time-limited allowance

To prove the path end to end, the receiver admin pointed `expectedWorkflowOwner` at the simulator's placeholder owner, the broadcast ran, and the deployer was restored as owner in a `finally` block (a few seconds on a play-money testnet; the restore was verified afterwards).

Transaction [`0xf84bf488…b76d`](https://testnet.monadvision.com/tx/0xf84bf488de7305b79d575f32f17dbc57ad7629b5cc6a7bd31dcb5cb77bbeb76d), block 70,057,947, status success, gas 2,500,000 (Monad bills the limit; the testnet config's limit was lowered from 9,000,000 for a two-action report). Its 6 logs:

| Emitter | Event | Meaning |
|---|---|---|
| receiver `0x92e749…` | action result | the invalidate action ran |
| factory `0x6d3c82…` | `MarketCreated` | the 08:30 round was created |
| receiver `0x92e749…` | action result | the create action ran |
| receiver `0x92e749…` | run summary | the batch finished |
| forwarder `0xb9f79d…` | `ReportProcessed` | **result = true** |

**Verified on chain afterwards:** the factory returns market [`0x2Bf59EcCAbA9ce8F62fe48239AE72CCC0B2257de`](https://testnet.monadvision.com/address/0x2Bf59EcCAbA9ce8F62fe48239AE72CCC0B2257de) for the 08:30 round (it did not exist before), the 07:00 round's state is 4 (INVALID), and `expectedWorkflowOwner` is the deployer again.

## What this does and does not show

It shows that the actual CRE workflow code, run in the official simulator, reads live chain state, plans correct actions, and that its signed report drives the on-chain receiver through the Chainlink forwarder to create and invalidate real markets. It is **not** a deployed workflow: deployment needs CRE Early Access, and the production path would use the deployed workflow's real owner and ID, with no placeholder allowance. The forwarder is the testnet forwarder, not a DON-signed one.
