# Launch thread (build in public, in Nisarg's voice)

Ten posts. Each is at most 280 characters (links count as 23); `node scripts/docs/check-thread.mjs` checks it. Facts only, each in [../numbers.md](../numbers.md). Post it only after the demo video exists and `/stats` is up to date; replace the bracketed items first. Do not add "audited", "mainnet" or any return figure.

**1/**
We built Converge: an onchain vault that makes a two-sided market in every 15-minute UP/DOWN round on Monad. LPs deposit once, traders bet with a passkey. It runs on Monad testnet with test money. A thread on what works and what didn't.

**2/**
The problem: a 15-minute market starts with zero liquidity, 96 times a day. So liquidity is pooled: one vault prices every round and quotes both sides, inside hard loss limits on chain: 1% of the vault per market, 8% in total. https://github.com/nisargpatel7042lva/converge-markets

**3/**
Our first design lost money. Keeper-posted quotes, 91 days of one-second Binance data: -$88/day on a 30-day hold-out against a bot with a one-second lead. It is in the report, not hidden. https://github.com/nisargpatel7042lva/converge-markets/blob/main/backtest/report/REPORT.md

**4/**
The fix: fill an order 2 seconds later, at the oracle's price for that second. Backtest: +$49.6/day (pessimistic flow, $5,000 vault). The limit: it fails if a rival leads by 3s (-$145.3/day), and we haven't measured the real lead yet.

**5/**
Why Monad: we measured what upkeep costs. A volatility refresh $0.000136, serving a trade $0.0017, a full series-day (96 rounds) $0.27. The same gas on Ethereum at today's price: $15.24. Method and inputs: https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/evidence/phase-10/cost-comparison.md

**6/**
Ethereum's gas price is unusually low today (0.0669 gwei). At 10 gwei that series-day is $2,278. Never quote the ratio without the gas price. Monad blocks, measured over 200,000 of them: 0.302 s on testnet and mainnet.

**7/**
Accounts are Mera passkeys: no seed phrase, no extension. Face ID, add test money, tap Up or Down, confirm once. An automated test goes from landing to a filled bet in 4.9s on a local chain. The recovery phrase exports to MetaMask or Rabby.

**8/**
A round's UP token can also be a market on Kuru's order book. For one real testnet round: 18 two-sided quotes, then a second wallet bought $2.00 of Up and sold it back for $1.82. Txs and costs: https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/kuru/INTEGRATION.md

**9/**
What is not true yet: testnet only, no outside users, a mock oracle with a test signer, no external audit (two internal reviews). The CRE workflow is simulated, not deployed. Testnet uptime is poor: 19 of 535 fifteen-minute slots settled (3.6%, Oct 11). /stats shows it live.

**10/**
Every number above traces to a file in the repo (docs/numbers.md). If you build on Monad and want a market with instant depth, or you want to provide liquidity on testnet and tell me what breaks, my DMs are open. [demo video link]
