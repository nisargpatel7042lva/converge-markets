# Phase 5: what the keeper costs on Monad (measured on testnet)

Source: every transaction the keeper sent is a line of `costs.jsonl` in `setup-run/` (the first
start-up runs), `run-a-oldcode/` (28 min, first version of the keeper) and `run-b-final-code/`
(final code, short). 53 transactions, all at an effective gas price of **102 gwei** (Monad
testnet's `eth_gasPrice`). **Monad bills the gas limit, not the gas used**: the keeper's limit is
the estimate plus 15 %, so the cost of a transaction is `gasLimit x 102 gwei`. This is the number
to quote. Raw rows: the three `costs.jsonl` files; the table is `python3` over all three.

| Kind | n | Avg gas limit | Avg cost (MON) | Total (MON) | Inclusion p50 / p95 (ms) |
|---|---|---|---|---|---|
| executeOrder (fill a taker order) | 4 | 664,935 | **0.0678** | 0.2713 | 1430 / 2408 |
| splitForInventory (put pairs into a round) | 3 | 466,858 | 0.0476 | 0.1429 | 1501 / 1954 |
| settleEpoch | 1 | 300,484 | 0.0307 | 0.0307 | 2302 |
| mergeInventory | 1 | 247,549 | 0.0253 | 0.0253 | 997 |
| haltQuoting (pull all quotes) | 18 | 100,000 (fixed) | 0.0102 | 0.1836 | 1412 / 1850 |
| unhaltQuoting | 9 | 100,000 (fixed) | 0.0102 | 0.0918 | 979 / 2162 |
| setSigma (refresh the volatility the ladder uses) | 17 | 53,076 | **0.0054** | 0.0920 | 1259 / 2436 |

The 18 halts include start-up and flapping from the first versions of the keeper (the bugs the
review and the testnet exposed, all fixed: duplicate halts, stale Coinbase feed). They are not
what a healthy keeper spends.

## The numbers for the pitch

- **Cost to re-quote**: in this design the ladder is computed on chain at execution from the
  vault's state, so "re-quoting" is not a cancel/replace per block. What keeps the quotes current
  is a `setSigma` refresh (**0.0054 MON, 53k gas**), done when the estimate moved 5 % or every
  10 minutes. Re-quoting on every block, as the original spec had it, would have been 2.5 refreshes
  a second, which is exactly what ADR-004 replaced.
- **Cost to serve a trade**: one `executeOrder`, **0.068 MON** (665k gas limit; Monad bills the
  limit). The taker's `placeOrder` is paid by the taker (not measured here: it is not the keeper's
  cost). The 0.001 MON reward the taker attaches on testnet is 1.5 % of this: the reward has to be
  sized above the gas on mainnet or nobody but the keeper will execute.
- **Cost per round** (one 15 minute market, from the measured kinds): split 0.0476 + merge 0.0253
  + settleEpoch 0.0307 + 1.5 sigma refreshes 0.0081 = **about 0.112 MON per round without trades**.
  Per series per day (96 rounds): **about 10.7 MON**, plus 0.068 MON per executed order. For a
  vault that holds inventory for 1 hour rounds the same costs fall by 4.
- **Not measured** (no run was long enough, MON ran out): `checkpoint`, `resolve` and
  `redeemResolved` per round. They are permissionless and the per-day figure above excludes them.
  The unit tests and the forge gas reports bound them but those are not testnet measurements.

MON has no price on testnet. In USD the above is: at an assumed MON price of $0.02 / $0.05 / $0.10
a sigma refresh costs $0.00011 / $0.00027 / $0.00054, an executed order $0.0014 / $0.0034 / $0.0068
and a series-day of maintenance $0.21 / $0.54 / $1.07. The prices are assumptions, not data.
Monad's published figure of about $0.0001 for a post-and-cancel matches the refresh at the lowest
assumed price; the execution of a trade is 12 times that.

## What this says about the model

Whether spreads cover 0.068 MON per fill depends on the mainnet gas price and the MON price, both
unknown to us. At 0.05 USD per MON an execution is 0.3 cent: a 5 USD trade at a 3 % half-spread
earns 15 cents. (Illustrative arithmetic, not a measured margin.) At a 20 cent trade the same spread earns 0.6 cent against 0.3 cent of execution gas, so the margin is thin below that size.
