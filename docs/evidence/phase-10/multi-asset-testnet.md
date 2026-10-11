# BTC and MON series on Monad testnet (2026-10-11)

The testnet ran one series (ETH, the `TEST/USD` asset). BTC and MON now run beside it, each a 15-minute round, quoted by the same vault and keeper.

## What was added

| Layer | Change |
|---|---|
| Chain | `services/keeper/scripts/testnet-add-assets.ts` (idempotent): per asset, `DataStreamsResolver.configureAsset`, `MarketFactory.setAsset`, `ConvergeVault.enableAsset` with a volatility band (BTC 0.30 to 1.00, MON 0.60 to 2.00; ETH keeps 0.40 to 1.20). Asset ids and feed ids are in `deployments/testnet.json` (`seriesAdded`). The test verifier accepts any feed id, so no new contract was deployed. |
| Prices | The relay (`scripts/keeper-live/src/relay.ts`) now serves every asset on its own path (`ws://127.0.0.1:9201/<symbol>`) and `GET /price?asset=BTC`. ETH and BTC: Binance and Coinbase. **MON: OKX and Gate order books**, re-shaped as a Binance and a Coinbase message, because Binance does not list MON and Coinbase's MON-USD ticker only speaks on trades (see below). The keeper's test-hook URLs accept `{symbol}` (`hookUrl`, 2 unit tests). |
| Scheduler | `services/keeper/scripts/testnet-scheduler.ts` runs ETH, BTC and MON (`SERIES=ETH,BTC` limits it); one signed report per asset from the relay's own price. |
| Keeper | `config/keeper.testnet.json`: two more assets with their own volatility settings. |
| App | `apps/web/src/config/testnet.json`: two more series; price display uses each series' own decimals (MON shows five: `$0.02525`); the browser feed treats Binance as optional (MON uses Coinbase there); the testnet price pin takes `?asset=`. |

## Live checks

| Check | Result |
|---|---|
| Vault sigma set for all three assets | **PASS**: ETH 0.658, BTC 0.498, MON 1.099 (read from `assetCfg`) |
| Keeper reports a healthy price for all three | **PASS**: ETH 2499.7, BTC 83048, MON 0.02558 |
| Rounds created, opened and resolved for all three | **PASS**: BTC and MON 08:30 rounds opened, then resolved at 08:45 |
| A fresh passkey account bets on BTC, filled by the keeper | **PASS**, 18.6 s landing to filled (`mera-testnet-trade-btc.json`) |
| Same on MON | **PASS**, 22.7 s (`mera-testnet-trade-mon.json`). The first attempt (08:37) was refunded: the MON round had run more than one standard deviation above its strike, the app priced Up at its 0.99 cap and the vault does not quote past its price bounds. That is the designed refund, not a defect. |

## Two things this found

1. **A quiet feed pulls every quote.** Coinbase's `ticker` channel only speaks when a trade happens, and MON-USD can go minutes without one, so the keeper (which pulls all quotes when one feed is stale) halted for several seconds. The MON series now uses two order-book feeds that answer a ping while the book is unchanged, and the relay re-sends the last mid while they are alive.
2. **Gas, measured.** The keeper spent **0.69 MON in 16.4 minutes** with three series (splits 0.055 each, merges 0.028, redeems 0.024, setSigma 0.006, executions 0.063 per fill; three halt/unhalt cycles from relay restarts are included). With the scheduler's roughly 0.1 MON per asset-round, a series costs about **0.2 MON per 15-minute round**: three series is about 2.6 MON an hour, about 63 MON a day, against about 21 MON a day for ETH alone. Testnet MON is the limit on how long this can run unattended.

## Honest limits

- MON's second source is Gate's USDT pair, not a USD pair; the keeper's source labels for MON ("binance", "coinbase") name the message shape, not the exchange. This is a testnet relay; mainnet reads Chainlink Data Streams.
- Only the ETH series is listed on Kuru (the lister is unchanged).
- The stats page's round counts still read the ETH series only.

## Why the deployed link looked empty from India

The app blocks the countries in `apps/web/config/regions.json`, and **India is on the default list** ("per the brief"). From India the deployed link shows "Converge isn't available in your region" (HTTP 451), not a market list, however many markets are running. The reviewer bypass that the middleware already supported was off. On 2026-10-11 Nisarg chose to turn it on: `REGION_BYPASS_TOKEN` is set on the Vercel production environment (type sensitive), so `…/markets?region_bypass=<token>` sets a week-long cookie. The public block is unchanged. To turn it off, delete that variable. The link is kept in `.testnet/region-bypass-link.txt` (local, excluded from git). The in-app faucet is also off on Vercel (no drip key is set there), so a visitor there can read markets but not get test money.
