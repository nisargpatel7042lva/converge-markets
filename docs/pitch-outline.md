# Pitch outline: 10 slides

Every figure is in [numbers.md](numbers.md) with its source. Delivery rule: say "testnet" on the traction slide before anyone asks. The weak points a skeptical investor will raise are answered on the slide where they arise, and listed together at the end.

---

## 1. Problem

**On the slide:** "A 15-minute market starts with zero liquidity, every 15 minutes."
- A prediction market without a counterparty is useless: the first bet finds no price, or moves it to an extreme.
- Short rounds repeat the cold start 96 times a day, per market.

**Speaker notes.** Open with the cold start, not the technology. Do not cite Kizzy's post-mortem unless Nisarg has the link; it is an unverified claim in our own notes (numbers.md N0). If asked about prior Monad betting apps, say the thesis is that empty pools stall them, and that we have not verified their reasons.

## 2. Insight

**On the slide:** "Separate the people who provide liquidity from the people who trade. Then fix the one thing that kills market makers: speed."
- One vault quotes every round, so liquidity is pooled instead of rebuilt per market.
- Our first design lost money to faster traders: **-$88/day** on a 30-day hold-out against a bot with a one-second lead.
- In the backtest, filling an order two seconds later, at the oracle's price for that second, removes the edge of anyone whose lead is under two seconds.

**Speaker notes.** Lead with the failure: it is the credible part. 91 days of one-second Binance data, search on the first 60 days, the last 30 never seen by the search. Be exact about the limit: it is **not robust to longer leads**: +$206.3/day at a 2 s lead, **-$145.3/day at 3 s**. We have not measured the real lead between exchange prices and Chainlink Data Streams (no credentials), and that number decides whether two seconds is enough. Say that.

## 3. Product

**On the slide:** a phone screenshot of a live round, and the stack in one line: Mera passkey, forward-priced venue, ConvergeVault, Chainlink CRE, Kuru, Envio.
- Sign in with Face ID, tap Up or Down, confirm once, collect. No seed phrase.
- Loss limits on chain: **1 % of the vault per market, 8 % in total**; users can always exit.
- Live on Monad testnet today; 412 contract tests plus invariant suites at 10,000 runs x depth 100.

**Speaker notes.** Show the first-trade clip (4.9 s on a local chain, automated; say "local chain"). Name the four integrations in a sentence each: Mera is the account layer; Chainlink CRE creates and resolves rounds; each round's UP token is a market on Kuru; Envio indexes history. Do not say "audited": it is internally reviewed twice.

## 4. Why now

**On the slide:** three facts, each with a source.
1. Prediction markets traded **more than $44 billion in 2025** (Kalshi and Polymarket, [The Block](https://www.theblock.co/post/383733/prediction-markets-kalshi-polymarket-duopoly-2025)); a broader count is **about $63.5 billion, up from $15.8 billion in 2024** ([CertiK, as reported by Decrypt](https://decrypt.co/357583/prediction-markets-grew-4x-to-63-5b-in-2025-but-risk-structural-strain-certik)).
2. Passkeys remove the wallet barrier (our thesis, not a measured result): Mera makes the passkey the account.
3. Monad blocks arrive every **0.302 s** (measured over 200,000 blocks), and a re-quote costs a fraction of a cent.

**Speaker notes.** The CertiK number is secondary reporting; say "as reported". CertiK also warns that the growth leaned on incentives, with wash trading near 60 % of reported volume at one peak (Polymarket, 2024): that is why our design pays LPs from spreads only, never emissions.

## 5. Why Monad

**On the slide:** the cost table.

| What the keeper pays | Monad | Ethereum (estimate) |
|---|---:|---:|
| One volatility refresh | $0.000136 | $0.0077 |
| One trade served | $0.0017 | $0.0965 |
| One Kuru re-quote | $0.0014 | $0.0805 |
| One series-day (96 rounds) | $0.27 | $15.24 |

**Speaker notes.** About 57x. State the method in one breath: Monad's gas is measured (53 keeper transactions, Monad bills the gas limit, 102 gwei, MON $0.02503 from Chainlink on Monad mainnet today); Ethereum is the same gas, billed on gas used, at today's 0.0669 gwei and ETH $2,493.5. Add that Ethereum's gas price today is unusually low: at 10 gwei the series-day is $2,278. Never quote the ratio without the gas price. The 0.302 s block time is measured, not the 400 ms figure in our own earlier notes. **Layer-2s are not compared**: they are far cheaper than Ethereum mainnet, so say "cheaper than Ethereum mainnet", never "cheaper than other chains".

## 6. Traction (real numbers, testnet only)

**On the slide:** "Testnet. Test money. No outside users yet." Then, measured:
- Vault: **$4,029** NAV, share value **$1.0119**, **+1.19% in 2.6 days**.
- **Uptime on testnet: 3.6%.** Of **535** fifteen-minute slots since the first round, **41** got a round: **19 settled normally, 6 were cancelled (pay 50 cents a share), 16 ended late or stuck**.
- **All-time volume $135.41** across **11 filled trades** (19 orders executed; the rest were cancelled and refunded).
- One full Kuru round: market created, **18 two-sided quotes**, a second wallet bought $2.00 and sold back for $1.82.
- First trade in **4.9 s** (automated, local chain); the 10 end-to-end tests pass individually (in a full run one, settlement, is order-dependent flaky).
- Chainlink CRE workflow simulated against live testnet (2 chain reads, 8 planned actions), and a broadcast run wrote on chain through the forwarder: it created a round and invalidated a stranded one (not yet deployed: Early Access).

**Speaker notes.** The 3.6% is the weak number and you should say it first: the testnet scheduler is a script on one machine funded from one small wallet, and it ran in bursts around demos; it stopped when the wallet ran out of test MON or the machine slept. The fix is in the code: a sweep now closes out stranded rounds (paying 50 cents a share) and the CRE workflow plus fallback exists to remove the single point of failure; but only a long run proves reliability and we have not done one on testnet. Do not present the +1.19% as performance: it is a few days of play money, mostly my own test bets.

## 7. Economics

**On the slide:** how money is made, and what is not yet proven.
- **Vault performance fee: 10 % of gains above the high-water mark** (live on chain, hard maximum 20 %), paid to the treasury in shares; no management fee.
- **Protocol fee on winning payouts:** **0 on the live rounds today.** A redeem fee is configurable per market (partner markets default to 0.5 %, at most 1 %; on testnet the partner gets 30 % of it). The mainnet rate is a decision, not a result.
- **LP returns come from spreads, never emissions.** Backtest, forward-priced, pessimistic flow, $5,000 vault: **+$49.6/day** at $12,000/day of taker volume; **+$6.9/day** at $2,400/day.

**Speaker notes.** Illustration, clearly labelled: 10 % of +$49.6/day is $4.96/day to the treasury per $5,000 of vault. The edge figures **exclude** keeper gas, Data Streams verification fees and failed executions (the report says so); at live prices upkeep is $0.27 per series-day plus $0.0017 per fill, small against the edge but not zero, and the Data Streams fee is unknown. Taker volume is an assumption: there are no users yet, so the report gives break-even volume instead of a headline return. Variance is the real risk: a standard deviation of $118/day against an edge of $49.6/day.

## 8. Market size and competition

**On the slide:** sourced figures only.
- 2025 volume: **more than $44 billion** (Kalshi and Polymarket, The Block, 2025-12-31); **about $63.5 billion** on a broader count (CertiK, via Decrypt).
- We have **no reliable public figure for short-duration crypto markets**, which is the segment we serve.
- **The format is not new.** Polymarket runs 15-minute Bitcoin Up/Down markets, settled with Chainlink's BTC/USD oracle ([Crypto Briefing, 2026-09-28](https://cryptobriefing.com/polymarket-15-minute-bitcoin-markets-us/)). Our angle is the pooled liquidity layer other apps plug into, at a fraction of a cent of upkeep.

**Speaker notes.** Do not multiply a percentage onto $44 billion. The honest sizing is bottom-up from traction, which does not exist yet: it is the first thing to measure with real users. The two sources count differently (platforms, notional definitions); say so. **Competition:** say first that Polymarket already does this, with real volume and professional market makers; we have no users. The honest bet is infrastructure: one vault that any Monad app can plug into, plus Monad's cost. If asked why a vault beats market makers, the answer is that we do not know yet: it is the experiment, and the backtest shows it works only against rivals with under a two-second lead.

## 9. Roadmap

**On the slide:** four steps, each with its dependency.
1. **Mainnet beta, capped at 5,000 USDC.** Needs: Data Streams credentials (the one open HIGH finding), CRE deploy access (Early Access), a Safe, an external audit.
2. **Partner API.** Any Monad app launches a market with one SDK call and gets depth under per-partner and global caps. The registry is deployed on testnet; the end-to-end demo on file ran on a local chain.
3. **Long-tail markets.** Any Chainlink-priced asset, not only ETH, BTC and MON.
4. **More venues.** Kuru is live on testnet; Kuru mainnet market creation is owner-gated and needs creation rights.

**Speaker notes.** The dependencies are not ours to control, so name them: they are the ask.

## 10. Team and ask

**On the slide:** "Nisarg Patel, builder. [github.com/nisargpatel7042lva](https://github.com/nisargpatel7042lva)". Then the ask:
- **Chainlink Data Streams access**, to close the open HIGH finding and measure the lead that decides whether two seconds is enough.
- **CRE deploy access**, to run the workflow we have already simulated.
- **Kuru market-creation rights** for mainnet.
- **An external audit** before any real money.
- **[Raise amount: Nisarg decides; no figure is invented here.]**

**Speaker notes.** One person. Say it, then say what is built: ten phases of contracts, keeper, scheduler, indexer, app, partner API and a security review, with the numbers above. Close on the ask list, not on the vision.

---

## Where a skeptical investor will push, and what the pitch says

| Question | Where it is answered |
|---|---|
| "Why would I fund this?" | Slides 2 and 5: a measured cost advantage, and a design change forced by our own failed backtest. |
| "What is fake?" | Slide 6 and the submission's honesty note: it is testnet, play money, a mock oracle with a test signer, no outside users; the CRE workflow is simulated, not deployed; the indexer is not hosted. |
| "What is weak?" | The 3.6% testnet uptime (slide 6), the unmeasured exchange-to-Chainlink lead (slide 2), taker volume as an assumption (slide 7), a 0 % fee today (slide 7), no external audit (slides 3 and 9). |
| "Is the market real?" | Slide 8: large and sourced overall, with no figure for our segment. |
| "Polymarket already does this." | Slide 8: yes, and we say it first; our angle is the plug-in liquidity layer, and we have no users to prove it beats market makers. |
