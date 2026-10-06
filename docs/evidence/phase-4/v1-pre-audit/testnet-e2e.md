# Phase 4 testnet end-to-end (Monad testnet, chain 10143)

Status: **complete**

**TEST-ONLY prices.** Monad testnet has no live Data Streams verifier, so the vault's TEST/USD asset is verified by `MockStreamsVerifierProxy`; the reports are signed by a test key. The contracts, the epoch settlement, the forward-priced fill and the accounting are the production code. Source: `scripts/vault-e2e/src/e2e.ts` (real wall-clock time, about 40 minutes).

## Addresses

| | |
|---|---|
| tusdc | `0x9dedC1B054a0e53777df49722D1Aa20354edB100` |
| factory | `0x6d3C829CbE58c53625b714d19E49cE1D41e66639` |
| streams | `0x0B1122271A5103193E17A31543De274474a4f10D` |
| vault | `0xbe417d5D53725E60A937F2b2894972A7344a92cc` |
| venue | `0x68153506Da3ab7D767c7462ed678D3804008C042` |
| round market | `0x54540f67ab541520bB9401A1a47BF86387ac75e2` |

## Hand-checked results

| quantity | observed | hand-derived (VaultE2E.t.sol) |
|---|---|---|
| LP shares after the first epoch | 999999000 raw (1,000 USDC minus 1,000 dead shares) | 999,999,000 |
| taker fill | 10.000000 UP | 10.000000 |
| premium paid (ask 0.55) | 5.500000 USDC | 5.500000 |
| seconds left at the pricing time | 757 | |
| vault collateral after resolution and redeemResolved | 995.500000 | 995.500000 |
| LP received for all shares | 995.499004 | 995.499004 |
| LP deposited | 1000.000000 | |

The LP lost 4.50 USDC (UP won while the vault was short 10 UP at 0.55) and 0.000996 USDC stays behind as the dead shares' claim.

## Transactions (24)

| # | step | tx | block | gas used |
|---|---|---|---|---|
| 1 | fund keeper (0.5 MON) | [`0x6530b7af79a1fa1643f93e671f57a0a629ed8bcdb5acb501fa9925f087988005`](https://testnet.monadvision.com/tx/0x6530b7af79a1fa1643f93e671f57a0a629ed8bcdb5acb501fa9925f087988005) | 68426661 | 21165 |
| 2 | fund taker (0.3 MON) | [`0xf512f4ce10e7173b411347d594983294128610d4fddb6f0408ba6eedc1c5bd8d`](https://testnet.monadvision.com/tx/0xf512f4ce10e7173b411347d594983294128610d4fddb6f0408ba6eedc1c5bd8d) | 68426665 | 21165 |
| 3 | LP: mint 1,000 tUSDC | [`0xe0623bee6b1502117979320a70b4eae53089d910cccfc27232f0a3b698c0c04f`](https://testnet.monadvision.com/tx/0xe0623bee6b1502117979320a70b4eae53089d910cccfc27232f0a3b698c0c04f) | 68426669 | 93227 |
| 4 | LP: approve vault | [`0xea2e3b598327a6a9f1bc20e38670eacb438f51423ad667d4e26373e16a712072`](https://testnet.monadvision.com/tx/0xea2e3b598327a6a9f1bc20e38670eacb438f51423ad667d4e26373e16a712072) | 68426673 | 60843 |
| 5 | LP: requestDeposit 1,000 tUSDC | [`0xbb450d8a45c651444443fe236e850c7304981bfb4fe74df6af10cdfdaba9baae`](https://testnet.monadvision.com/tx/0xbb450d8a45c651444443fe236e850c7304981bfb4fe74df6af10cdfdaba9baae) | 68426679 | 204678 |
| 6 | creator: createMarket(TEST/USD, 15m, start) | [`0xc83af4a632733c97c4ef1f37df4b6bc0e418a670fc75029c27de016a64246cb0`](https://testnet.monadvision.com/tx/0xc83af4a632733c97c4ef1f37df4b6bc0e418a670fc75029c27de016a64246cb0) | 68426683 | 669774 |
| 7 | fund taker (0.3 MON) | [`0xc9fd70c421c9302a8ad2c216602de8435d4ba7a11d96e1b6a5f1a44b8d9a22f6`](https://testnet.monadvision.com/tx/0xc9fd70c421c9302a8ad2c216602de8435d4ba7a11d96e1b6a5f1a44b8d9a22f6) | 68428817 | 21165 |
| 8 | anyone: submit strike report (TEST price 3000) | [`0x63335be295ce023aa659213e7f5001abcc61256fb327d86caf6e9abf69591325`](https://testnet.monadvision.com/tx/0x63335be295ce023aa659213e7f5001abcc61256fb327d86caf6e9abf69591325) | 68428826 | 168009 |
| 9 | anyone: settleEpoch(deposit epoch) | [`0xdd0a8c9649111cb58c9ada8af48500ffb33822696efd1bdc4a68597615fa74da`](https://testnet.monadvision.com/tx/0xdd0a8c9649111cb58c9ada8af48500ffb33822696efd1bdc4a68597615fa74da) | 68428836 | 280765 |
| 10 | LP: claimDeposit | [`0xe1ee578a81c72ddc9f283ed1b0271fbac0387ea131e476f8a733808d038a3fcf`](https://testnet.monadvision.com/tx/0xe1ee578a81c72ddc9f283ed1b0271fbac0387ea131e476f8a733808d038a3fcf) | 68428845 | 114991 |
| 11 | anyone: market.open() | [`0xf9501a77d85ae2e07cf92a496dd9303e4f8abb8a6ed397e198cc6b2dd08f83ad`](https://testnet.monadvision.com/tx/0xf9501a77d85ae2e07cf92a496dd9303e4f8abb8a6ed397e198cc6b2dd08f83ad) | 68428912 | 164208 |
| 12 | keeper: setSigma(TEST, 0.6) | [`0x23338caf20ba0304640807fba8e55234c81827b9777a6f2a9b7d9eaa2931dda9`](https://testnet.monadvision.com/tx/0x23338caf20ba0304640807fba8e55234c81827b9777a6f2a9b7d9eaa2931dda9) | 68428920 | 70573 |
| 13 | keeper: splitForInventory(100 USDC) | [`0x2982bd16eef791bd8ce2dad8e1c3ef2b9fb32e08b63dbbd5efc9040c13ba4be5`](https://testnet.monadvision.com/tx/0x2982bd16eef791bd8ce2dad8e1c3ef2b9fb32e08b63dbbd5efc9040c13ba4be5) | 68428926 | 529148 |
| 14 | anyone: checkpoint() | [`0x23e068678f05816c3dbb30430f6af5d999dd25dea9135118d2e5ade328bdfa4d`](https://testnet.monadvision.com/tx/0x23e068678f05816c3dbb30430f6af5d999dd25dea9135118d2e5ade328bdfa4d) | 68428935 | 191093 |
| 15 | taker: mint 7 tUSDC | [`0x758afba4129f23fa6f1fae8c53702904caaa1c577f9e8ac3d53d523924a85946`](https://testnet.monadvision.com/tx/0x758afba4129f23fa6f1fae8c53702904caaa1c577f9e8ac3d53d523924a85946) | 68428944 | 73600 |
| 16 | taker: approve venue | [`0xab38e5f5f588d65a252962828fe602b30461479d62dbe7f53f02eb2dd809c912`](https://testnet.monadvision.com/tx/0xab38e5f5f588d65a252962828fe602b30461479d62dbe7f53f02eb2dd809c912) | 68428949 | 60843 |
| 17 | taker: placeOrder(BUY_UP, 10 shares, limit 0.60) | [`0x17ebe401f4a1772da36b9681c11751fd763bbb817bfd6ed35cff84f24e0f190e`](https://testnet.monadvision.com/tx/0x17ebe401f4a1772da36b9681c11751fd763bbb817bfd6ed35cff84f24e0f190e) | 68428958 | 245780 |
| 18 | executor: executeOrder (report for T) | [`0xb39bb12771d9914141b2582bfe22fd9627c7ba9aa0505f95ef5f3f9452323617`](https://testnet.monadvision.com/tx/0xb39bb12771d9914141b2582bfe22fd9627c7ba9aa0505f95ef5f3f9452323617) | 68428972 | 590921 |
| 19 | anyone: submit end report (TEST price 3100) | [`0x3fe2885b93131d5a2441a0df0033975683d3fc1276173028da1549c669a2eb9b`](https://testnet.monadvision.com/tx/0x3fe2885b93131d5a2441a0df0033975683d3fc1276173028da1549c669a2eb9b) | 68431485 | 168009 |
| 20 | anyone: market.resolve() | [`0xd2192778a7404f1a4896b3dcbe05c7425e34de9a97ce7ec434a1e5dc7ff0bbd2`](https://testnet.monadvision.com/tx/0xd2192778a7404f1a4896b3dcbe05c7425e34de9a97ce7ec434a1e5dc7ff0bbd2) | 68431568 | 145399 |
| 21 | anyone: vault.redeemResolved() | [`0x4ebe7fc1d6b23a5dee4ae73092b525a117c74482a599258c61bd78f9479eb98c`](https://testnet.monadvision.com/tx/0x4ebe7fc1d6b23a5dee4ae73092b525a117c74482a599258c61bd78f9479eb98c) | 68431577 | 286155 |
| 22 | LP: requestRedeem(all shares) | [`0xab7e4a3f3f20c27703a245dc81114e56a26e37b5eac4337fc0659e88ff812ce0`](https://testnet.monadvision.com/tx/0xab7e4a3f3f20c27703a245dc81114e56a26e37b5eac4337fc0659e88ff812ce0) | 68431590 | 155937 |
| 23 | anyone: settleEpoch(redemption epoch) | [`0x315a84224a266a80156ea11e016a3faf08dbf8ca6320729781753598961499cf`](https://testnet.monadvision.com/tx/0x315a84224a266a80156ea11e016a3faf08dbf8ca6320729781753598961499cf) | 68434456 | 189747 |
| 24 | LP: claimRedeem | [`0x819418af4381aeda1a25662a6e86bee67169cc2c166f1fc26d7d5ee498f5f096`](https://testnet.monadvision.com/tx/0x819418af4381aeda1a25662a6e86bee67169cc2c166f1fc26d7d5ee498f5f096) | 68434463 | 128379 |
