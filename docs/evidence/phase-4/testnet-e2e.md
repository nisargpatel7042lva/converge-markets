# Phase 4 testnet end-to-end (Monad testnet, chain 10143)

Status: **complete**

**TEST-ONLY prices.** Monad testnet has no live Data Streams verifier, so the vault's TEST/USD asset is verified by `MockStreamsVerifierProxy`; the reports are signed by a test key. The contracts, the epoch settlement, the forward-priced fill and the accounting are the production code. Source: `scripts/vault-e2e/src/e2e.ts` (real wall-clock time, about 40 minutes).

This run is the **final code** (after the independent review). It was resumed twice: once after an RPC timeout and once after a bug in the script's own resume logic at the last step (LP shares read as 0); every transaction below is on the final deployment, and the vault numbers are the ones hand-derived in `VaultE2E.t.sol`. The pre-audit run is in `v1-pre-audit/`.

## Addresses

| | |
|---|---|
| tusdc | `0x9dedC1B054a0e53777df49722D1Aa20354edB100` |
| factory | `0x6d3C829CbE58c53625b714d19E49cE1D41e66639` |
| streams | `0x0B1122271A5103193E17A31543De274474a4f10D` |
| vault | `0xcd2072443D37397DbEa4e8eADbCcfB8cB1f10748` |
| venue | `0xDf5958c9d759a97B7C3A9e49F8fB0924406698Aa` |
| round market | `0xD29aA3b73Abda1928B50Ab44819C05460Ddbe0D2` |

## Hand-checked results

| quantity | observed | hand-derived (VaultE2E.t.sol) |
|---|---|---|
| LP shares after the first epoch | 999999000 raw (1,000 USDC minus 1,000 dead shares) | 999,999,000 |
| taker fill | 10.000000 UP | 10.000000 |
| premium paid (ask 0.55) | 5.500000 USDC | 5.500000 |
| seconds left at the pricing time | 857 | |
| vault collateral after resolution and redeemResolved | 995.500000 | 995.500000 |
| LP received for all shares | 995.499004 | 995.499004 |
| LP deposited | 1000.000000 | |

The LP lost 4.50 USDC (UP won while the vault was short 10 UP at 0.55) and 0.000996 USDC stays behind as the dead shares' claim.

## Transactions (23)

| # | step | tx | block | gas used |
|---|---|---|---|---|
| 1 | fund taker (0.3 MON) | [`0x786a7f4cffe6648d97d02a07fbe82bb6b1b61a2e69ec73bcc13a9b35c0cea31e`](https://testnet.monadvision.com/tx/0x786a7f4cffe6648d97d02a07fbe82bb6b1b61a2e69ec73bcc13a9b35c0cea31e) | 68616306 | 21165 |
| 2 | LP: mint 1,000 tUSDC | [`0x80be3385c65f4b37a8aa8031b05237c67679e4fa65489172b3d558c275836cc0`](https://testnet.monadvision.com/tx/0x80be3385c65f4b37a8aa8031b05237c67679e4fa65489172b3d558c275836cc0) | 68616314 | 53530 |
| 3 | LP: approve vault | [`0x2e0c27c3b939458734e96f2088f0bade9ba425db11c248f6782f101436aa0f42`](https://testnet.monadvision.com/tx/0x2e0c27c3b939458734e96f2088f0bade9ba425db11c248f6782f101436aa0f42) | 68616321 | 60843 |
| 4 | LP: requestDeposit 1,000 tUSDC | [`0x57be9ad789431cb4d66bd8acc59d52504687b24bff1b35e0f37e5f4cd3e3fc67`](https://testnet.monadvision.com/tx/0x57be9ad789431cb4d66bd8acc59d52504687b24bff1b35e0f37e5f4cd3e3fc67) | 68616328 | 204704 |
| 5 | creator: createMarket(TEST/USD, 15m, start) | [`0x6e96edc37178604df77fb188667df8288797916a23a0054d8cf5182b4fdbec0e`](https://testnet.monadvision.com/tx/0x6e96edc37178604df77fb188667df8288797916a23a0054d8cf5182b4fdbec0e) | 68616334 | 650610 |
| 6 | anyone: submit strike report (TEST price 3000) | [`0x9de53b4b4cf5bb90477d376f201ad3c8c002098e0d0f554b5193d653fe99f477`](https://testnet.monadvision.com/tx/0x9de53b4b4cf5bb90477d376f201ad3c8c002098e0d0f554b5193d653fe99f477) | 68617935 | 167995 |
| 7 | anyone: settleEpoch(deposit epoch) | [`0xe31ca6bd3c00c1e7705da82dd80d744e21e7693e0c0156052b6f0658ff127463`](https://testnet.monadvision.com/tx/0xe31ca6bd3c00c1e7705da82dd80d744e21e7693e0c0156052b6f0658ff127463) | 68617940 | 280792 |
| 8 | LP: claimDeposit | [`0xe64401dd825ece4112554ececc600535c5d9a58a7de6331e441e0727f0240889`](https://testnet.monadvision.com/tx/0xe64401dd825ece4112554ececc600535c5d9a58a7de6331e441e0727f0240889) | 68617945 | 115017 |
| 9 | anyone: market.open() | [`0x678f6e09c06b08b943d3ab6b2bb5cbe2b253c4cc54c5cfc95dbd40d90212547e`](https://testnet.monadvision.com/tx/0x678f6e09c06b08b943d3ab6b2bb5cbe2b253c4cc54c5cfc95dbd40d90212547e) | 68618014 | 164208 |
| 10 | keeper: setSigma(TEST, 0.6) | [`0x4f1ee8e21c0679e9349b69b85d050d0077b7ae609aa7fd3c310f258b45c215e0`](https://testnet.monadvision.com/tx/0x4f1ee8e21c0679e9349b69b85d050d0077b7ae609aa7fd3c310f258b45c215e0) | 68618019 | 70598 |
| 11 | keeper: splitForInventory(100 USDC) | [`0x3258b16de810259af7d53ac4663d4695c9374c459f6807f24afa370f8e1c0008`](https://testnet.monadvision.com/tx/0x3258b16de810259af7d53ac4663d4695c9374c459f6807f24afa370f8e1c0008) | 68618025 | 529173 |
| 12 | anyone: checkpoint() | [`0x4c9d5835fc93b66709e28bc87eb3c8a162f01e0a79c268c8adaba02f60f13def`](https://testnet.monadvision.com/tx/0x4c9d5835fc93b66709e28bc87eb3c8a162f01e0a79c268c8adaba02f60f13def) | 68618031 | 191119 |
| 13 | taker: mint 7 tUSDC | [`0x9484035ba8825ce52773449b2f380b9344810d384b911fa05b9a33ff349171c7`](https://testnet.monadvision.com/tx/0x9484035ba8825ce52773449b2f380b9344810d384b911fa05b9a33ff349171c7) | 68618036 | 73585 |
| 14 | taker: approve venue | [`0x0862c682c6f588321af7492606d9a4b40a9a498ef78eef6711f2bdac2fb9e10c`](https://testnet.monadvision.com/tx/0x0862c682c6f588321af7492606d9a4b40a9a498ef78eef6711f2bdac2fb9e10c) | 68618053 | 60843 |
| 15 | taker: placeOrder(BUY_UP, 10 shares, limit 0.60) | [`0x142ace0b13765665283b6df848ab743a9ae28d3ea258f286df759d9787ef9393`](https://testnet.monadvision.com/tx/0x142ace0b13765665283b6df848ab743a9ae28d3ea258f286df759d9787ef9393) | 68618061 | 245703 |
| 16 | executor: executeOrder (report for T) | [`0x9f37d4f7284c6cda02f55f77fdf8d344886a437e71ef0314e4c67069a9172f72`](https://testnet.monadvision.com/tx/0x9f37d4f7284c6cda02f55f77fdf8d344886a437e71ef0314e4c67069a9172f72) | 68618073 | 597658 |
| 17 | anyone: submit end report (TEST price 3100) | [`0x6dd960f2d0675617883fda26c22b79108be5c7bd9bb2acfd633e9c8ecdc1cd46`](https://testnet.monadvision.com/tx/0x6dd960f2d0675617883fda26c22b79108be5c7bd9bb2acfd633e9c8ecdc1cd46) | 68620868 | 167995 |
| 18 | anyone: market.resolve() | [`0xcc034f20255782029285ca3d318e4668951265873cffca1e78e4b2bab5ecfa89`](https://testnet.monadvision.com/tx/0xcc034f20255782029285ca3d318e4668951265873cffca1e78e4b2bab5ecfa89) | 68620943 | 145399 |
| 19 | taker: market.redeem() (10 UP -> 10 tUSDC) | [`0xa8171c06b12fb34ac332dea7ce54730f65d458df0474bb411bfc712a62bd16c6`](https://testnet.monadvision.com/tx/0xa8171c06b12fb34ac332dea7ce54730f65d458df0474bb411bfc712a62bd16c6) | 68620948 | 174864 |
| 20 | anyone: vault.redeemResolved() | [`0xd465768feb4f09e9006c4c90636353f41164fccc8760e32e966cd89b10a2a617`](https://testnet.monadvision.com/tx/0xd465768feb4f09e9006c4c90636353f41164fccc8760e32e966cd89b10a2a617) | 68620952 | 285846 |
| 21 | LP: requestRedeem(all shares) | [`0x9abc21a430fe8ef3b6ab9fc39a726b4da4a0631e4d7fbf1633ddaff048abf343`](https://testnet.monadvision.com/tx/0x9abc21a430fe8ef3b6ab9fc39a726b4da4a0631e4d7fbf1633ddaff048abf343) | 68621355 | 155963 |
| 22 | anyone: settleEpoch(redemption epoch) | [`0xcc09fcd005583eeeade234f93d899dd26f16b45e8a59c574899ee6087ace40ca`](https://testnet.monadvision.com/tx/0xcc09fcd005583eeeade234f93d899dd26f16b45e8a59c574899ee6087ace40ca) | 68623813 | 189773 |
| 23 | LP: claimRedeem | [`0x89b5a0b56d4227e70446d83db1a5cf0303c4a1e7847000a0ab270acc5bb08bab`](https://testnet.monadvision.com/tx/0x89b5a0b56d4227e70446d83db1a5cf0303c4a1e7847000a0ab270acc5bb08bab) | 68623819 | 108622 |
