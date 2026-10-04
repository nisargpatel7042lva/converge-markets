# Phase 1 lifecycle evidence

**Live Monad testnet: BLOCKED.** Deployer `0xe36848e8654a86Fd2F7f97DDB3C56042fFD54dd1` has 0 testnet MON (checked 2026-10-04), and the faucet is web-only. Once it is funded:

```bash
NETWORK_NAME=testnet RPC_URL=https://testnet-rpc.monad.xyz VERIFY=1 bash contracts/script/deploy.sh
NETWORK_NAME=testnet RPC_URL=https://testnet-rpc.monad.xyz bash contracts/script/lifecycle.sh
```

This writes `deployments/testnet.json` and `docs/evidence/phase-1/lifecycle-testnet.md`, with real tx hashes.

## Local rehearsal (anvil fork of Monad testnet, chain id 10143)

The same scripts were run end to end against `anvil --fork-url https://testnet-rpc.monad.xyz`, with time advanced by `evm_setNextBlockTimestamp`.

**These tx hashes exist only on the local fork, not on Monad testnet.**

- [Tie → UP](lifecycle-anvil-rehearsal-tie-up.md): the real ETH/USD price did not move during the warp, so strike == end price. The market resolved UP and paid 100e6 to a holder of 100 UP + 60 DOWN.
- [DOWN](lifecycle-anvil-rehearsal-down.md): the end price was shifted −10 bps with `END_PRICE_DELTA_BPS` (rehearsal-only flag, labelled in the file). The market resolved DOWN and paid 60e6.
- INVALID paths are covered by unit tests (`test_open_unresolvableInvalidates`, `test_resolve_unresolvableInvalidates`, `test_streamsMarket_noReportInvalidates`, `test_open_afterGraceWithEvidence_invalidatesInsteadOfReverting`) and by the invariant suite (102 of 258 runs).
