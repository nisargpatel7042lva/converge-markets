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
| Monad testnet deployment (Phase 1/2 stack, `deployments/testnet.json`) | factory `0x6d3C829CbE58c53625b714d19E49cE1D41e66639`, tUSDC (open-mint test token, 6 dp) `0x9dedC1B054a0e53777df49722D1Aa20354edB100`, Data Streams resolver `0x0B1122271A5103193E17A31543De274474a4f10D` with `MockStreamsVerifierProxy` `0x1a1d91c243D6c9580694f0A5C444Ca730C6E93CA` (TEST-ONLY signer `0x26F6BC36b8e028A0e9F1018C272cDaBc84D1B149`), scheduler receiver `0x92e749013cd31a43EBd41FfEe96Ce95E58008322`. Deployed 2026-10-05 by `contracts/script/deploy.sh` | onchain, tx hashes in `deployments/testnet.json` | 2026-10-05 | VERIFIED (deployed) |
| Monad testnet deployment (Phase 4 vault) | `ConvergeVault` `0xbEaf85D2682BAD7ca09fD869037065350cF4a3b5`, `ForwardVenue` `0x28dbCf1631f51c9021D999B46e5D9439B4eD913C` (v3 with `keeperHalt`, block 68644575; earlier deployments are archived in `deployments/testnet.json` as `vault_v1_pre_audit` and `vault_v2_pre_halt`), keeper `0x6E5008e79b3F6bcF314467C8B325B3784a9e9AF4`, owner/guardian/treasury = deployer. Deployed 2026-10-06 by `contracts/script/deploy-vault.sh` | onchain, tx hashes in `deployments/testnet.json` | 2026-10-05 | VERIFIED (deployed) |
| Monad testnet gas | gas price about 102 gwei (`eth_gasPrice`), the two deploy scripts cost about 1.35 MON (stack) and 1.6 MON (vault + venue) | `cast gas-price` / balance deltas | 2026-10-05 | VERIFIED |
| Data Streams report timestamps and windows | v3 `validFromTimestamp` / `observationsTimestamp` are uint32 seconds; windows are contiguous with no overlap (Chainlink guarantee used by ADR-002 and relied on by ADR-004/005) | https://docs.chain.link/data-streams/how-report-timestamps-work (read 2026-10-04 for ADR-002) | 2026-10-04 | VERIFIED (doc); residual risk R1 in the threat model |
| Real VerifierProxy rejects an unsigned/forged payload | `verify` reverts `VerifierNotFound(0x00..00)` on the Monad mainnet fork for a payload that is not a DON-signed report | `contracts/test/fork/VaultFork.t.sol::test_fork_realVerifierRejectsForgedReports` | 2026-10-05 | VERIFIED (fork) |
| Foundry | forge 1.8.4 (CI pins the same); `code_size_limit = 131072` in `contracts/foundry.toml`; Monad mainnet forks need `--rpc-url` on the CLI (`vm.createSelectFork` is refused for the `monad` chain under an `ethereum` EVM) | local run | 2026-10-05 | VERIFIED |

## Phase 6 additions (Envio indexer)

All Envio facts below were read from the v3 docs pages on 2026-10-06 (raw `.md` of https://docs.envio.dev/docs/HyperIndex/<page>) and from the npm package. The v2 API (`networks:`, `Contract.Event.handler(...)`, `TestHelpers.MockDb`) is NOT what v3 uses; nothing here is from memory.

| Item | Value | Source | Verified | Status |
|---|---|---|---|---|
| `envio` npm package | **3.14.0** (`latest`, `next`), engines node >= 22.15, Rust CLI shipped as optional dep `envio-linux-x64` etc.; installs and `envio --help` runs here (node 24.10, pnpm 11.0.8) | `npm view envio`, local install | 2026-10-06 | VERIFIED |
| `config.yaml` format (v3) | top-level `name`, `description`, `contracts: [{name, events: [{event: "<human-readable signature>"}]}]`, `chains: [{id, start_block, contracts: [{name, address, start_block}], rpc, block_lag}]`. A contract with no `address` is registered dynamically. Per-contract `start_block` override. Env interpolation `${ENVIO_X:-default}`. `address_format` (default checksum), `raw_events`, `full_batch_size`, `rollback_on_reorg` (default true) | https://docs.envio.dev/docs/HyperIndex/configuration-file | 2026-10-06 | VERIFIED (doc); exercised by `envio codegen` |
| Handler API (v3) | `import { indexer } from "envio"; indexer.onEvent({contract, event, fields?: {transaction: [...], block: [...]}, where?, wildcard?}, async ({event, context}) => {...})`. `event.params`, `event.srcAddress`, `event.logIndex`, `event.chainId`, `event.block.{number,timestamp,hash}`; transaction fields (e.g. `hash`) only if requested via `fields` (v3.7+) or `field_selection`. Entities: `context.<Entity>.get / getOrThrow / getOrCreate / getWhere({field: {_eq,_gt,_gte,_lt,_lte,_in}}) / set / deleteUnsafe`. Relations set as `<field>_id`. `context.log.info/warn/error`. Handlers run twice (preload) so they must be idempotent | https://docs.envio.dev/docs/HyperIndex/event-handlers | 2026-10-06 | VERIFIED (doc) |
| Dynamic contract registration | `indexer.contractRegister({contract, event}, ({event, context}) => { context.chain.<Contract>.add(address) })`. Contract declared in config without `address`. Events of the new contract in the same block as the registration are included | https://docs.envio.dev/docs/HyperIndex/dynamic-contracts | 2026-10-06 | VERIFIED (doc) |
| Schema | `schema.graphql`: entity types with `id: ID!`, scalars ID/String/Int/Float/Boolean/Bytes/BigInt/BigDecimal/Timestamp/Json, `enum`, `@derivedFrom(field:)`, `@index`, `@internal` (entity kept out of the GraphQL API, v3.8+), `@config(precision, scale)`, descriptions | https://docs.envio.dev/docs/HyperIndex/schema | 2026-10-06 | VERIFIED (doc) |
| Testing | `import { createTestIndexer, TestHelpers } from "envio"`; `indexer.process({chains: {<id>: {simulate: [{contract, event, params, block?, transaction?, srcAddress?, logIndex?}]}}})` feeds synthetic events with no network; `indexer.<Entity>.get/getAll/set`; `result.changes`; `indexer.chains[<id>].<Contract>.addresses` shows dynamic registrations | https://docs.envio.dev/docs/HyperIndex/testing | 2026-10-06 | VERIFIED (doc) |
| HyperSync endpoints | Monad 143: https://143.hypersync.xyz (HyperRPC https://143.rpc.hypersync.xyz). Monad Testnet 10143: https://10143.hypersync.xyz (https://10143.rpc.hypersync.xyz) | https://docs.envio.dev/docs/HyperIndex/supported-networks | 2026-10-06 | VERIFIED (doc) |
| Token requirement | HyperSync and HyperRPC need `ENVIO_API_TOKEN` (HTTP 401 otherwise). **Indexers deployed to Envio Cloud have their own HyperSync access and need no token**; a token is only required when HyperSync is the data source of a self-run indexer. A chain configured with `rpc:` (the documented source for chains without HyperSync) needs no token | https://docs.envio.dev/docs/HyperSync/api-tokens, https://docs.envio.dev/docs/HyperIndex/environment-variables, configuration-file ("RPC") | 2026-10-06 | VERIFIED (doc). Self-run HyperSync backfill **BLOCKED** (no token). Correction of the Phase 0 row: the token is not needed for the hosted deployment |
| Local run | `envio dev` / `envio start` (Docker or Podman for Postgres + Hasura; Hasura console http://localhost:8080, admin secret `testing`; indexer HTTP on `ENVIO_INDEXER_PORT` default 9898 serving `/metrics`, `/healthz`); `envio stop` | https://docs.envio.dev/docs/HyperIndex/running-locally, observability | 2026-10-06 | VERIFIED (doc); exercised locally in T6 |
| GraphQL API | Hasura-style: `query { Market(where: {status: {_eq: OPEN}}, order_by: {endTime: asc}, limit: 20, offset: 0) { id } }`, `Entity_by_pk(id:)`, variable types `String`/`numeric` for ID/BigInt/BigDecimal, endpoint `<endpoint>/v1/graphql`. Optional API-key auth via `Authorization: Bearer <key>` (Envio Cloud paid feature) | https://docs.envio.dev/docs/HyperIndex/query-conversion, hosted-service-features | 2026-10-06 | VERIFIED (doc); shapes re-checked against the local Hasura in T6 |
| Indexing status / lag | GraphQL `_meta { chainId progressBlock sourceBlock bufferBlock eventsProcessed isReady readyAt startBlock endBlock }` (`sourceBlock` = chain head seen by the data source; `progressBlock` = last block written). Prometheus `envio_progress_block`, `envio_progress_ready`, `envio_progress_latency` (ms), `envio_indexing_known_height` | https://docs.envio.dev/docs/HyperIndex/observability | 2026-10-06 | VERIFIED (doc) |
| Envio Cloud deployment | Git-based: log in with GitHub at https://envio.dev/app/login, install the Envio Deployments GitHub App on the repo, "Add Indexer" with config path / root directory / deployment branch, push to that branch. Requirements: `package.json` in the root directory with the `envio` version pinned in dependencies, pnpm compatible with 10.32.0, node 24 recommended, repo <= 100 MB, imports must stay inside the indexer directory (monorepo warning). Development plan: 3 indexers per org, 3 deployments per indexer, soft limits 100,000 events / 5 GB / no requests for 7 days, hard 30 days / 20 GB. Optional `envio-cloud` CLI (alpha, `npm i -g envio-cloud`). Env vars must be prefixed `ENVIO_` | https://docs.envio.dev/docs/HyperIndex/hosted-service-deployment, envio-cloud-cli | 2026-10-06 | VERIFIED (doc). Deployment itself **BLOCKED** (needs Nisarg's Envio account, GitHub App install and a pushed deployment branch; this agent must not push) |
| Reorgs | Automatic rollback on by default (`rollback_on_reorg: true`); handlers need no rollback logic | https://docs.envio.dev/docs/HyperIndex/reorgs-support, configuration-file | 2026-10-06 | VERIFIED (doc) |
| Kuru event ABI | `Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)` (see Kuru rows above, SDK ABI). Not indexed: no Kuru market exists for our rounds (leg blocked) | Phase 0 rows | 2026-10-04 | VERIFIED (ABI); stub only |
| Our contract events | Taken from `contracts/src` (Market, MarketFactory, ConvergeVault, ForwardVenue) and cross-checked by `indexer/test/abi-parity.test.ts` against the generated ABIs (topic0 equality). `packages/sdk/src/abi/generated.ts` predates the keeper halt events (`QuotingHalted`/`QuotingUnhalted`), they are checked against `contracts/out` in `make check-6` | source | 2026-10-06 | VERIFIED |
| Deployed addresses indexed | `marketFactory` 0x6d3C829CbE58c53625b714d19E49cE1D41e66639 (block 68426048), `vault.vault` 0xcd2072443D37397DbEa4e8eADbCcfB8cB1f10748 and `vault.forwardVenue` 0xDf5958c9d759a97B7C3A9e49F8fB0924406698Aa (block 68615979), all read from `deployments/testnet.json` by `indexer/scripts/gen-config.mjs` | deployments/testnet.json | 2026-10-06 | VERIFIED (repo); on-chain state not re-read (public RPC reserved this phase) |
| Mainnet addresses | `deployments/mainnet.json` does not exist (mainnet deploy is Phase 9). `indexer/config.mainnet.yaml` is generated from it when it appears | n/a | 2026-10-06 | **BLOCKED** (nothing deployed on chain 143) |
| Public Monad testnet RPC: `eth_getLogs` range | **Limited to 100 blocks** (`"eth_getLogs is limited to a 100 range"`, observed 2026-10-07 through the rate-limited proxy; 6 rps ceiling) | live (Envio RPC source error log) | 2026-10-07 | VERIFIED (observed). `rpc.initial_block_interval` / `interval_ceiling: 100` avoid the halving retries |
| Envio RPC data source cost | With `rpc: [{for: sync}]` on chain 10143 the indexer needs no token, but it fetches block data as well as logs: measured about **0.33 RPC requests per block** (469 requests for about 1,300 blocks, `docs/evidence/phase-6/rpc-usage-testnet.json`), so at 7 rps a backfill runs at about 20 blocks/s: the 456,000 blocks from the factory deploy (68,426,048) to the head would take about 6 hours. `rollback_on_reorg: false` did not reduce it (measured). `rpc` accepts `polling_interval`, `initial_block_interval`, `interval_ceiling` (`indexer/node_modules/envio/evm.schema.json`, https://docs.envio.dev/docs/HyperIndex/rpc-sync) | https://docs.envio.dev/docs/HyperIndex/rpc-sync, live measurement | 2026-10-07 | VERIFIED. A full RPC-source backfill of testnet is therefore bounded to the vault v3 era; HyperSync (needs the hosted deployment or a token) is the intended source |
| Rate-limit guard | `scripts/reconcile/rpc-proxy.ts`: every client of the public RPC (indexer, reconcile, lag) goes through a proxy with a hard ceiling (default 6-7 rps in total, batches counted per element, retries counted) that records `rpc-usage-testnet.json`; the endpoint answers 429 above 15 rps per IP | scripts/reconcile/rpc-proxy.ts | 2026-10-07 | VERIFIED (run) |


## Phase 5 additions (keeper)

| Item | Value | Source | Verified | Status |
|---|---|---|---|---|
| Monad testnet public RPC rate limit | `https://testnet-rpc.monad.xyz` answers HTTP 200 with a JSON-RPC error `requests limited to 15/sec` (HTTP 429 on bursts) above 15 calls a second, counted per JSON-RPC call and per source IP (the earlier "50 rps" row above is not what the endpoint enforces). Batches of up to 100 calls are accepted. The keeper therefore caps itself at 10 rps and aggregates reads with Multicall3 | measured 2026-10-06 (burst of 60 requests: 429 after about 25; keeper log lines) | 2026-10-06 | VERIFIED (measured) |
| Multicall3 on Monad testnet | canonical `0xcA11bde05977b3631167028862bE2a173976CA11`, code present (`cast code`) | onchain | 2026-10-06 | VERIFIED |
| Monad testnet WebSocket | `wss://testnet-rpc.monad.xyz` delivers `newHeads` (0.4 s blocks) | keeper runs | 2026-10-06 | VERIFIED |
| Binance spot stream | `wss://stream.binance.com:9443/ws/<symbol>@bookTicker`, messages `{"u","s","b","B","a","A"}`, several per second for ETHUSDT, no key; reachable from the build host | https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams, live connection | 2026-10-06 | VERIFIED |
| Coinbase Exchange feed | `wss://ws-feed.exchange.coinbase.com`, subscribe `{"type":"subscribe","product_ids":["ETH-USD"],"channels":["ticker"]}`; `ticker` messages carry `price`, `best_bid`, `best_ask`. They are published on trades: measured over 90 s on ETH-USD, 164 messages, p95 gap 3.7 s, **max gap 7.4 s**, so staleness is configured per source (3 s Binance, 12 s Coinbase) | https://docs.cdp.coinbase.com/exchange/docs/websocket-channels, live measurement | 2026-10-06 | VERIFIED |
| Monad billing | gas **limit** is billed, not gas used (receipts report the limit as `gasUsed` for the keeper's transactions); the keeper uses estimate x 1.15 | receipts in `docs/evidence/phase-5/costs.jsonl` | 2026-10-06 | VERIFIED (observed) |
| `prom-client` 15.1.3, `pino` 9.x, `ws` 8.x, `viem` 2.54.x | keeper runtime dependencies | npm | 2026-10-06 | VERIFIED |
| Prometheus `prom/prometheus:v2.55.1`, Grafana `grafana/grafana:11.3.0` | compose images; the stack was started once, the Grafana API listed the provisioned dashboard and Prometheus showed the keeper target `up` | Docker Hub, local run | 2026-10-06 | VERIFIED (run) |


## Phase 8 additions (liquidity as a service)

| Item | Value | Source | Verified | Status |
|---|---|---|---|---|
| Data Streams v3 price scale | `price`, `bid`, `ask` are `int192` "carried to either 8 or 18 decimal places, depending on the stream" (the benchmark price of crypto streams is 18). The vault and markets assume 18; the partner template can only onboard 18-decimal streams | https://docs.chain.link/data-streams/reference/report-schema-v3 (field list), https://docs.chain.link/data-streams/streams-trade/interfaces (decimals) | 2026-10-07 | VERIFIED (docs); per-feed scale must be checked at onboarding |
| viem Monad testnet chain | `monadTestnet` in `viem/chains` (viem 2.57.2): id 10143, RPC https://testnet-rpc.monad.xyz, Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11` | `node -e "import('viem/chains')"` | 2026-10-07 | VERIFIED (run) |
| Monad testnet gas price | `eth_gasPrice` 102 gwei (`cast gas-price`); Monad bills the gas limit | live RPC, `docs/evidence/phase-5/costs.md` | 2026-10-07 | VERIFIED |
| Phase 8 deployment cost | `forge script DeployPartners` simulated against testnet: **21,158,104 gas** for vault v4 + venue + registry + setup (about 2.16 MON at 102 gwei billed on the limit; forge prints 4.30 MON because it prices at its 203 gwei max fee) | `DRY_RUN=1 bash contracts/script/deploy-partners.sh` | 2026-10-07 | VERIFIED (simulation; nothing sent) |
| Testnet faucet | https://faucet.monad.xyz is web-only (HTTP 429 to curl), so funding the 2.2+ MON for the deployment cannot be scripted | docs/EXTERNAL.md Monad table | 2026-10-04 | VERIFIED; deployer holds 0.26 MON on 2026-10-07 => testnet deployment **BLOCKED** |
| `tsup` 8.5.1 | builds the published SDK (ESM + d.ts); `pnpm pack` applies `publishConfig` (main/types/exports) | npm, `packages/sdk/scripts/check-pack.mjs` | 2026-10-07 | VERIFIED (run) |
| Next.js 16.4.0, React 19.3.0 | same versions as apps/web; `next build` of examples/partner-demo succeeds | apps/web/package.json, local build | 2026-10-07 | VERIFIED (run) |
| Node `process.loadEnvFile` | used by the demo CLIs to read `.env` without printing it (Node 24.10 here, engines >=22.13) | Node docs | 2026-10-07 | VERIFIED (run) |
