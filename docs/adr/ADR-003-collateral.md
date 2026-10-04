# ADR-003: Collateral token

- Status: **Accepted**
- Date: 2026-10-04
- Evidence: `docs/evidence/phase-0/external-onchain-checks.txt`, `docs/EXTERNAL.md`

## Options

| | USDC | AUSD |
|---|---|---|
| Mainnet address | 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 | 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a |
| Decimals (onchain) | 6 | 6 |
| Supply on Monad (onchain `totalSupply`, 2026-10-04) | 228.9M | 146.9M |
| Bridge / origin | Native Circle USDC via CCTP | Agora AUSD (Monad-native partner stable) |
| Kuru official market | MON-USDC, live two-sided book (0.034336 / 0.034367) | MON-AUSD exists, but `bestBidAsk` returned no two-sided book |
| Testnet availability | Yes (Kuru official testnet USDC, 6 dp) | Not listed on testnet |
| Chainlink feed | USDC/USD (3600 s, 0.05%) | AUSD/USD (3600 s, 0.05%) |
| User familiarity / onramps | Highest (CEX withdrawals, CCTP from any chain) | Lower |
| Mera / bounty fit | Neutral (both are plain ERC-20s; Mera is account-layer only) | Neutral. Possible Monad ecosystem goodwill |

## Decision

**USDC** is the sole collateral for v1.

Reasons: larger supply on Monad, an active Kuru book for the quote asset our UP markets pair against, testnet parity (we can test against the same token Kuru lists), and the easiest onramp for new users arriving through Mera (no wallet, so they need a familiar deposit path).

## Consequences

- All contracts assume 6-decimal collateral. Unit tests must cover 6-dp rounding (outcome tokens are 18 dp, or match collateral; decided in Phase 1).
- The collateral address is a constructor parameter (immutable). Adding AUSD later means deploying a second vault, not migrating.
- Revisit if Monad Foundation or bounty sponsors explicitly favour AUSD, or if AUSD liquidity on Kuru overtakes USDC.
