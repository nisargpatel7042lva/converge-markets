# Converge for partners: liquidity as a service

Another Monad app can put a prediction market on its own page and get two-sided depth from the Converge Vault on day one, without building a market maker. This is the integration guide, the economics and the risk limits. The design decisions are in [ADR-008](adr/ADR-008-partner-liquidity.md); the SDK is in [packages/sdk](../packages/sdk/README.md); a working page is in [examples/partner-demo](../examples/partner-demo/README.md).

**Status (2026-10-07).** Built and tested; demonstrated end to end on a local chain with the real contracts and keeper. **The testnet deployment is not done:** it needs about 2.2 MON of gas for the contracts alone and the deployer holds 0.26 (see the Phase 8 report). Everything below describes what the contracts do, and the numbers are the testnet demo values unless it says otherwise.

## 1. What a partner gets

- A market of the form **"will ASSET be at or above STRIKE at END?"** (a price-threshold market). You choose the feed, the strike and the end (15 minutes to 7 days from now). The market is created open, in one transaction, by your own account.
- **Instant two-sided depth.** The vault's keeper puts liquidity into your market and the vault quotes both outcomes, re-priced from the oracle at every trade. On a local chain this happened one block after creation.
- **Settlement you do not run.** The end price is the Chainlink Data Streams report whose window contains the end time, through the same audited path as the core 15 minute and 1 hour markets. If the oracle cannot produce it the market is invalid and every share pays 50 cents.
- **A share of the fees** on winning payouts, paid to your account.
- **Users who can always get out.** Nothing in the programme can stop a holder from redeeming a resolved market or merging a pair.

## 2. How it works

```
 your app ──createThresholdMarket──▶ PartnerRegistry ──clones──▶ Market (OPEN, strike pinned)
                                          │                      UP / DOWN tokens
                                          │ limits(market)       ThresholdResolver (strike now, oracle at the end)
                                          ▼
 keeper ──splitForInventory──▶ ConvergeVault ◀── checks: partner cap, global cap, 10% of NAV, slots
                                   │ quotes (ForwardVenue.quoteAt)
 your users ──buy / sell──▶ ForwardVenue ──executed ~2 s later at the oracle price──▶ ConvergeVault.venueFill
                                   │
 anyone ──resolve (end price)──▶ Market ──redeem──▶ winners;  vault.redeemResolved ──▶ inventory back
```

1. **Create.** `PartnerRegistry.createThresholdMarket(feed, strike, end)` clones a standard `Market` and its two outcome tokens plus a one-market `ThresholdResolver` that answers the start boundary with your strike and forwards the end boundary to the feed's real resolver. It emits `MarketCreated` (the same event the core factory emits) and `PartnerMarketCreated`, then opens the market.
2. **Allocate.** The keeper reads the registry's live markets and calls `ConvergeVault.splitForInventory` for each, sized inside the caps in section 5. The vault recomputes every cap from its own position table; it does not trust the registry's bookkeeping.
3. **Trade.** A buy or sell is an order on the `ForwardVenue`. About two seconds later a keeper executes it at the oracle report for that second. The limit price (slippage) is the user's protection.
4. **Resolve.** After the end, anyone submits the oracle report and, after the oracle's finalization window, finalizes. The vault's keeper does this for every market it holds inventory in; your app or any user can do it with `resolve()` in the SDK.
5. **Redeem.** Winners call `redeem()`. The vault calls `redeemResolved` and its collateral returns to free liquidity, which also frees your cap for your next market.

## 3. Becoming a partner

| Step | Who | What |
| --- | --- | --- |
| 1 | You | Send the owner your account address and the feeds you want. |
| 2 | Owner | `approvePartner(partner, exposureCap, feeShareBps, [feeds])`: your cap, your fee share and the feeds you may use. A feed must already be onboarded (below). |
| 3 | You | `postBond(amount)` in the vault's collateral. Creating markets needs a bond of at least `minBond`. |
| 4 | You | `createThresholdMarket(...)`. |

Testnet demo terms (a decision for mainnet, see "Needs from the owner" in the Phase 8 report): minimum bond 10 USDC, your cap 40 USDC, all partners together 500 USDC, redeem fee 0.5 %, your share of it 30 %.

**Onboarding a feed** (owner, three calls; "any Chainlink feed" means any Data Streams feed the owner has done this for):

```sh
# 1. map the asset to its Data Streams feed id on the oracle resolver (one time, immutable)
cast send $STREAMS_RESOLVER "configureAsset(bytes32,bytes32)" $ASSET_ID $FEED_ID
# 2. enable it in the core factory (label, resolver)
cast send $FACTORY "setAsset(bytes32,address,string,bool)" $ASSET_ID $STREAMS_RESOLVER "ETH" true
# 3. enable it in the vault with a volatility band, then in the registry
cast send $VAULT "enableAsset(bytes32,uint256,uint256)" $ASSET_ID 0.4e18 1.2e18
cast send $REGISTRY "setFeed(bytes32,bool)" $ASSET_ID true
```

`setFeed` refuses a feed the vault has not enabled: a partner market with no depth would be a broken promise.

## 4. Integrating

```sh
pnpm add @converge/sdk viem
```

The 20-line quickstart is in the [SDK README](../packages/sdk/README.md). The calls, in the order a page uses them:

| You want to | Call |
| --- | --- |
| Check you can create | `getPartner()` (`canCreate`, cap, bond, fees owed) |
| Create the market | `createPartnerMarket({ asset: "ETH/USD", strike: "3200", end })` |
| Show the market | `getMarket(market)` (strike, end, phase, `quoting`) |
| Show prices and depth | `getQuotes(market, { spot })` (bid, ask and size for UP and DOWN) |
| Let a user bet | `buy({ market, side, amount, spot, slippageBps })`, then `waitForFill(orderId)` |
| Let a user sell | `sell({ market, side, shares, spot })` |
| Show a live tape | `subscribeFills({ market }, onFill)` (the indexer if configured, else on-chain events) |
| Settle | `resolve(market, { reports })`, then users call `redeem(market)` |
| Collect your fees | `withdrawFees()` |

**Strike and prices.** The strike is in the oracle's price scale and the SDK scales a decimal string to 18 decimals. Chainlink's v3 reports carry the price to **8 or 18 decimals depending on the stream**; the vault prices everything in 18-decimal WAD (the same assumption as for the core markets), so **only 18-decimal streams can be onboarded**. The owner must check the stream's scale when onboarding a feed. Prices in the API are 0 to 1; a winning share pays 1.00.

**Errors you will meet** (the SDK simulates first and returns the contract's error name):

| Error | Meaning |
| --- | --- |
| `NotApproved` | The owner has not approved this account. |
| `PartnerIsSuspended` | The guardian or owner suspended you. |
| `BondTooLow` | Your active bond is below `minBond` (a withdrawal request lowers it at once). |
| `FeedNotAllowed` / `FeedNotEnabled` | The feed is not in your allowlist / not onboarded. |
| `InvalidDuration` | The end is less than 15 minutes or more than 7 days from the block that includes your transaction. Leave a margin. |
| `InvalidStrike` | The strike is not positive. |
| `TooManyLiveMarkets` | You already have 8 markets that have not ended. |
| `EnforcedPause` | Creation is paused. |

**Running the demo page.** `examples/partner-demo` is a Next.js page that embeds one market with depth, a demo account or a browser wallet, buy buttons showing the price and the dollars behind them, the live fills, and the redeem button after settlement. It imports only react, next, viem and the root of `@converge/sdk` (a script checks this). Set `NEXT_PUBLIC_REGISTRY`, `NEXT_PUBLIC_VAULT`, `NEXT_PUBLIC_VENUE`, `NEXT_PUBLIC_COLLATERAL`, `NEXT_PUBLIC_MARKET` (and `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_CHAIN_ID` for a chain other than Monad testnet).

**Resolution in practice.** The vault's keeper resolves every market in which the vault holds inventory. A market the vault never funded (for example because your cap was used up) is yours to resolve: call `resolve()` after the end, or ask any user to. Resolution needs a Data Streams report for the end time: on mainnet from Chainlink's API with your credentials; on testnet the oracle is a mock verifier and the SDK's `TestSignerStreamsSource` signs the report.

## 5. Economics

**Your revenue: a share of the redeem fee.** Every winning payout of a partner market pays a fee of `redeemFeeBps` (testnet 0.5 %, hard cap 1 %, fixed when the market is created). The market pays it to the registry; `collectFees(market)` (anyone may call) splits it by your **fee share, snapshotted at creation** (testnet 30 %) between you (`feesOwed`, withdrawn with `withdrawFees`) and the treasury.

| Winning payouts on your markets | Fee at 0.5 % | You (30 %) | Treasury (70 %) |
| --- | --- | --- | --- |
| $1,000 | $5 | $1.50 | $3.50 |
| $100,000 | $500 | $150 | $350 |
| $10,000,000 | $50,000 | $15,000 | $35,000 |

Losing shares pay no fee, so the fee base is the winners' payout, about half the notional traded in a balanced market. The fee is charged on every redeemed winning payout, **the vault's own included** (its leftover winning tokens); pairs the vault merges back pay nothing. The vault's NAV already values its winning leftovers net of the fee, so this is a known, small cost to LPs and not a surprise.

**What the vault earns, and what you do not.** LPs earn the spread: at least 5 cents each side at launch parameters, widening with volatility and inventory. **Partners do not share the spread in v1.** It is the LPs' compensation for taking the risk, and a spread share would reward a partner for creating markets that are good for the partner and bad for the vault.

**What you pay.** The gas to create a market: about 0.95 million gas (measured, `forge` gas report), which is roughly 0.11 MON per market at Monad testnet's 102 gwei billed on the gas limit with a 15 % margin. A bond that stays locked while you operate and for 24 hours after your last market ends. Nothing else; the vault's keeper pays its own gas.

**Why the economics hold.** Traders pay the fee when they collect, and the LPs' income is the spread on the extra volume. What partner markets cost LPs is bounded by the caps below: the capital they tie up, and the fee the vault pays on its own winning leftovers.

## 6. Risk limits

Everything here is enforced in code and covered by tests (`PartnerRegistry.t.sol`, `VaultPartners.t.sol`, `PartnerCapInvariants.t.sol`).

| Limit | Value | Enforced by |
| --- | --- | --- |
| Exposure per partner (collateral the vault may have split into all your markets at once) | owner-set; testnet 40 USDC | vault, on every `splitForInventory`, from its own position table |
| Exposure of all partners together | owner-set in the registry (testnet 500 USDC) **and** `maxPartnerFraction` of NAV (default 10 %, hard ceiling 30 % in the code); the lower applies | vault |
| Registry slots partner markets can use | 6 of 16 | vault |
| Markets per partner that have not ended | 8 | registry |
| Duration | 15 minutes to 7 days | registry |
| Per-market allocation | 30 % of NAV | vault (unchanged) |
| All inventory | 50 % of NAV | vault (unchanged) |
| Loss per market / all markets | 1 % / 8 % of NAV | vault (unchanged): fills beyond it are refused |
| Daily drawdown | 5 % of share price pauses quoting | vault (unchanged) |
| Redeem fee | at most 1 % | registry |
| Bond withdrawal | 7 days notice, and not before 24 hours after your last market ended; blocked while suspended | registry |
| Who can pause or suspend | guardian or owner | registry |
| Who can approve, set caps, onboard feeds, slash, void | owner only (a Safe on mainnet) | registry |

**The worst case for LPs from one partner is its exposure cap**: the vault cannot lose more on a market than the collateral it put into it, and the loss ceiling stops quoting well before that. The invariant suite runs a keeper that asks for arbitrary amounts, with caps changing under it, suspensions and voids, and checks after every accepted allocation that no cap is exceeded.

**Governance** (documented, centralised in v1):

- The owner can **slash** a partner's bond (the active bond first, then a pending withdrawal) for invalid markets: a misdescribed feed or strike, a market built to harm LPs, a market that cannot be resolved. The slash goes to the vault by default, so LPs are compensated first, and carries a hash of a public write-up. The slash is discretionary; there is no dispute process in v1.
- The owner can **void** one market: the vault stops allocating to it and quoting it. Voiding does not change the market, does not refund anyone, and does not stop merge or redeem.
- The guardian or owner can **suspend** a partner: no new markets, no new allocation, no quoting of its markets, no bond withdrawal. Only the owner lifts it.
- The owner can **never** touch a user's tokens, change a market's terms or outcome, or block `redeem` and `merge`.

**What the limits do not protect against** (stated plainly):

1. **A strike nobody should have chosen.** The registry accepts any positive strike: a partner can create "ETH above $1" or "ETH above $1,000,000". The vault then prices near its 2 cent and 98 cent bounds and the loss ceilings bound what it can lose; the bond and `voidMarket` are the remedy, not a prevention. The bond is typically smaller than a worst-case loss.
2. **An oracle outage at the end.** If no report arrives within the oracle's grace (30 minutes on testnet) the market becomes invalid and pays 50 cents. Until then it is unresolved, which can make an LP settlement epoch expire (the vault then refunds deposits and requeues redemptions instead of pricing late).
3. **Liquidity locked for up to 7 days.** Inventory in a long-dated market is not available to LP redemptions until it is merged or the market resolves. The caps bound how much; the keeper merges pairs as a redemption shortfall appears.
4. **One trust anchor.** The owner approves, slashes and voids; a bad or compromised owner can harm partners (not users' tokens). On mainnet the owner is a Safe multisig.
5. **Testnet oracle.** The testnet Data Streams verifier is a mock with a test signer: any feed id works there, and whoever holds the signer decides prices. Mainnet needs a real feed id per asset.

## 7. Operating it

- **Deploying** (`contracts/script/deploy-partners.sh`, testnet only): vault v4, a new venue and the registry, with the previous vault archived in `deployments/<net>.json`. `DRY_RUN=1` simulates and prints the gas. A vault cannot be upgraded, so adopting the registry is a redeploy and an LP migration (as v2 to v3 was).
- **Keeper.** No configuration: it reads `vault.partnerRegistry()` and picks up the registry's live markets, mirrors the caps when it sizes a split (so it never sends an allocation the vault would refuse), lets core markets take liquidity first, and resolves ended partner markets by submitting the end report.
- **Indexer.** Follows the registry the vault announces (`PartnerRegistrySet`): markets carry their `partner` and `voided` flag; the `Partner` entity tracks caps, bond, pending withdrawals, slashes and fees.
- **Alerts to wire before mainnet.** Slash and void events, a partner whose cap has been used for over a day, a partner market ending without a resolution after 10 minutes.

## 8. FAQ

**Can I make a market on a feed that is not onboarded?** No. Ask the owner to onboard it (section 3); on mainnet the feed must be a real Data Streams feed.

**Can I make one that ends in 5 minutes?** No: 15 minutes to 7 days. The 15 minute floor matches the oracle's finalization and the vault's no-quote window.

**Who pays the keeper's gas?** The vault's operator. Executing a user's order is paid by the reward the user attaches to the order (0.001 MON on testnet).

**What if the vault does not quote my market?** `getMarket().quoting` is false when your cap or the global cap is used, the slots are full, the vault is halted or paused, or the market is inside its last 30 seconds. `getQuotes().quoting` is the same flag for the ladder.

**Can I list the same strike and end twice?** Yes; each market is a separate contract. The limit is 8 markets that have not ended.
