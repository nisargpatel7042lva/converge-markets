# Phase 1 testnet lifecycle (anvil-rehearsal)

- chain id: 10143, run at 2026-10-04T07:50:48Z
- factory `0x6d3C829CbE58c53625b714d19E49cE1D41e66639`, collateral tUSDC `0x9dedC1B054a0e53777df49722D1Aa20354edB100`, resolver DataStreamsResolver `0x0B1122271A5103193E17A31543De274474a4f10D` (MockStreamsVerifierProxy, TEST-ONLY signer)
- market: TEST/USD 15m, start 1791100800 (2026-10-04T08:00:00Z), end 1791101700
- prices: latest Chainlink ETH/USD (Monad mainnet) answer when the script reached each boundary, x1e10 to 18 dp, signed by the test signer

| step | tx hash | block | status |
|---|---|---|---|
| createMarket(TEST, 15m, 1791100800) | `0x7d4e070c27ee3b6f72ad8105cd427567369f982ece400b35f8fd16103ee75064` | 68060131 | ok |
| tUSDC.mint(100) | `0xc75404c95729c34b913b9cc67b70ad4a4454082778064bed60332b37a8d8bf91` | 68060132 | ok |
| tUSDC.approve(market) | `0x7fac328c92da810f4a5c8f836d1f50a2fc05c3dfc5970768ebfaabb30a44451e` | 68060133 | ok |
| split(100 tUSDC) | `0xec3771e47891f96bc0f1ac3dff2a240deb2c53239360c05630be7a1fa3ccc33e` | 68060134 | ok |
| transfer 40 DOWN away (so redeem shows a real payout split) | `0x92e059c57477a3c5b42ae28b9545ebe989cc2791fec15d1dc9382df6888f94bf` | 68060135 | ok |
| open(signed report @start, price 2695090000000000000000) | `0x70a9a992774ecf867a4cd8cceb65a9262800310d5842a1c46e2f61d07e531716` | 68060137 | ok |
| open() after finalization window | `0xa80aea4ec742ec1b55f27a68ad3221d51d00600585e2450c268ecbb3cfd6e3b5` | 68060139 | ok |
| resolve(signed report @end, price 2695090000000000000000) | `0x485f84179b59cd9e6c03794bd62111525008e5f29db0461ad63c462907e3d8fa` | 68060141 | ok |
| resolve() after finalization window | `0xad8e564eedf6b46614afe9ea9e53323bd6ad69c9b6dca953ae664ff1c9ef641a` | 68060143 | ok |
| redeem() | `0x80d00b31f13c3ae1b9bb40cd615ee1782577590cddc0b7e2d2e40569dcbb432a` | 68060144 | ok |

## Result

- market `0x12D623b8cbB2a42Ee8Ce719f854d2AC3B4fF2435`, UP `0x90e28C8A7841B35bA1a4469B9558e88922e40482` ("TEST UP 2026-10-04 08:00 UTC"), DOWN `0xA98b3b6EC0D24e60b7208AC78EfeB1674B8dC90b`
- strike 2695090000000000000000, end price 2695090000000000000000, state RESOLVED_UP (tie goes UP)
- holder had 100 UP + 60 DOWN; redeem paid 100000000 base units (expected 100e6 if UP, 60e6 if DOWN)
- market collateral left: 0 (equals the winning claims still outstanding: 0 if UP won, 40e6 for the DOWN at 0xdEaD if DOWN won)
