# Phase 8 plan: liquidity-as-a-service for other Monad apps

Goal (prompt): a third-party app can create a market from an approved template and get instant two-sided depth from the Converge Vault, under strict caps. Small but real.

## Orientation: what exists and what that means

- **The v1 market stack cannot express the requested template.** `MarketFactory.createMarket` only accepts the 15 m / 1 h grid, aligned starts, and `Market.open` takes the strike from the oracle at `startTime`. "ETH above $X at 20:00 UTC" has a fixed strike, an arbitrary end and a start of "now". `MarketFactory`, `Market` and the vault's `factory` are immutable (v1 rule), so the template is added **beside** them, not inside them.
- **No change to `Market`.** `Market` takes its resolver from `Params`; a market-specific resolver can pin the strike. `ThresholdResolver` (one EIP-1167 clone per market) answers `checkpoint(asset, startTime)` with FINAL and the partner's strike, and forwards every other boundary (the end) to the asset's real resolver (`DataStreamsResolver`). Resolution of the end price is therefore exactly the audited path (canonical Data Streams report, finalization window, UNRESOLVABLE to INVALID at 0.5).
- **`PartnerRegistry` is the second market factory.** It clones the same `Market` and `OutcomeToken` implementations, so `Market.factory` is the registry (it implements `paused()` and `feeRecipient()`), and it creates the market already OPEN (start = creation block, strike pinned), which is what makes quotes appear within two blocks.
- **The vault's registry check must change, so there is a vault v4 and a testnet redeploy** (precedent: v2 to v3). The immutable `factory.getMarket(...)` check cannot accept a market from another factory. v4 adds a one-time `setPartnerRegistry` (a constructor change would break 12 existing test suites for no reason), a second branch in `_checkMarket`, caps in `splitForInventory`, a partner status gate on new splits / quoting, and a limit on how many registry slots partner markets can use. Nothing else in the vault changes: the market keeps its real `assetId`, so marks, sigma, NAV and settlement are untouched.
- **Caps are enforced in the vault, not trusted from the registry's bookkeeping.** Exposure of a partner = sum of the positive `basis` (collateral split minus merged back) over its registered markets, computed from the vault's own position table at split time. The registry only stores the numbers the owner set.
- **Keeper / scheduler / indexer / app discover markets from the grid** (`factory.getMarket(asset, duration, start)`); partner markets are not on a grid. They need a second source: the registry's market list and `PartnerMarketCreated` event.

## Design decisions (all revisable, stated so the review can attack them)

1. **Template** = "price threshold": UP iff `price(end) >= strike` (ties UP, as in v1). `assetId` must be a feed the owner has enabled for partners (`setFeed`): configured on the Data Streams resolver, enabled in the core factory (label) and enabled in the vault (otherwise no depth). Duration 15 m to 7 d, `end = now + duration` or any end in range. "Any Chainlink feed" is therefore "any Data Streams feed the owner has onboarded"; onboarding is three owner calls, documented. Push feeds (`ChainlinkRoundResolver`) are not supported for vault depth (the vault is Data Streams only).
2. **Strike scale** is the resolver's price scale (Data Streams v3: 18 decimals). The SDK converts decimal strings.
3. **Partner lifecycle**: owner `approvePartner(partner, exposureCap, feeShareBps, assets[])`; partner `postBond(amount)`; creating needs approved + not suspended + bond >= `minBond` + asset allowed. Bond withdrawal: request, 7 d delay, and not before `lastMarketEnd + CHALLENGE_PERIOD` (24 h) so that every market the partner created can still be judged. The owner can `slash(partner, amount, reason)` (to the vault, as a donation to LPs), `suspendPartner` (no new markets, no new allocation, and the vault stops quoting the partner's markets; inventory is merged by the keeper as usual) and `voidMarket` (stop quoting one market). Users can always merge/redeem: nothing here touches `Market.merge/redeem`.
4. **Caps**: per partner (`exposureCap`, asset units), global partner (`globalExposureCap`), both enforced at `splitForInventory`; the existing per-market (30 % NAV) and total inventory (50 % NAV) caps still apply; a new constant `MAX_PARTNER_MARKETS = 6` bounds the registry slots partner markets can take (of 16). Merging is always allowed so exposure falls as inventory is merged.
5. **Economics**: the redeem fee (per market, snapshotted, <= 1 %, owner sets the registry's default) accrues in the `Market` to the registry (its `feeRecipient()`); `collectFees(market)` pulls it and splits it `feeShareBps` to the partner, the rest to the treasury. The vault's spread income stays with LPs (no partner share of spread in v1; stated in the guide).
6. **Keeper pickup**: the keeper reads `PartnerRegistry.marketCount/marketAt` as one more source of candidate markets, sizes splits against the remaining partner cap, and the existing quoting/execution loop is unchanged. The scheduler resolves partner markets after their end (permissionless `resolve`, same as core).

## Tasks and the acceptance criteria they serve

| # | Task | AC |
|---|---|---|
| T1 | `ThresholdResolver` (clone, pinned strike) + unit tests | 1 |
| T2 | `PartnerRegistry` (partners, bonds, templates/feeds, creation, caps storage, slashing, suspension, void, fee split) + unit tests | 1, 3 |
| T3 | Vault v4: `setPartnerRegistry`, `_checkMarket` branch, per-partner / global caps, `MAX_PARTNER_MARKETS`, status gate in `venueView`/`venueFill`/split; tests incl. cap enforcement, a partner that tries to exceed its cap by many markets, suspension, slashing, NAV with a pinned-strike market, full create / quote / trade / resolve / redeem | 1, 3 |
| T4 | Invariant / fuzz: partner exposure never exceeds its cap under a hostile keeper | 3 |
| T5 | Keeper: discover partner markets, cap-aware split sizing, tests | 2 |
| T6 | Indexer: registry events, `Market.partner/strike/template`, fills of partner markets, tests | 2 |
| T7 | SDK public API (`createPartnerMarket`, `getMarket`, `getQuotes`, `buy`, `sell`, `redeem`, `subscribeFills`), TSDoc, publish-ready package.json, README with a 20-line quickstart, tests | 1 |
| T8 | `examples/partner-demo` (Next.js, public SDK only; a check proves no deep imports) | 2 |
| T9 | `docs/partners.md`, ADR-008, EXTERNAL.md, threat-model addendum | 4 |
| T10 | Deploy v4 + registry + venue on testnet (funding permitting), run the demo end to end, save evidence; otherwise anvil with the real contracts and keeper, labelled as such | 2 |
| T11 | `make check-8`, hostile review, fixes, report, STATUS, memory | 1, 4 |

## Assumptions

1. Testnet funds: the deployer and keeper hold little MON (about 0.28 and 0.04 at the end of Phase 7). A vault + venue + registry deployment may not fit; if it does not, the testnet demo is blocked and reported, and the same script runs on a local anvil with the real contracts and keeper (labelled as local, not testnet).
2. The testnet Data Streams verifier is the mock (any feed id verifies with the test signer), so "any feed" is demonstrable on testnet only against the mock; on mainnet each feed needs a real Chainlink feed id.
3. Collateral is the vault's collateral (tUSDC on testnet, USDC on mainnet); bonds are in the same token.
