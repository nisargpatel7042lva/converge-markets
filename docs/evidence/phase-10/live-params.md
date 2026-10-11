# Live testnet parameters and state (read from the chain on 2026-10-10)

Read with `viem` against https://rpc-testnet.monadinfra.com (the vault is `0x5dD05FfD80f8959aBD25c82A57f5BD106C27B082`). Reproduce with `readContract` on `quoteParams`, `performanceFeeBps`, `tvlCap`, `quoteNavLower`, `totalSupply`, and `redeemFeeBps` on a live round.

| Parameter | Value | Where it is defined |
|---|---|---|
| Per-market loss ceiling (`perMarketMaxFraction`) | 1 % of NAV | `quoteParams`, on chain |
| Total loss ceiling (`totalAtRiskMaxFraction`) | 8 % of NAV | `quoteParams`, on chain |
| Half-spread, minimum / maximum | 5 cents / 20 cents | `quoteParams`, on chain |
| Quote price bounds | 0.02 to 0.98 | `quoteParams`, on chain |
| Performance fee (`performanceFeeBps`) | 1,000 = 10 % above the high-water mark | on chain; `contracts/src/vault/ConvergeVault.sol:159`; ADR-005 (hard maximum 20 %) |
| TVL cap | 5,000 USDC | `tvlCap` = 5,000,000,000 (6 decimals) |
| Redeem fee on the live 15-minute rounds | 0 | `redeemFeeBps()` on round `0x052c5666aBDA96dE326382186C3062Ec4680D6B1` |
| Order execution delay / maximum lateness | 2 s / 4 s | keeper start line in `.testnet/keeper.log`: `venue: {execDelay: 2, maxLateness: 4}`; `deployments/testnet.json` |
| Vault NAV and share value | $4,029.31 and $1.0119 at 2026-10-11T04:31Z, after a 3,000 test-USDC deposit settled | `docs/evidence/phase-10/stats-reading.json` (`GET /api/stats`, `apps/web/src/app/api/stats/route.ts`) |
