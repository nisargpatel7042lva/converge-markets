# ADR-008: Liquidity-as-a-service for partner markets

- Status: Accepted (Phase 8). Governance parameters are defaults for the testnet demo; the mainnet values are a decision for Nisarg.
- Date: 2026-10-07
- Builds on: ADR-004 (forward-priced execution), ADR-005 (vault), ADR-006 (keeper)

## Context

Other Monad apps want a prediction market with depth without building a market maker. The request: an app creates a market from an approved template and the Converge Vault quotes it at once, under strict caps. The example is "Will ETH be above $X at 20:00 UTC?".

The v1 market stack cannot express that market and is immutable by rule:

- `MarketFactory.createMarket` only accepts the 15 minute and 1 hour grid with aligned starts.
- `Market.open` reads the strike from the oracle at `startTime`; there is no fixed strike.
- `ConvergeVault.factory` is immutable and every market the vault accepts must satisfy `factory.getMarket(asset, duration, start) == market`.

## Decision

1. **A second market source, not a change to the first.** `PartnerRegistry` clones the same `Market` and `OutcomeToken` implementations and is the market's `factory` (it answers `paused()` and `feeRecipient()`). `Market` is untouched, so the audited settlement, redeem, merge and INVALID logic is exactly what partner markets use.
2. **The strike is pinned by a per-market resolver.** `ThresholdResolver` (an EIP-1167 clone per market) answers the START boundary with the creator's strike (FINAL) and forwards every other boundary, in particular the END price, to the asset's real `DataStreamsResolver`. The end price therefore goes through the canonical-report rule, the finalization window and the UNRESOLVABLE-to-INVALID path unchanged. The market is created already OPEN (start = creation block), so it can be quoted in the same block.
3. **The vault gains a one-time registry link and caps, nothing else.** `setPartnerRegistry` (owner, once). `_checkMarket` accepts a core market or a registry market. A partner market keeps its real `assetId`, so sigma, marks, NAV, settlement planning and the epoch rules are the existing ones. New enforcement, in the vault and not in the registry:
   - **per partner**: sum of the positive `basis` (collateral split minus merged back) over that partner's registered markets, plus the new split, must be at most the partner's `exposureCap` from the registry;
   - **global**: the same sum over all partner markets must be at most `min(registry.globalExposureCap, maxPartnerFraction x lower NAV)`; `maxPartnerFraction` defaults to 10 % and has a hard ceiling of 30 % in the vault code, so a registry misconfiguration cannot allocate more than that;
   - **slots**: at most `MAX_PARTNER_MARKETS = 6` of the 16 registry slots, and `MAX_MARKETS_PER_PARTNER = 3` of those for one partner, so partner markets cannot crowd the core rounds out and one partner cannot hold them all;
   - the existing per-market (30 % NAV), total-inventory (50 % NAV), loss-ceiling (1 % per market, 8 % total) and breaker limits all still apply to partner markets;
   - **status**: `registry.limits(market).active` must hold for new allocation, for quoting (`venueView`) and for fills (`venueFill`). Merging, redeeming and every user exit are never gated.
4. **Registry link is trusted, and bounded.** The registry is set by the owner and cannot be replaced (a new registry is a new vault, as for the factory). Because the registry decides caps, the vault adds its own fraction-of-NAV ceiling above, which the registry cannot raise.
5. **Governance (documented, owner = Safe on mainnet).** The owner approves partners with a cap, a fee share and a feed allowlist; onboards feeds (a feed must be configured on the oracle resolver, enabled in the core factory and enabled in the vault, otherwise no depth); sets the minimum bond, global cap and redeem fee; may `slash` a bond for invalid markets (to the vault, so LPs are compensated, or the treasury) and `voidMarket` (stop the vault quoting one market). The guardian can pause creation and suspend a partner, nothing else. A void or a suspension cannot change a market or stop merge/redeem: it only stops the vault from adding or quoting.
6. **Bonds.** A partner posts collateral; creating a market needs `bond >= minBond`. A withdrawal is requested, leaves the active bond immediately, and is payable only after 7 days and after `lastMarketEnd + 1 day`, so every market a partner created can still be judged. A slash takes the active bond first, then a pending withdrawal. A suspended partner cannot withdraw.
7. **Economics.** The partner market carries a redeem fee (default 0.5 %, at most 1 %, snapshotted at creation), paid to the registry by the market, split on `collectFees` by the partner's snapshotted `feeShareBps` (default 30 %); the rest goes to the treasury. The vault's spread stays with LPs; no spread share in v1.

## Alternatives considered

- **Add durations and a strike override to `MarketFactory` / `Market`.** Rejected: v1 contracts are immutable and internally reviewed (no external audit yet); a new market class inside them would be a redeploy of everything, and the grid is the basis of the epoch alignment guarantee.
- **Synthetic asset ids per strike.** Rejected: the vault, the venue and the keeper all key marks and sigma on `assetId`; a per-strike id would need per-strike feeds and would break NAV marking.
- **A vault constructor parameter for the registry.** Rejected only for blast radius: it would change the constructor of every vault test suite. A one-time setter has the same trust properties (set once by the owner).
- **Caps stored in the vault by the owner instead of the registry.** Rejected: partner terms (cap, fee share, feeds, bond) belong together, and the vault enforces them without trusting the registry for accounting: it recomputes exposure from its own position table at every split.

## Consequences

- The vault bytecode changes: **a new vault (v4) and a new venue are deployed on testnet** (precedent: v2 to v3), and the keeper, indexer, SDK and app are re-pointed. Vault v3 is archived in `deployments/testnet.json`.
- The vault holds inventory in markets that can last up to 7 days. The caps bound this (a partner can never have the vault split more than its cap into its markets; all partners together at most 10 % of NAV by default; directional trading loss is bounded by the loss ceilings, not by the cap), but LP redemptions are paid from free liquidity, so a larger partner allocation reduces how much can be redeemed in one epoch. The existing mechanics (pro-rata fill, requeue) apply unchanged.
- **Open risks, stated plainly:** (a) a partner can pick an absurd strike; the vault then prices near the bounds (0.02 / 0.98) and the loss ceilings bound what it can lose, the bond and `voidMarket` are the remedy, not a prevention. (b) A feed outage at a partner market's end leaves it PENDING for up to the oracle grace (30 minutes) which can make an epoch settlement expire (the same as for a core round); the vault then refunds deposits and requeues redemptions rather than pricing late. (c) "Any Chainlink feed" means any Data Streams feed the owner onboarded; each is three owner calls. Chainlink's v3 reports carry the price to 8 or 18 decimals depending on the stream; the vault and the markets assume 18 (as the core markets always did), so only 18-decimal streams can be onboarded and the owner must check this per feed. (d) The owner is a single trust anchor for approvals, slashes and voids; there is no dispute process in v1.

## Needs from Nisarg

1. Mainnet governance values: min bond, per-partner caps, global cap, the redeem fee and the partner fee share (defaults here are testnet values).
2. Whether slashed bonds go to the vault (default in the demo) or the treasury.
3. Which feeds to onboard first (each needs a real Data Streams feed id on mainnet).

## Review follow-ups (Phase 8 hostile review)

- A strike far above the spot made `QuoteMath.d2` call `lnWad(0)` and revert; one donated outcome token then froze every NAV computation touching the market. Fixed in `d2` (saturates to certain DOWN), the registry bounds strikes to `int192.max`, the keeper funds only strikes within 5x of the spot, and a regression test reproduces the freeze (`test_absurdStrikeCannotFreezeTheVault`).
- `Market.claimFees` is permissionless and pays the registry: `collectFees` now credits the market's reported accrual, tracks `liabilities`, and strays are swept to the treasury. Fee shares are pulled (`withdrawFees`), including the treasury's.
- Ended partner markets stay in the registry's candidate list for an hour so the keeper can submit their end price; the keeper also resolves a partner market the vault traded in and then emptied.
- SDK log scans are split into windows of at most 90 blocks (Monad's public RPC allows 100).
