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
| Market creation, **testnet** | `Router.deployProxy(type, base, quote, sizePrecision, pricePrecision, tickSize, minSize, maxSize, takerFeeBps, makerFeeBps, kuruAmmSpread)`. **Permissionless**: no fee beyond gas. Real testnet `eth_estimateGas` from unprivileged `0x…dEaD` succeeds (1,215,279 gas), and the fork spike created 3 markets from deployer `0xe36848e8654a86Fd2F7f97DDB3C56042fFD54dd1`. Each call also deploys a KuruAMMVault | testnet | https://docs.kuru.io/contracts/Router, spike, `external-onchain-checks.txt` | 2026-10-04 | VERIFIED |
| Market creation, **mainnet** | **Owner-gated.** `deployProxy` from `0x…dEaD` reverts `0x82b42900` = `Unauthorized()`. The same call from Router owner `0x8B736DCe2071783Fd9DB0a423dad17cc8ed5788b` estimates 1,254,652 gas | mainnet | `monad-gas-estimates.txt` | 2026-10-04 | VERIFIED gated. Converge access: **BLOCKED** (question for Kuru) |
| Order API | `addBuyOrder/addSellOrder(uint32 price, uint96 size, bool postOnly)`, `batchUpdate(uint32[] buyPrices, uint96[] buySizes, uint32[] sellPrices, uint96[] sellSizes, uint40[] cancelIds, bool postOnly)` (atomic cancel/replace), `batchCancelOrders(uint40[])`, `placeMultipleBuy/SellOrders`, flip orders (`addFlipBuy/SellOrder`, `batchProvisionLiquidity`) | both | https://docs.kuru.io/contracts/OrderBook + SDK abi/OrderBook.json | 2026-10-04 (exercised in spike) | VERIFIED |
| Funding model | Orders are backed by MarginAccount balances: `MarginAccount.deposit(user, token, amount)` | both | SDK abi/MarginAccount.json, spike | 2026-10-04 | VERIFIED |
| Tick / size constraints | Per market: price is a `uint32` in pricePrecision units, size is a `uint96` in sizePrecision units, with tickSize, minSize and maxSize. `kuruAmmSpread` must be 10–500 bps in multiples of 10. For a 0.5 price, SDK `calculatePrecisions(0.5,1,1,1,20)` gives pricePrecision 1e4, sizePrecision 1e4, tick 10 (0.001), minSize 1 token, maxSize 1e5 tokens | both | https://docs.kuru.io/sdk/deploy-market, SDK source | 2026-10-04 | VERIFIED |
| Fill / market events (from SDK ABI; **the docs page differs**, so trust the ABI) | Router `MarketRegistered(...)`. OrderBook (no indexed params): `OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy)`, `Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)`, `OrdersCanceled(uint40[] orderId, address owner)`, `FlipOrderCreated`, `FlippedOrderCreated`, `FlipOrderUpdated`, `FlipOrdersCanceled(uint40[] orderIds, address owner)`. MarginAccount `Deposit(owner, token, amount)`, `Withdrawal(owner, token, amount)`. The docs list `OrderCanceled` (singular), indexed params and `uint32` Trade price. **Wrong** for the deployed contracts | both | `@kuru-labs/kuru-sdk@0.0.95` abi/*.json; `OrderCreated` topic `0xb81bbaf1…f94c` seen live on mainnet | 2026-10-04 | VERIFIED |
| `bestBidAsk()` return type | **Docs say `(uint32, uint32)`. The real ABI (SDK) and chain return `(uint256, uint256)` scaled 1e18.** Mainnet MON-USDC returned 0.034336 / 0.034367. Mainnet MON-AUSD returned (2^256-1, 0), i.e. no two-sided book | mainnet | SDK abi/OrderBook.json + `cast call` | 2026-10-04 | VERIFIED. Trust the ABI over the docs page |
| Market states | ACTIVE / SOFT_PAUSED (cancel + withdraw only) / HARD_PAUSED. Kuru owner controls this, so it is a venue risk for us | both | OrderBook docs | 2026-10-04 | VERIFIED |
| Upgradeability | Router, OrderBook and MarginAccount are UUPS proxies (`upgradeToAndCall`, `owner`) | both | SDK ABIs; Router mainnet bytecode is 141-byte proxy | 2026-10-04 | VERIFIED. Venue risk noted in ADR-001 |
| Fees | Set per market by the creator (`takerFeeBps`, `makerFeeBps`). We pass 0/0 for outcome markets. LP fee = spread | both | deploy-market docs, https://docs.kuru.io/liquidity/how-fees-work | 2026-10-04 | VERIFIED |
| SDK | `@kuru-labs/kuru-sdk` latest **0.0.95** (ISC, ethers 5.7.1). `beta` tag is 1.0.3 | npm | `npm view` | 2026-10-04 | VERIFIED. We use only its ABIs and `calculatePrecisions` |
| Market-creation rate limit / allowlist | Testnet: none (3 back-to-back creations on the fork). Mainnet: owner-only (see above). Off-chain listing/UI policy unknown | both | spike, estimates | 2026-10-04 | **BLOCKED** for mainnet (question for Kuru) |
| Spike on live testnet | Needs a funded deployer. Faucet is web-only | testnet | n/a | 2026-10-04 | **BLOCKED** (no testnet MON) |

## Chainlink

Price feeds come from the official directory JSON https://reference-data-directory.vercel.app/feeds-monad-mainnet.json, which backs https://docs.chain.link/data-feeds/price-feeds/addresses?network=monad, and are cross-checked against https://github.com/monad-crypto/protocols/blob/main/mainnet/chainlink.jsonc. Each proxy was read onchain (`description()`, `decimals()`, `latestRoundData()`) on 2026-10-04.

| Item | Value | Network | Heartbeat | Deviation | Decimals | Status |
|---|---|---|---|---|---|---|
| BTC/USD proxy (standard) | 0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546 | mainnet | 3600 s | 0.02% | 8 | VERIFIED onchain |
| ETH/USD proxy (standard) | 0x1B1414782B859871781bA3E4B0979b9ca57A0A04 | mainnet | 3600 s | 0.05% | 8 | VERIFIED onchain |
| MON/USD proxy (standard) | 0xBcD78f76005B7515837af6b50c7C52BCf73822fb | mainnet | 3600 s | 0.02% | 8 | VERIFIED onchain |
| BTC/USD shared-svr | 0x187efD8ba8483105f2735740D956f7CD23723deC | mainnet | 3600 s | 0.05% | 18 | VERIFIED (directory). SVR (OEV-recapture) variant, not used for settlement |
| ETH/USD shared-svr | 0x38057D0458ca56068e1A57E62D3874cA129A7A78 | mainnet | 3600 s | 0.05% | 18 | VERIFIED (directory). Not used for settlement |
| MON/USD shared-svr | 0xFB504aD06Ab5E6c63FE0A46FEa245214838E8015 | mainnet | 3600 s | 0.05% | 18 | VERIFIED (directory). Not used for settlement |
| Feed risk categories (directory `feedCategory`) | BTC/ETH: low. **MON/USD: new** | mainnet | | | | VERIFIED (directory) |
| USDC/USD, AUSD/USD | 0xf5F15f188AbCB0d165D1Edb7f37F7d6fA2fCebec / 0xE20751C7B5867bCBef815ffc1b284c3f412a9e13 | mainnet | 3600 s | 0.05% | 8 | VERIFIED (directory) |
| BTC/USD, ETH/USD | 0x12C0F44368a02081ce58a936d1C1F606BB301715 / 0x5c8c8482f064049248F86D9F4aFa4B1f2F5b6d31 | testnet | 86400 s | 0.5% | 8 | VERIFIED onchain |
| MON/USD | none listed | testnet | | | | **BLOCKED**: no testnet MON/USD feed |
| Observed update cadence (last 40 rounds) | BTC gaps 10–1,061 s (median 170). ETH 20–3,607 s (median 311, 7 of 39 > 15 min). MON 29–90 s (median 30) | mainnet | | | | VERIFIED: `docs/evidence/phase-0/chainlink-cadence.txt` |
| Data Streams VerifierProxy | 0xEd813D895457907399E41D36Ec0bE103E32148c8 (7,009 bytes code, `typeAndVersion` "VerifierProxy 2.0.0") | mainnet | | | | VERIFIED onchain + monad-crypto/protocols. **But `s_feeManager()` = 0x0 and `s_accessController()` = 0x0. Whether verification is live for streams is BLOCKED (ADR-002 named answer)** |
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
| HyperSync API token | Required: an unauthenticated `POST https://143.hypersync.xyz/query` returns HTTP 401. Add `ENVIO_API_TOKEN` (envio.dev account) | live check 2026-10-04 | 2026-10-04 | **BLOCKED** (needs Nisarg's Envio token) |
| Monad guides | https://docs.monad.xyz/guides/indexers/tg-bot-using-envio, …/token-snapshot-hypersync | Monad llms.txt | 2026-10-04 | VERIFIED |

## Safe

| Item | Value | Source | Verified | Status |
|---|---|---|---|---|
| Safe on Monad mainnet | Listed as the multisig provider (app.safe.global). v1.4.1 `Safe_v1_4_1` 0x41675C099F32341bf84BFc5382aF534df5C7461a, `SafeL2_v1_4_1` 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762, `SafeProxyFactory_v1_4_1` 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67, `MultiSend_v1_4_1` 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526 (v1.3.0 set also deployed) | https://docs.monad.xyz/tooling-and-infra/wallets/multisig-wallets, https://github.com/monad-crypto/protocols/blob/main/mainnet/safe.jsonc | 2026-10-04 (onchain: Safe 23,579 bytes, factory 3,054 bytes) | VERIFIED |

## Paradigm pm-AMM

| Item | Value | Status |
|---|---|---|
| Paper | https://www.paradigm.xyz/2024/11/pm-amm. **Verified in Phase 3 (2026-10-05)** from the page's TeX source: dynamic invariant (y−x)Φ((y−x)/(L√(T−t))) + L√(T−t)φ((y−x)/(L√(T−t))) − y = 0; liquidity curve L_t = L√(T−t) (section "Dynamic pm-AMM", subsection "Constant LVR"); y*−x* = L_tΦ⁻¹(P); pool value V(P,t) = L_t φ(Φ⁻¹(P)); outcome-token volatility φ(Φ⁻¹(P))/√(T−t). Cited in `packages/strategy/src/liquidity.ts`; cross-checked numerically in `packages/strategy/test/liquidity.test.ts` | VERIFIED |

## Phase 2 additions (scheduler)

| Item | Value | Source | Verified | Status |
|---|---|---|---|---|
| CRE CLI | v1.36.0, installed via `curl -sSL https://app.chain.link/cre/install.sh \| bash` to `~/.cre/bin`. `init`, `simulate`, `deploy` and `supported-chains` need `cre login` / `CRE_API_KEY`. `workflow build` works without login | https://docs.chain.link/cre/getting-started/cli-installation, local run | 2026-10-04 | VERIFIED. Simulation **BLOCKED** (no CRE account) |
| CRE TS SDK | `@chainlink/cre-sdk@1.23.0` (depends on viem ^2.54.2, zod 3.25.76, @noble/hashes 2.2.0, javy plugin 1.7.0). Requires Bun ≥ 1.2.21; local 1.3.9 (snap: use `bun x`, not `bunx`) | npm, https://docs.chain.link/cre/reference/sdk/overview-ts | 2026-10-04 | VERIFIED (workflow typechecks and compiles) |
| CRE cron | Minimum interval 30 s; payload carries `scheduledExecutionTime` | SDK Reference: Cron Trigger | 2026-10-04 | VERIFIED (doc) |
| CRE quotas (complete, per execution unless noted) | **EVM reads: 15** (`ChainRead.CallLimit`), EVM read request payload 5 KB, log query 100 blocks; **HTTP requests: 15**, response 250 KB, connect timeout 10 s; **EVM write gas: 10,000,000 per tx**, report payload 50 KB, 10 write targets; consensus calls 50 (observation 25 KB); secrets calls (see doc); 5 min execution timeout; 30 concurrent capability calls; 100 KB workflow response; 1,000 log events; cron ≥ 30 s; 3 workflows per org (private registry) | https://docs.chain.link/cre/service-quotas | 2026-10-04 | VERIFIED (doc). **Phase 2's first version missed the 15-read limit** (hostile review H1); fixed with `SchedulerLens` (2 reads per run) |
| CRE consumer contract | `IReceiver.onReport(bytes metadata, bytes report)` + ERC165. Metadata = `abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address owner)`; production forwarders deliver 64 bytes (an extra 2-byte reportId). Replay guidance: embed chain + scheduled time | https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts | 2026-10-04 | VERIFIED (doc); implemented in `SchedulerReceiver` |
| CRE runtime limits | Javy/QuickJS: no `fetch`/`node:*`; the compiler rejects them statically | `cre workflow build` error output | 2026-10-04 | VERIFIED |
| Data Streams REST | Mainnet `https://api.dataengine.chain.link`, testnet `https://api.testnet-dataengine.chain.link`. `GET /api/v1/reports?feedID=&timestamp=` → `{report:{feedID, validFromTimestamp, observationsTimestamp, fullReport}}` | https://docs.chain.link/data-streams/reference/data-streams-api/interface-api | 2026-10-04 | VERIFIED (doc); live calls **BLOCKED** (no API key) |
| Data Streams auth | Headers `Authorization` (API key), `X-Authorization-Timestamp` (ms, within 5 s of server), `X-Authorization-Signature-SHA256` = hex HMAC-SHA256(secret, `"METHOD PATH BODY_HASH API_KEY TIMESTAMP"`) | https://docs.chain.link/data-streams/reference/data-streams-api/authentication | 2026-10-04 | VERIFIED (doc); matched against node:crypto in tests |
| Data Streams feed IDs for BTC/ETH (Monad) | Unknown | needs Chainlink account | — | **BLOCKED** (`config/series.json` holds zero IDs) |
| Chainlink push-feed behaviour at 15m boundaries (real data, last 6 h) | First round at or after T within 120 s: MON 24/24, BTC 9/24, ETH 7/24 | `docs/evidence/phase-2/mainnet-fork-dry-run.md` | 2026-10-04 | VERIFIED (mainnet fork) |
| `@noble/curves` | 1.9.1 (already a viem dependency), used for the TEST-ONLY sync signer | lockfile | 2026-10-04 | VERIFIED |

## Phase 3 additions (strategy and backtest)

| Item | Value | Source | Verified | Status |
|---|---|---|---|---|
| Historical prices, BTC and ETH | Binance spot daily klines, 1 s: `https://data.binance.vision/data/spot/daily/klines/{BTCUSDT,ETHUSDT}/1s/{SYMBOL}-1s-{YYYY-MM-DD}.zip`. 91 days (2026-07-05 to 2026-10-03; the first day warms up the volatility estimator). Open times are µs from 2025-01-01. No key. Each archive verified against the SHA-256 in its `.CHECKSUM` file and pinned in `backtest/data/manifest.json` | https://data.binance.vision, https://github.com/binance/binance-public-data | 2026-10-05 | VERIFIED (downloaded, hashes match) |
| Historical prices, MON | **No Binance spot market** (HTTP 404 for spot 1s and 1m). Only the USDⓈ-M perpetual at 1 m: `futures/um/daily/klines/MONUSDT/1m/`. Used for context only, not for the economic backtest | `curl -I` on the archive URLs | 2026-10-05 | VERIFIED (limitation) |
| Binance data license | Binance Data Collection terms (https://www.binance.com/en/terms): public archives, free to download. Only derived close prices are used; raw archives are git-ignored | data.binance.vision | 2026-10-05 | VERIFIED (doc); not legal advice |
| Chainlink push-feed history | BTC/USD and ETH/USD proxies (addresses above) read round by round with `getRoundData` through Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11` (code present on Monad mainnet). BTC feed was at round 672,347 (phase 1) on 2026-10-05, about one update per 41 s on average. Used to measure the basis and the lag against Binance (`backtest/data/chainlink-basis.json`) | onchain | 2026-10-05 | VERIFIED |
| Chainlink Data Streams history | Needs an API key and secret: not available. The Binance-to-Streams information lead is therefore **unmeasured** | `docs/EXTERNAL.md` Phase 2 rows | 2026-10-05 | **BLOCKED** (needs Nisarg's Data Streams key) |
| `fast-check` | 4.10.2 (property tests), `@vitest/coverage-v8` 2.1.9 (coverage gate) | npm | 2026-10-05 | VERIFIED |
| `@resvg/resvg-js` | 2.6.2 (SVG to PNG for the report charts, prebuilt binaries; DejaVu Sans bundled in `backtest/assets/fonts`) | npm, https://dejavu-fonts.github.io/License.html | 2026-10-05 | VERIFIED |

## Phase 4 additions (vault)

| Item | Value | Source | Verified | Status |
|---|---|---|---|---|
| Solady `FixedPointMathLib` | v0.1.26, commit `acd959aa4bd04720d640bf4e6a5c71037510cc4b`, vendored as one file plus its MIT licence in `contracts/lib/solady/` (used for `lnWad`, `expWad`, `sqrtWad`, `mulWad`, `fullMulDiv`) | https://github.com/Vectorized/solady | 2026-10-05 | VERIFIED (vendored, licence kept) |
| Normal CDF approximation | West (2005), Hart (1968) double-precision algorithm, evaluated in WAD fixed point. Max absolute error against the TS float reference is asserted in `contracts/test/QuoteMath.t.sol` over 600 golden vectors | Graeme West, "Better approximations to cumulative normal functions", Wilmott 2005 | 2026-10-05 | VERIFIED (parity-tested) |
| Mainnet-fork tests | Monad mainnet RPC (`MONAD_MAINNET_RPC_URL`), real USDC (`0x754704Bc059F8C67012fEd69BC8A327a5aafb603`), see ADR-003 | ADR-003 | 2026-10-05 | VERIFIED (ADR-003) |
| Monad max contract size | 128 KB (Ethereum: 24.5 KB). `ConvergeVault` is about 36 KB; `foundry.toml` sets `code_size_limit = 131072` so tests match the chain | https://docs.monad.xyz/developer-essentials/summary ("Max contract size: 128 kb") | 2026-10-05 | VERIFIED |
