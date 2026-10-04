# Kuru feasibility spike (Phase 0)

**Status:**

- **Ran end to end on an anvil fork of Monad testnet.** It used the real Kuru contracts, but with Ethereum's gas schedule.
- **Post, cancel and re-quote gas were cross-checked against real Monad mainnet** using `eth_estimateGas`. Cancels were estimated at a historical block where a maker's orders were live (`scripts/spike/monad-gas-estimates.sh`).
- **The live-testnet run is BLOCKED.** Deployer `0xe36848e8654a86Fd2F7f97DDB3C56042fFD54dd1` has 0 MON, and the faucet is web-only.
- **Mainnet market creation is owner-gated** (see "Limits").

Files:

- Script: `scripts/spike/src/kuru-spike.ts` (ABIs from `@kuru-labs/kuru-sdk@0.0.95`, addresses from docs.kuru.io). Every step asserts the expected OrderCreated/OrdersCanceled counts, so the run aborts if order tracking drifts.
- Raw output: `kuru-spike-fork.json`. Fork costs are repriced at 102 gwei because the anvil base fee decays.
- Cost table: `kuru-cost-model.txt` (`pnpm --filter @converge/spike report`).
- Real-chain checks: `external-onchain-checks.txt`, `monad-gas-estimates.txt`.

## What was done

1. Deployed open-mint collateral (6 dp) and an outcome token (18 dp) (`contracts/script/spike/SpikeToken.sol`, test only).
2. Created a Kuru market UP/collateral with `Router.deployProxy` from a plain EOA.
   - Params came from SDK `calculatePrecisions(0.5, 1, maxPrice 1, minSize 1, tick 20 bps)`: pricePrecision 1e4, sizePrecision 1e4, tick 10 (= 0.001), minSize 1 token, maxSize 1e5 tokens.
   - Fees 0/0, AMM spread 100 bps.
3. Deposited both tokens into `MarginAccount`. Posted a post-only bid and ask (10 tokens each) in one `batchUpdate`.
4. Ran 20 rounds of atomic cancel and replace (`batchUpdate` with 2 cancel IDs plus a new bid and ask).
5. Ran 3 rounds of unbatched cancel and replace (`batchCancelOrders` + `addBuyOrder` + `addSellOrder`).
6. Tore the round down: cancelled resting orders and withdrew both margin balances.
7. Created 2 more markets, each with a fresh outcome token.

## Results

Pricing: 102 gwei per gas (live base fee 100 gwei, which is the protocol floor, plus 2 gwei priority on both networks). MON/USD $0.03431 (Chainlink, 2026-10-04). **Monad bills the gas limit.** We sent with the estimate +15%.

| Action | gas used (fork) | gas limit billed (fork) | USD | Real Monad `eth_estimateGas` |
|---|---|---|---|---|
| Kuru `deployProxy` (market + KuruAMMVault) | 1,195,435 | 1,395,778 | $0.00489 | testnet WMON/USDC 1,215,279; mainnet (as owner) 1,254,652. Different tokens and params, so only roughly comparable |
| Outcome token deploy (full OZ ERC-20; a clone factory will be cheaper) | 521,381 | 599,588 | $0.00210 | n/a |
| MarginAccount deposit (each) | ~142,966 | ~166,250 | $0.00058 | n/a |
| Initial bid+ask (`batchUpdate`, 2 posts, fresh book) | 528,245 | 616,329 | $0.00216 | 2-post `batchUpdate` on busy mainnet MON-USDC: **462,674** |
| **Re-quote: `batchUpdate` cancel 2 + post 2** (mean of 20) | 477k | 556,879 | **$0.00195** | **554,734** (mainnet, +16% vs fork gas used) |
| `batchCancelOrders` of 2 (1) | 247,968 | 288,926 | $0.00101 | **203,849** (1 order: 160,836) |
| Single post bid / ask | 317,021 / 342,738 | 369,599 / 399,643 | $0.00129 / $0.00140 | **250,147 / 316,013** (mainnet) |
| Teardown: cancel 2 / withdraw outcome / withdraw collateral | 247,968 / 114,494 / 97,434 | 288,926 / 132,994 / 113,064 | $0.00188 total | n/a |

**One post plus one cancel on real Monad:** half a 2-order cancel (101.9k) plus the mean single post (283.1k) = 385k gas = **$0.00135, about 13.5x Monad's $0.0001 figure**. On the fork the same pair was 529k gas, $0.00185. A full re-quote (cancel 2 + post 2) is about **$0.0019** either way. Kuru order placement updates a price tree and linked lists and touches the margin account, so it is far from a minimal "post".

On the real schedule, posts are 8–21% cheaper than on the fork, cancels about 18% cheaper, and the combined `batchUpdate` 16% *more* expensive than fork gas used. All are inside ADR-001's 30% revisit trigger.

The two dominant makers on mainnet MON-USDC posted about 200–270 orders per 60–100 blocks, so professional makers do re-quote nearly every block on a deep, high-volume Kuru pair.

**Full per-round Kuru lifecycle** (token + approval + market + 2 deposits + first quote + teardown cancel + 2 withdraws): **$0.0124**.

### What it means for "re-quote every block" (Option A)

Assumptions: 360 rounds per day, 6 markets live at once (`kuru-cost-model.txt`).

| Re-quote cadence per live market | lifecycle/day | re-quote/day | total/day |
|---|---|---|---|
| every block (0.4 s) | $4.46 | $2,525.87 | $2,530.33 |
| every 2 s | $4.46 | $505.17 | $509.63 |
| every 10 s | $4.46 | $101.03 | $105.49 |
| every 60 s | $4.46 | $16.84 | $21.30 |

At the $5,000 launch TVL cap, Kuru cancel/replace every block costs about 50% of TVL per day. See ADR-001 for the decision this drove.

### Latency

Not measured. Anvil mines instantly, so fork timings (about 300–500 ms, which is just RPC round trips) say nothing about Monad inclusion. **BLOCKED until the live testnet run.**

### Limits observed

- **Mainnet market creation is owner-gated.**
  - `Router.deployProxy` on mainnet reverts `Unauthorized()` (`0x82b42900`) for anyone except owner `0x8B736DCe2071783Fd9DB0a423dad17cc8ed5788b`.
  - **Testnet is open:** 3 creations from our EOA on the fork, and `eth_estimateGas` from `0x…dEaD` succeeds on the real testnet.
  - There is no fee beyond gas, and no on-contract rate limit on testnet.
- Every market is a UUPS proxy plus a KuruAMMVault. Kuru's owner can `SOFT_PAUSE` or `HARD_PAUSE` markets, and Router, OrderBook and MarginAccount are all upgradeable. That is venue risk.
- Prices are `uint32` in pricePrecision units, and the tick is fixed at creation. At tick 0.001, 0.02–0.98 gives 960 levels. minSize was 1 outcome token (configurable). `kuruAmmSpread` must be 10–500 bps in multiples of 10.
- Orders are funded from MarginAccount balances: 2 deposits plus 2 withdrawals per round, or reuse balances across markets that share a token.
- `postOnly` is supported. `batchUpdate` gives atomic cancel/replace for any number of levels in one tx.
- The docs pages do not match the deployed ABI. `bestBidAsk` returns `uint256` (1e18-scaled), not `uint32`. The cancel event is `OrdersCanceled(uint40[],address)`, not `OrderCanceled`. Indexers must use the SDK ABI.

## Gaps in this spike

1. Real-Monad numbers are `eth_estimateGas` on a busy mainnet book, not receipts from our own fresh outcome markets. The live testnet run will close this.
2. No fills were exercised (no taker), so `Trade` gas is unmeasured.
3. Latency to inclusion is unmeasured.

## To finish the live run (about 2 MON)

```bash
# 1. fund 0xe36848e8654a86Fd2F7f97DDB3C56042fFD54dd1 with ~2 testnet MON (faucet.monad.xyz)
# 2. build the spike token, then run against live testnet (loads only the deployer key)
(cd contracts && forge build)
DEPLOYER_PRIVATE_KEY=$(grep ^DEPLOYER_PRIVATE_KEY= .env | cut -d= -f2) SPIKE_MODE=testnet pnpm --filter @converge/spike kuru
pnpm --filter @converge/spike report docs/evidence/phase-0/kuru-spike-testnet.json
```

## Questions for the Kuru team

1. **Mainnet `deployProxy` is owner-only.** Will you allowlist Converge's MarketFactory, or otherwise create markets for us, for up to 72 (1h) or 360 (all) expiring UP/USDC markets per day? Do these markets appear in the Kuru UI and Flow routing?
2. Does "Bring New Assets and Markets to Kuru" count expiring outcome-token markets? Does a testnet-only Kuru integration qualify if mainnet creation stays gated?
3. Is there a cheaper "amend price" path than cancel plus re-post? We measured about 250–316k gas per post and about 102–161k per cancelled order on mainnet.
4. Can a market be retired after expiry (for example, soft-paused by its creator)? What happens to resting orders?
5. Is one long-lived market per asset and duration with a rolling base token possible? We assume not, since base is fixed at deploy.
6. Are flip orders or `batchProvisionLiquidity` the recommended way for a vault to provide passive two-sided liquidity?
7. What are the upgrade and pause governance details (multisig, timelock)? Our LPs' resting orders depend on them.
8. Your docs' event and return signatures (`OrderCanceled`, `uint32` `bestBidAsk`/`Trade.price`) differ from the deployed ABI. Is the SDK ABI canonical?
