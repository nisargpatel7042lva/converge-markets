# Kuru feasibility spike (Phase 0)

**Status: ran end to end on an anvil fork of Monad testnet (real Kuru contracts, Ethereum gas schedule). The live-testnet run is BLOCKED: the deployer `0xe36848e8654a86Fd2F7f97DDB3C56042fFD54dd1` has 0 MON and the faucet is web-only.**

- Script: `scripts/spike/src/kuru-spike.ts` (ABIs from `@kuru-labs/kuru-sdk@0.0.95`; addresses from docs.kuru.io)
- Raw output: `kuru-spike-fork.json` (every tx, with gas limit, gas used and block)
- Cost table: `kuru-cost-model.txt` (`pnpm --filter @converge/spike report`)
- Onchain checks against the real chain: `external-onchain-checks.txt`

## What was done

1. Deployed an open-mint collateral (6 dp) and an outcome token (18 dp) (`contracts/script/spike/SpikeToken.sol`).
2. Created a Kuru market UP/collateral with `Router.deployProxy` from a plain EOA. Params from the SDK's `calculatePrecisions(0.5, 1, maxPrice 1, minSize 1, tick 20 bps)`: pricePrecision 1e4, sizePrecision 1e4, tick 10 (= 0.001), minSize 1 token, maxSize 1e5 tokens, fees 0/0, AMM spread 100 bps.
3. Deposited both tokens into Kuru `MarginAccount` and posted a post-only bid and ask (10 tokens each) in one `batchUpdate`.
4. Ran 20 rounds of atomic cancel and replace (`batchUpdate` with cancel IDs plus a new bid and ask).
5. Ran 3 rounds of unbatched cancel and replace (`batchCancelOrders` + `addBuyOrder` + `addSellOrder`) for comparison.
6. Created 2 more markets (fresh outcome token each) to check repeat creation.

## Results

Pricing: 102 gwei per gas (live base fee 100 gwei, which is the protocol floor, plus 2 gwei priority). MON/USD $0.03431 (Chainlink, 2026-10-04). **Monad bills the gas limit.** We sent with estimate +15%.

| Action | gas used (fork) | gas limit billed | MON | USD |
|---|---|---|---|---|
| Kuru `deployProxy` (market + KuruAMMVault) | 1,195,431 | 1,395,773 | 0.1424 | $0.00489 |
| Same call, `eth_estimateGas` on **real** testnet (Monad gas schedule) | 1,215,279 (est.) | n/a | | |
| Outcome token deploy (full OZ ERC-20; a clone factory will be cheaper) | 521,381 | 521,381 | 0.0532 | $0.00183 |
| MarginAccount deposit (per token) | 142,966 | 166,250 | 0.0170 | $0.00058 |
| Initial bid+ask (`batchUpdate`, 2 posts) | 528,245 | 616,329 | 0.0629 | $0.00216 |
| **Re-quote: `batchUpdate` cancel 2 + post 2** (mean of 20) | 477,361 | 556,878 | 0.0568 | **$0.00195** |
| Unbatched cancel of 2 (`batchCancelOrders`) | 247,968 | 288,926 | 0.0295 | $0.00101 |
| Unbatched single post (bid / ask) | 317,021 / 342,738 | 369,599 / 399,643 | 0.038 / 0.041 | $0.0013 / $0.0014 |

**One post plus one cancel costs about $0.0018 on Kuru (≈ 0.65M gas).** Monad's marketing figure is about $0.0001 per post-and-cancel. Our measured cost on Kuru is about **18x higher**. Kuru order placement updates a price tree and linked lists, and touches the margin account, so it is far from a minimal "post" operation. The base fee was at its floor, so under load this only gets worse.

### What it means for "re-quote every block"

Option A, using the model in `scripts/spike/src/cost-model.ts`: 360 rounds per day (3 assets × (96 + 24)), 6 markets live at once (one UP market per asset × duration).

| Re-quote cadence per live market | setup/day | re-quote/day | total/day |
|---|---|---|---|
| every block (0.4 s) | $3.40 | $2,525.87 | $2,529.27 |
| every 2 s | $3.40 | $505.17 | $508.58 |
| every 10 s | $3.40 | $101.03 | $104.44 |
| every 60 s | $3.40 | $16.84 | $20.24 |

Market creation is cheap (about $0.009 per round including token and deposits). **Continuous re-quoting is not.** At the $5,000 launch TVL cap, re-quoting every block would burn about 50% of TVL per day. Even every 10 s costs about 2% of TVL per day. That needs real taker volume to recover through spread.

### Latency

Not measured. Anvil mines instantly, so fork timings (300–1000 ms, which is just RPC round trips) say nothing about Monad inclusion. **BLOCKED until the live testnet run.** Docs claim 400 ms blocks and about 800 ms finality.

### Limits observed

- **Permissionless market creation:** confirmed. `deployProxy` succeeded 3 times from an unprivileged EOA on the fork, and `eth_estimateGas` from `0x…dEaD` succeeds on the real testnet. There is no fee beyond gas, no allowlist and no rate limit in the contract.
- Each market is a UUPS proxy, plus a KuruAMMVault. Kuru's owner can `SOFT_PAUSE` or `HARD_PAUSE` markets, and Router, OrderBook and MarginAccount are all upgradeable. That is a venue risk.
- Prices are `uint32` in pricePrecision units, and the tick is fixed at creation. At tick 0.001, 0.02–0.98 gives 960 price levels. minSize was 1 outcome token (configurable). `kuruAmmSpread` must be 10–500 bps in multiples of 10.
- Orders are funded from MarginAccount balances, so the vault must deposit per market (2 extra txs per round, or reuse balances across markets with the same token).
- `postOnly` is supported on single and batch placement. `batchUpdate` gives atomic cancel/replace for any number of levels in one tx.

## Gaps in this spike (be explicit)

1. The fork uses Ethereum's gas schedule. Monad reprices cold account access (10,100 vs 2,600) and storage (8,100 per 128-slot page vs 2,100 per slot). For `deployProxy` the real Monad estimate came out 1.7% higher than the fork. Re-quote gas on real Monad is **unmeasured**. It could be higher (more cold accesses) or lower (page warming).
2. No fills were exercised (no taker), so `Trade` event shape and fill gas are unmeasured.
3. Latency to inclusion is unmeasured (see above).

## To finish the live run (about 2 MON needed)

```bash
# 1. fund 0xe36848e8654a86Fd2F7f97DDB3C56042fFD54dd1 with ~2 testnet MON (faucet.monad.xyz)
# 2. run against live testnet (keys are read from .env, never printed)
set -a; . ./.env; set +a; SPIKE_MODE=testnet pnpm --filter @converge/spike kuru
pnpm --filter @converge/spike report docs/evidence/phase-0/kuru-spike-testnet.json
```

## Questions for the Kuru team

1. Is creating one new market per 15-minute or 1-hour round (up to 360 per day) acceptable to you? Will such markets show up in Kuru's UI and Flow routing automatically, or is there an off-chain listing or allowlist?
2. Does the bounty ("Bring New Assets and Markets to Kuru") count expiring outcome-token markets, and does it need them listed in the Kuru app?
3. Are there plans to lower order-placement gas? We measured about 320–340k gas per post and about 124k per cancelled order (Ethereum schedule). Is there a cheaper "amend price" path than cancel plus re-post?
4. Can a market be retired cleanly after expiry (for example, soft-paused by the creator)? Today only Kuru's owner controls market state. What happens to resting orders at expiry?
5. Is it possible to have one long-lived market per asset and duration whose base token we roll each round? We assume not, because base is fixed at deploy.
6. Are flip orders or `batchProvisionLiquidity` (passive, auto-flipping) the recommended way for a vault to provide two-sided liquidity without re-quoting every block?
7. What are the upgrade and pause governance details (multisig, timelock)? Our LPs' resting orders depend on them.
