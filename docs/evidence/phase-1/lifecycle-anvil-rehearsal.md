# Phase 1 testnet lifecycle (anvil-rehearsal)

- chain id: 10143, run at 2026-10-04T04:01:32Z
- factory `0x6d3C829CbE58c53625b714d19E49cE1D41e66639`, collateral tUSDC `0x9dedC1B054a0e53777df49722D1Aa20354edB100`, resolver DataStreamsResolver `0x0B1122271A5103193E17A31543De274474a4f10D` (MockStreamsVerifierProxy, TEST-ONLY signer)
- market: TEST/USD 15m, start 1791087300 (2026-10-04T04:15:00Z), end 1791088200
- prices: Chainlink ETH/USD on Monad mainnet at each boundary, x1e10 to 18 dp, signed by the test signer

| step | tx hash | block | status |
|---|---|---|---|
| createMarket(TEST, 15m, 1791087300) | `0xfdbf06f1706f818a6b953e4b7998ef38b139df9af5df98cd783894c06ccbccfe` | 68014570 | ok |
| tUSDC.mint(100) | `0x7ee30edc85b1e738aa020e743b73a0915ed8d91fb91ee28d23c661b555f0b011` | 68014571 | ok |
| tUSDC.approve(market) | `0x171951c2515fcd1bb28f6a0252dfdf7bdd86d6fdf39014ab59c196dedb816e15` | 68014572 | ok |
| split(100 tUSDC) | `0xac8bf6550cb4bd39a45d49b4c1a44e8496d1cdb38fff5bf03f82ef1fe18c55ef` | 68014573 | ok |
| transfer 40 DOWN away (so redeem shows a real payout split) | `0x70f3fd404c3428d8979c6a2053512a0c53d7bda95bbea49a3db17a422a754dca` | 68014574 | ok |
| open(signed report @start, price 2693939182200000000000) | `0x4a39aa4c97e5330496a83ba945079bfa8d460207bc381793bafae6f91600c035` | 68014576 | ok |
| open() after finalization window | `0x094f995ef69f38d53ef5a27cf6317812915831100bf99874204297773ecd2a54` | 68014578 | ok |
| resolve(signed report @end, price 2693939182200000000000) | `0x2710a319fa212b7317574e3792dfe553b9e7fbfe354303733186a89b5d5a4f12` | 68014580 | ok |
| resolve() after finalization window | `0x94053375e15b6f7e280a5a53bd5749a5731118ee8f5296533964280204dfddbd` | 68014582 | ok |
| redeem() | `0x7d6b4dc930c09ea83f83f957f8c66a8066b1733bfd3a71c1ebf91eeb7bf65b2d` | 68014583 | ok |

## Result

- market `0x07da1b952f2F8B1821D713358ab66fbd80C5a311`, UP `0x90e28C8A7841B35bA1a4469B9558e88922e40482` ("TEST UP 2026-10-04 04:15 UTC"), DOWN `0xA98b3b6EC0D24e60b7208AC78EfeB1674B8dC90b`
- strike 2693939182200000000000, end price 2693939182200000000000, state RESOLVED_UP (tie goes UP)
- holder had 100 UP + 60 DOWN; redeem paid 100000000 base units (expected 100e6 if UP, 60e6 if DOWN)
- market collateral left: 0 (equals the winning claims still outstanding: 0 if UP won, 40e6 for the DOWN at 0xdEaD if DOWN won)
