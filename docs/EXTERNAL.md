# External dependencies

Every address, ABI, package and endpoint we rely on. **VERIFIED** means it was read from an official source on the date shown, and (where marked "onchain") also checked against the chain with `cast` (bytecode present, `symbol()`/`decimals()`/`description()` returned the expected value). **BLOCKED** means it could not be verified. Those items sit behind an interface and must not be hardcoded.

Raw onchain checks: `docs/evidence/phase-0/external-onchain-checks.txt`.

## Monad

| Item | Value | Network | Source | Verified | Status |
|---|---|---|---|---|---|
| Chain ID | 143 | mainnet | https://docs.monad.xyz/developer-essentials/network-information | 2026-10-04 (onchain `cast chain-id`) | VERIFIED |
| Chain ID | 10143 | testnet | https://docs.monad.xyz/developer-essentials/testnet | 2026-10-04 (onchain) | VERIFIED |
| Public RPC (QuickNode, 25 rps) | https://rpc.monad.xyz / wss://rpc.monad.xyz | mainnet | network-information page | 2026-10-04 | VERIFIED |
| Public RPC (Alchemy, 15 rps, no debug/trace) | https://rpc1.monad.xyz / wss://rpc1.monad.xyz | mainnet | same | 2026-10-04 | VERIFIED |
| Public RPC (Goldsky, historical state) | https://rpc2.monad.xyz / wss://rpc2.monad.xyz | mainnet | same | 2026-10-04 | VERIFIED |
| Public RPC (Ankr) | https://rpc3.monad.xyz / wss://rpc3.monad.xyz | mainnet | same | 2026-10-04 | VERIFIED |
| Public RPC (Monad Foundation, 20 rps, batch 1) | https://rpc-mainnet.monadinfra.com / wss://rpc-mainnet.monadinfra.com | mainnet | same | 2026-10-04 | VERIFIED |
| Public RPC (QuickNode, 50 rps, archive) | https://testnet-rpc.monad.xyz / wss://testnet-rpc.monad.xyz | testnet | testnet page | 2026-10-04 | VERIFIED |
| Public RPC (Ankr) | https://rpc.ankr.com/monad_testnet (HTTP only) | testnet | testnet page | 2026-10-04 | VERIFIED |
| Public RPC (Monad Foundation) | https://rpc-testnet.monadinfra.com / wss://rpc-testnet.monadinfra.com | testnet | testnet page | 2026-10-04 | VERIFIED |
| Explorers | https://monadvision.com, https://monadscan.com | mainnet | network-information page | 2026-10-04 | VERIFIED |
| Explorers | https://testnet.monadvision.com, https://testnet.monadscan.com | testnet | testnet page | 2026-10-04 | VERIFIED |
| Faucet | https://faucet.monad.xyz (web UI; returned HTTP 429 to curl, so no scripted funding) | testnet | testnet page | 2026-10-04 | VERIFIED |
| Contract verification | `forge verify-contract` against MonadVision (Sourcify) or Monadscan (Etherscan API). Guide: https://docs.monad.xyz/guides/verify-smart-contract/foundry | both | guide | 2026-10-04 | VERIFIED (doc); not yet exercised |
| Gas billing | Charged on **gas limit**, not gas used. Min base fee 100 gwei. Block limit 150M, tx limit 30M | both | https://docs.monad.xyz/developer-essentials/gas-pricing | 2026-10-04; live `cast base-fee` = 100 gwei, priority 2 gwei on both nets | VERIFIED |
| Opcode repricing | Cold account 10,100 gas (ETH 2,600). Cold storage 8,100 per 128-slot page (ETH 2,100 per slot) | both | https://docs.monad.xyz/developer-essentials/opcode-pricing | 2026-10-04 | VERIFIED. Means anvil-fork gas ≠ Monad gas |
| viem chain exports | `monad` (143), `monadTestnet` (10143) in `viem/chains` (viem 2.57.2) | both | Mera guide + installed package | 2026-10-04 | VERIFIED |
| Testnet re-genesis | Testnet reset on 2025-12-16. Older testnet addresses are invalid | testnet | testnet page | 2026-10-04 | VERIFIED |

## Kuru

| Item | Value | Network | Source | Verified | Status |
|---|---|---|---|---|---|
| Router (market factory, proxy) | 0xd651346d7c789536ebf06dc72aE3C8502cd695CC | mainnet | https://docs.kuru.io/contracts/Contract-addresses | 2026-10-04 (onchain: proxy code) | VERIFIED |
| MarginAccount | 0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5 | mainnet | same | 2026-10-04 | VERIFIED (doc) |
| KuruForwarder | 0x974E61BBa9C4704E8Bcc1923fdC3527B41323FAA | mainnet | same | 2026-10-04 | VERIFIED (doc) |
| MonadDeployer | 0xe29309e308af3EE3B1a414E97c37A58509f27D1E | mainnet | same | 2026-10-04 | VERIFIED (doc) |
| KuruFlowEntrypoint / KuruFlowRouter | 0xb3e6778480b2E488385E8205eA05E20060B813cb / 0x0d3a1BE29E9dEd63c7a5678b31e847D68F71FFa2 | mainnet | same | 2026-10-04 | VERIFIED (doc) |
| Official markets MON-AUSD / MON-USDC | 0x131a2e70a5b31a517a74b8c567149bc294470da9 / 0x065C9d28E428A0db40191a54d33d5b7c71a9C394 | mainnet | same | 2026-10-04 | VERIFIED (doc) |
| Router | 0x7EFbE105Ca7415dE98F96622173458ac1c054630 | testnet | same | 2026-10-04 (onchain: proxy code, used in spike) | VERIFIED |
| MarginAccount | 0xd029C2D98ff85D8F64799017fE00a59B1159CE02 | testnet | same | 2026-10-04 (used in spike fork) | VERIFIED |
| KuruForwarder / Deployer / Utils | 0x681bB1508E14433b148a2549ba2726454aDc9BB4 / 0xDacd06372cEb638640c9D8466A023b7362324e1A / 0xE0841E0F06c5770C1D4930EC6C507ee33199C88C | testnet | same | 2026-10-04 | VERIFIED (doc) |
| Testnet USDC / MON-USDC market | 0x3bA3d39AFcf8bb994f7964B3e0171Ea2Ba361570 (6 dp, onchain) / 0xa241896A7Dbe8a550D2E5fF7A914bB1989ceD2D9 | testnet | same | 2026-10-04 | VERIFIED |
| Market creation | `Router.deployProxy(type, base, quote, sizePrecision, pricePrecision, tickSize, minSize, maxSize, takerFeeBps, makerFeeBps, kuruAmmSpread)`. **Permissionless**: no fee beyond gas. Real testnet `eth_estimateGas` from an unprivileged, unfunded EOA succeeds (1,215,279 gas), and the fork spike created 3 markets from that EOA. Each call also deploys a KuruAMMVault | both | https://docs.kuru.io/contracts/Router, spike | 2026-10-04 | VERIFIED |
| Order API | `addBuyOrder/addSellOrder(uint32 price, uint96 size, bool postOnly)`, `batchUpdate(uint32[] buyPrices, uint96[] buySizes, uint32[] sellPrices, uint96[] sellSizes, uint40[] cancelIds, bool postOnly)` (atomic cancel/replace), `batchCancelOrders(uint40[])`, `placeMultipleBuy/SellOrders`, flip orders (`addFlipBuy/SellOrder`, `batchProvisionLiquidity`) | both | https://docs.kuru.io/contracts/OrderBook + SDK abi/OrderBook.json | 2026-10-04 (exercised in spike) | VERIFIED |
| Funding model | Orders are backed by MarginAccount balances: `MarginAccount.deposit(user, token, amount)` | both | SDK abi/MarginAccount.json, spike | 2026-10-04 | VERIFIED |
| Tick / size constraints | Per market: price is a `uint32` in pricePrecision units, size is a `uint96` in sizePrecision units, with tickSize, minSize and maxSize. `kuruAmmSpread` must be 10–500 bps in multiples of 10. For a 0.5 price, SDK `calculatePrecisions(0.5,1,1,1,20)` gives pricePrecision 1e4, sizePrecision 1e4, tick 10 (0.001), minSize 1 token, maxSize 1e5 tokens | both | https://docs.kuru.io/sdk/deploy-market, SDK source | 2026-10-04 | VERIFIED |
| Fill / market events | Router `MarketRegistered(...)`. OrderBook `OrderCreated(orderId, owner, size, price, isBuy)`, `Trade(orderId, maker, isBuy, price, updatedSize, taker, origin, filledSize)`, `OrderCanceled`, `FlipOrderCreated`, `MarketStateUpdated` | both | https://docs.kuru.io/contracts/OrderBook, https://docs.kuru.io/contracts/Integration | 2026-10-04 | VERIFIED |
| `bestBidAsk()` return type | **Docs say `(uint32, uint32)`. The real ABI (SDK) and chain return `(uint256, uint256)` scaled 1e18.** Mainnet MON-USDC returned 0.034336 / 0.034367. Mainnet MON-AUSD returned (2^256-1, 0), i.e. no two-sided book | mainnet | SDK abi/OrderBook.json + `cast call` | 2026-10-04 | VERIFIED. Trust the ABI over the docs page |
| Market states | ACTIVE / SOFT_PAUSED (cancel + withdraw only) / HARD_PAUSED. Kuru owner controls this, so it is a venue risk for us | both | OrderBook docs | 2026-10-04 | VERIFIED |
| Upgradeability | Router, OrderBook and MarginAccount are UUPS proxies (`upgradeToAndCall`, `owner`) | both | SDK ABIs; Router mainnet bytecode is 141-byte proxy | 2026-10-04 | VERIFIED. Venue risk noted in ADR-001 |
| Fees | Set per market by the creator (`takerFeeBps`, `makerFeeBps`). We pass 0/0 for outcome markets. LP fee = spread | both | deploy-market docs, https://docs.kuru.io/liquidity/how-fees-work | 2026-10-04 | VERIFIED |
| SDK | `@kuru-labs/kuru-sdk` latest **0.0.95** (ISC, ethers 5.7.1). `beta` tag is 1.0.3 | npm | `npm view` | 2026-10-04 | VERIFIED. We use only its ABIs and `calculatePrecisions` |
| Market-creation rate limit / allowlist | None in the contract. 3 creations back to back on the fork succeeded | testnet | spike | 2026-10-04 | VERIFIED for contract. Off-chain listing/UI policy: **BLOCKED** (question for Kuru) |
| Spike on live testnet | Needs a funded deployer. Faucet is web-only | testnet | n/a | 2026-10-04 | **BLOCKED** (no testnet MON) |

## Chainlink

Price feeds come from the official directory JSON https://reference-data-directory.vercel.app/feeds-monad-mainnet.json, which backs https://docs.chain.link/data-feeds/price-feeds/addresses?network=monad, and are cross-checked against https://github.com/monad-crypto/protocols/blob/main/mainnet/chainlink.jsonc. Each proxy was read onchain (`description()`, `decimals()`, `latestRoundData()`) on 2026-10-04.

| Item | Value | Network | Heartbeat | Deviation | Decimals | Status |
|---|---|---|---|---|---|---|
| BTC/USD proxy (standard) | 0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546 | mainnet | 3600 s | 0.02% | 8 | VERIFIED onchain |
| ETH/USD proxy (standard) | 0x1B1414782B859871781bA3E4B0979b9ca57A0A04 | mainnet | 3600 s | 0.05% | 8 | VERIFIED onchain |
| MON/USD proxy (standard) | 0xBcD78f76005B7515837af6b50c7C52BCf73822fb | mainnet | 3600 s | 0.02% | 8 | VERIFIED onchain |
| BTC/ETH/MON "shared-svr" variants | 0x187efD8b…723deC / 0x38057D04…7A78 / 0xFB504aD0…8015 (18 dp, 0.05%) | mainnet | 3600 s | 0.05% | 18 | VERIFIED (directory). SVR (OEV-recapture) variants, not used for settlement |
| USDC/USD, AUSD/USD | 0xf5F15f188AbCB0d165D1Edb7f37F7d6fA2fCebec / 0xE20751C7B5867bCBef815ffc1b284c3f412a9e13 | mainnet | 3600 s | 0.05% | 8 | VERIFIED (directory) |
| BTC/USD, ETH/USD | 0x12C0F44368a02081ce58a936d1C1F606BB301715 / 0x5c8c8482f064049248F86D9F4aFa4B1f2F5b6d31 | testnet | 86400 s | 0.5% | 8 | VERIFIED onchain |
| MON/USD | none listed | testnet | | | | **BLOCKED**: no testnet MON/USD feed |
| Observed update cadence (last 25 rounds) | BTC gaps 10–1061 s, ETH 20–3366 s, MON 29–61 s | mainnet | | | | VERIFIED: `docs/evidence/phase-0/chainlink-cadence.txt` |
| Data Streams VerifierProxy | 0xEd813D895457907399E41D36Ec0bE103E32148c8 (7,009 bytes code) | mainnet | | | | VERIFIED onchain + monad-crypto/protocols |
| Data Streams Router (Streams Trade) | 0x33566fE5976AAa420F3d5C64996641Fc3858CaDB | mainnet | | | | VERIFIED (protocols list only). Streams Trade/Automation is **not** listed for Monad on docs.chain.link |
| Data Streams VerifierProxy | 0xC539169910DE08D237Df0d73BcDa9074c787A4a1 (from search snippet) has **no code** after re-genesis | testnet | | | | **BLOCKED** |
| Data Streams stream IDs for BTC/ETH/MON-USD, API access | Requires a Chainlink account (data.chain.link returns 403 to scripts) | | | | | **BLOCKED** (needs Nisarg's sign-up) |
| CRE support | Monad mainnet: CLI ≥ v1.29.0, Go SDK ≥ v1.17.0, TS SDK ≥ v1.18.0. Monad testnet: CLI ≥ v1.30.0, Go ≥ v1.19.0, TS ≥ v1.19.0. SDK languages: Go and TypeScript | | | | | VERIFIED https://docs.chain.link/cre/supported-networks-ts (updated 2026-09-18) |
| CRE write target (KeystoneForwarder) | 0x76c9cf548b4179F8901cda1f8623568b58215E62 (chain name `monad-mainnet`) | mainnet | | | | VERIFIED onchain (8,591 bytes) + https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts |
| CRE write target (KeystoneForwarder) | 0xF8344CFd5c43616a4366C34E3EEE75af79a74482 (`monad-testnet`) | testnet | | | | VERIFIED onchain |
| CRE simulation (MockKeystoneForwarder) | 0x9eF6468C5f37b976E57d52054c693269479A784d (mainnet), 0xB9F79d863261869B234c481D1f9A7af84AeAd192 (testnet) | both | | | | VERIFIED onchain |
| CRE tenant enablement | `cre workflow supported-chains` after `cre login` shows which chains are enabled for our org | | | | | **BLOCKED** (needs Nisarg's CRE account / early access) |

## Mera

| Item | Value | Source | Verified | Status |
|---|---|---|---|---|
| npm package | `@category-labs/mera` 0.2.0 (subpath `@category-labs/mera/viem` → `toViemAccount`). Peer deps used in the guide: `viem`, `@scure/bip32`, `@scure/bip39` | https://docs.monad.xyz/guides/mera, `npm view` | 2026-10-04 | VERIFIED |
| Web API | `createPasskeyWithPrfOutput`, `getPasskeyPrfOutput`, `createSecp256k1SigningSession` (+ `.end()` zeroes key), `toViemAccount`, `getEvmAddress` | mera guide + https://mera.category.xyz reference index | 2026-10-04 | VERIFIED |
| React usage | No React-specific package. Plain functions called from React. React Native has its own guide (https://docs.monad.xyz/guides/mera/react-native) | mera guide | 2026-10-04 | VERIFIED |
| Requirements | HTTPS (or localhost). Passkey provider with WebAuthn PRF, discoverable credentials, user verification | mera guide | 2026-10-04 | VERIFIED |
| PRF support matrix | ✓ 1Password (any browser); iCloud Keychain on Safari iOS 18+/macOS 15+, Chrome macOS 15+ (132+), Chrome iOS 18+, Firefox macOS 15+ (139+); Google Password Manager on Chrome Android, Chrome desktop signed-in (132+), Edge Android; Windows Password Manager on Edge Win 11 25H2+. ✗ Chrome desktop *local profile* (throws `PRF_UNAVAILABLE`) | https://mera.category.xyz/authenticator-support/ | 2026-10-04 | VERIFIED |
| Export to MetaMask / Rabby | Derive with BIP-39 `entropyToMnemonic(prfOutput)` → seed → BIP-44 `m/44'/60'/0'/0/i`. The exported mnemonic imports into MetaMask/Rabby with the same address | mera guide | 2026-10-04 | VERIFIED |
| Gas note | Pass explicit `gas`: Monad bills the limit | mera guide | 2026-10-04 | VERIFIED |

## Stablecoins (mainnet, onchain `symbol()`/`decimals()`)

| Token | Address | Decimals | Source | Status |
|---|---|---|---|---|
| USDC (native, Circle CCTP) | 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 | 6 | Kuru Contract-addresses, Monad tokens-and-bridges | VERIFIED onchain |
| AUSD (Agora) | 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a | 6 | same | VERIFIED onchain |
| WMON | 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A | 18 | same | VERIFIED onchain |
| WMON (testnet) | 0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541 | 18 | testnet page | VERIFIED onchain |
| USDC (testnet) | 0x3bA3d39AFcf8bb994f7964B3e0171Ea2Ba361570 | 6 | Kuru | VERIFIED onchain |
| AUSD (testnet) | not listed | | | **BLOCKED** |

## Envio

| Item | Value | Source | Verified | Status |
|---|---|---|---|---|
| HyperSync / HyperRPC | https://143.hypersync.xyz, https://143.rpc.hypersync.xyz (Monad, network id 143) | https://docs.envio.dev/docs/HyperIndex/supported-networks | 2026-10-04 | VERIFIED |
| HyperSync / HyperRPC | https://10143.hypersync.xyz, https://10143.rpc.hypersync.xyz (Monad Testnet, 10143) | same | 2026-10-04 | VERIFIED |
| Monad guides | https://docs.monad.xyz/guides/indexers/tg-bot-using-envio, …/token-snapshot-hypersync | Monad llms.txt | 2026-10-04 | VERIFIED |

## Safe

| Item | Value | Source | Verified | Status |
|---|---|---|---|---|
| Safe on Monad mainnet | Listed as the multisig provider (app.safe.global). v1.4.1 `Safe_v1_4_1` 0x41675C099F32341bf84BFc5382aF534df5C7461a, `SafeL2_v1_4_1` 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762, `SafeProxyFactory_v1_4_1` 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67, `MultiSend_v1_4_1` 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526 (v1.3.0 set also deployed) | https://docs.monad.xyz/tooling-and-infra/wallets/multisig-wallets, https://github.com/monad-crypto/protocols/blob/main/mainnet/safe.jsonc | 2026-10-04 (onchain: Safe 23,579 bytes, factory 3,054 bytes) | VERIFIED |

## Paradigm pm-AMM

| Item | Value | Status |
|---|---|---|
| Paper | https://www.paradigm.xyz/2024/11/pm-amm. The exact liquidity schedule must be checked against the paper in Phase 3 before use | Not needed in Phase 0 |
