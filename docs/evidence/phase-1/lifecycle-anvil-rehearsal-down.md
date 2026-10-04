# Phase 1 testnet lifecycle (anvil-rehearsal)

- chain id: 10143, run at 2026-10-04T07:51:01Z
- factory `0x6d3C829CbE58c53625b714d19E49cE1D41e66639`, collateral tUSDC `0x9dedC1B054a0e53777df49722D1Aa20354edB100`, resolver DataStreamsResolver `0x0B1122271A5103193E17A31543De274474a4f10D` (MockStreamsVerifierProxy, TEST-ONLY signer)
- market: TEST/USD 15m, start 1791102600 (2026-10-04T08:30:00Z), end 1791103500
- prices: latest Chainlink ETH/USD (Monad mainnet) answer when the script reached each boundary, x1e10 to 18 dp, signed by the test signer
- **rehearsal nudge:** end price shifted by -10 bps to exercise the non-tie path

| step | tx hash | block | status |
|---|---|---|---|
| createMarket(TEST, 15m, 1791102600) | `0x762fbcb74694695f7bd1176ccd156b93b05058a8427f8c74a078a67626c4240c` | 68060145 | ok |
| tUSDC.mint(100) | `0x4b6686227154f7602d8efa24b2d1c0501f3fbf6b632e3f0294ee7709de3f6296` | 68060146 | ok |
| tUSDC.approve(market) | `0xecd58563a89e3bd50ab0ff093f2f2e5994800458bfd08367f8bc42ffbc668ad7` | 68060147 | ok |
| split(100 tUSDC) | `0x3c591e8c56a1aecdcd44e9aeca8f3c3484084e38c810fa1b34e9818c43712eea` | 68060148 | ok |
| transfer 40 DOWN away (so redeem shows a real payout split) | `0x924a6cdfad68a585865f71b7d51db27105429b26dc638348dd24466d6f4697ce` | 68060149 | ok |
| open(signed report @start, price 2695090000000000000000) | `0x8f27cf631a65df5de19320cb64a1dff6265fa6c681d594cf469afc55156b5187` | 68060151 | ok |
| open() after finalization window | `0xdf4af6e65b0f58443c43e7708996140b581cb5096b9a1f2821d6becdd507d8a0` | 68060153 | ok |
| resolve(signed report @end, price 2692394910000000000000) | `0x013f04f2b5b93087fcabd37379fe80c6ab1ae3a0c6eeb0e12d272c4e79045cfb` | 68060155 | ok |
| resolve() after finalization window | `0x3334aef627e0618bf7a5fcb44b1fa733a81ec69fa93a4724857739c15efbdedd` | 68060157 | ok |
| redeem() | `0x3d491754355483650cf0ef5103f98ea9a72502617a6160be0c850054753e56e5` | 68060158 | ok |

## Result

- market `0x55E975c73Cf3462b029EBf56B12C2B9F45B4049f`, UP `0x7C7F9E2ED7474881d22A303020AA4a5975AFbe6E` ("TEST UP 2026-10-04 08:30 UTC"), DOWN `0xAf8A0e1e131369f842937b9aF1b1B8cC5664A0F1`
- strike 2695090000000000000000, end price 2692394910000000000000, state RESOLVED_DOWN (tie goes UP)
- holder had 100 UP + 60 DOWN; redeem paid 60000000 base units (expected 100e6 if UP, 60e6 if DOWN)
- market collateral left: 40000000 (equals the winning claims still outstanding: 0 if UP won, 40e6 for the DOWN at 0xdEaD if DOWN won)
