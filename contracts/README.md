# contracts

Foundry project for Converge Markets (see `../CLAUDE.md`). Solidity ^0.8.24 (compiled with 0.8.28), OpenZeppelin v5.1.0 and forge-std, vendored in `lib/`.

```bash
forge build
forge test
forge fmt --check
forge lint --deny warnings
```

`script/spike/SpikeToken.sol` is an open-mint test token used only by the Phase 0 Kuru spike (`scripts/spike`). Never deploy it to mainnet.
