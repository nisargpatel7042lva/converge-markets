# Metropolis submission: the answers as entered in the form

The text below is what is in the submission form, kept here so it can be read next to the code. Every claim has a source in [numbers.md](numbers.md); every link points at this repository. **Honesty note:** everything runs on Monad testnet with test money. There are no outside users yet. The oracle on testnet is a mock verifier with a test signer. The code is reviewed internally, not externally audited.

Base for links: https://github.com/nisargpatel7042lva/converge-markets/blob/main/

## Track

Onchain Finance & Trading.

## One-line description

Converge is an onchain vault that makes a market in every 15-minute UP/DOWN round on Monad, so new markets start with liquidity and anyone can bet with a passkey.

## Project description

**The problem.** Short prediction markets, like "will ETH be higher in 15 minutes?", fail for one reason: every round starts with no liquidity. The first trader finds no price, or moves it to an extreme, and leaves. A 15-minute market repeats that cold start 96 times a day.

**What we built.** Converge is an onchain liquidity layer for these markets on Monad. Liquidity providers deposit stablecoins once into one vault. The vault prices every round with a fair-value model and quotes both outcomes from the first second, inside hard on-chain loss limits: 1% of the vault per market, 8% in total. LP returns come from spreads, never token emissions, and users can always exit.

**How a trade works.** A trader signs in with a Mera passkey (no seed phrase, no extension), taps Up or Down and confirms once. The order fills two seconds later at the oracle's price for that second, so nobody trades against a price they already saw move. We found this by failing first: our first design lost $88 a day in a 30-day hold-out backtest to a bot with a one-second lead. Forward-priced execution turns that into about +$49.6 a day on a $5,000 vault, under pessimistic assumptions (91 days of 1-second prices). It breaks at a three-second lead, and we say so.

**Live on Monad testnet.** ETH, BTC and MON 15-minute rounds quoted by one vault. A fresh passkey account reached a keeper-filled bet in 18.7 s (ETH), 18.6 s (BTC) and 22.7 s (MON). A Chainlink CRE workflow's broadcast created rounds through the forwarder. A Kuru lister puts a round's Up token on Kuru's order book. The Envio indexer is hosted and the app reads it. A partner API lets any Monad app launch a market with depth in one call, under caps.

**Why Monad.** Blocks take 0.302 s, and serving a trade costs about $0.0017, against about $0.097 on Ethereum at today's gas: roughly 57 times cheaper.

**Go to market.** First Monad traders (a one-minute first bet and honest feedback), then LPs (test-USDC deposits), then Monad apps that want depth for new markets (the partner API). Revenue is a 10% performance fee above the high-water mark, plus a fee share on partner markets; the mainnet rate is undecided. A capped mainnet beta of 5,000 USDC comes after Chainlink Data Streams access, CRE deploy access, Kuru market-creation rights and an external audit.

**Honest status.** Testnet only, test money, no outside users yet. Testnet uses a mock oracle verifier with a test signer. The code is internally reviewed twice (412 contract tests), not externally audited. The CRE workflow is simulated and broadcast, not deployed.

## Videos

| Video | What it shows |
|---|---|
| Pitch (under 2 minutes) | The problem, the vault, the speed fix with its limit, a live bet, Monad's costs, the stack, the platform, the team and the ask. Script: [docs/pitch-video/SCRIPT-2min.md](pitch-video/SCRIPT-2min.md) |
| Demo | A full walkthrough with no captions. Part 1 is the real app, contracts, keeper and scheduler on a **local demo chain with a synthetic price** (`.demo/start.sh`; the round ends above its start so a winning bet can be shown): passkey sign-up, test money, a live round, a bet and its fill, a time-lapse of the chain clock to settlement, collecting, the vault's deposit flow, live stats. Part 2 is real command output from the **live Monad testnet deployment**: the CRE simulation, the CRE broadcast receipt, the vault's three assets, the scheduler and Kuru logs, test summaries. How it was made: [docs/demo-video/README.md](demo-video/README.md) |
| Chainlink CRE (bounty) | The workflow source, a live simulation against the testnet factory, an earlier run and the broadcast receipt |
| Mera UX (bounty) | Face ID sign-up, test money and a bet with one confirmation (cut from the demo's first part) |

## Steps to try the product

Testnet, test money. No login: a passkey is the account.

1. Open https://converge-markets-app.vercel.app (the app blocks a list of regions, India among them; judges in a restricted region get a private access link in the form's judge-instructions field).
2. Use Chrome or Safari with passkey support. **Sign in**, then **Start with Face ID**.
3. **Add test money**, open a live round on **Markets**, tap Up or Down and confirm once. The keeper fills it about 2 seconds later.
4. `/stats` shows the vault's value, rounds settled and how rounds ended, read from the chain and the hosted indexer.
5. Rounds only exist while the testnet scheduler runs. If none is live, the videos show real runs and [docs/evidence/](evidence/) has the transaction proofs. To see the whole system yourself: `.demo/start.sh` runs it locally ([docs/ops/local-demo.md](ops/local-demo.md)).

## Bounty: Kuru, "Bring New Assets and Markets to Kuru"

**1. The new asset class, with evidence of demand and the mechanism.**

The asset: short-dated binary outcome tokens. Each 15-minute Converge round has an UP token: a fully collateralised claim that pays $1 if a Chainlink-priced asset (ETH, BTC or MON) finishes at or above its start price, and $0 otherwise. A new one is born every 15 minutes and expires 15 minutes later: 96 new markets a day per series, a class of asset that does not exist on a spot order book today.

Issuance, redemption and settlement: $1 of collateral splits into 1 UP and 1 DOWN token, so every token is always backed. Before the end, anyone can merge a pair back into $1. After the end, a signed Chainlink price report resolves the market and winners redeem 1:1. A round that cannot be confirmed is cancelled and pays 50 cents a share. Nobody picks a winner by hand.

On Kuru: our lister creates each round's UP token as its own Kuru market (`Router.deployProxy`, idempotent), seeds it, quotes both sides around the vault's fair value, and tears it down and redeems at the end. In a live testnet round, a separate wallet bought 3.59 UP for $2.00 from the book and sold it back for $1.71. Earlier, a round showed 18 two-sided quotes in 11 minutes.

Evidence of demand, plainly: there is no organic demand on Kuru yet; the maker is our own wallet, so the book proves the pipeline, not demand. The market-level signal is that prediction markets traded more than $44 billion in 2025 (Kalshi and Polymarket, per The Block), and Polymarket launched 15-minute Bitcoin Up/Down markets on 2026-09-22. The format has demand; the missing piece is liquidity for new short markets. Because UP and DOWN can always be merged back into dollars, an arbitrageur can always close a mispricing.

Where to look:
- Create the market (Router.deployProxy, idempotent): https://github.com/nisargpatel7042lva/converge-markets/blob/main/services/kuru/src/lister.ts#L141
- Seed the market: https://github.com/nisargpatel7042lva/converge-markets/blob/main/services/kuru/src/lister.ts#L208
- Two-sided quotes (cancel and replace): https://github.com/nisargpatel7042lva/converge-markets/blob/main/services/kuru/src/lister.ts#L268
- Teardown and redeem: https://github.com/nisargpatel7042lva/converge-markets/blob/main/services/kuru/src/lister.ts#L327
- Re-quote policy (6 cents or 4 minutes, never faster than every 30 s): https://github.com/nisargpatel7042lva/converge-markets/blob/main/services/kuru/src/kuru.ts#L75
- Integration notes and measured costs: https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/kuru/INTEGRATION.md
- Every transaction of a listed round: https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/evidence/kuru/rounds.md

**2. Legal and operational plan, and liquidity and initial market formation.**

Legal: these are price-threshold event contracts on crypto prices, and their legal treatment differs by jurisdiction. Many restrict prediction markets or derivatives. We have not yet had legal counsel review the structure; that is a gate before any mainnet funds. What exists today: a region block enforced at the edge (India, Cuba, Iran, North Korea, Syria, and Crimea, Donetsk and Luhansk), an exit-only mode so people in blocked regions can still redeem and withdraw, risk and terms pages, no token emissions, no promised returns, and test money only. The mainnet plan is a capped beta of 5,000 USDC after counsel review.

Operational: the oracle moves from our testnet test-signer verifier to Chainlink Data Streams (access pending). Round creation and settlement run through a Chainlink CRE workflow with a fallback keeper (CRE deploy needs Early Access). Kuru mainnet market creation is owner-gated, so we need creation rights from Kuru. Owner actions go through a Safe and a timelock. The code has had two internal reviews, and an external audit comes before real funds.

Liquidity and initial market formation: the vault is the seed liquidity. For every round, the keeper splits vault collateral into UP and DOWN inventory (loss limits of 1% of the vault per market and 8% in total). The lister funds the Kuru market and posts a two-sided quote around the vault's fair value, so each market has a bid and an ask from its first moments. It re-quotes after a 6-cent move or 4 minutes, never faster than every 30 s, which costs about $0.0014 per re-quote on Monad against about $0.08 on Ethereum. LP returns come from spreads only.

**3. Roadmap beyond the hackathon.** No dates, because they depend on access we do not control. In order: (1) clear the gates to mainnet: Chainlink Data Streams access (replacing the test verifier), CRE deploy access (replacing the TypeScript scheduler), Kuru market-creation rights, a Safe and timelock, an external audit; (2) a capped mainnet beta (5,000 USDC) with ETH, BTC and MON 15-minute series, the Kuru lister live for every series (today it lists ETH only) and 1-hour rounds, measuring real taker volume and the real lead between exchange prices and Chainlink, which decides whether our 2-second delay is enough; (3) the partner API (the registry is deployed on testnet): https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/partners.md ; (4) long-tail markets (any Chainlink-priced asset) and venues beyond Kuru. What we will measure: the first outside bets and deposits (none yet), how continuously rounds settle (testnet uptime was low and is the first thing to fix), the share of time a Kuru book has two-sided quotes, and the spread we capture against losses.

## Bounty: Chainlink, "Best workflow with CRE"

The CRE workflow is the orchestration layer that runs the rounds of our markets. On a cron it reads the whole market factory in one call through a lens contract (2 EVM reads, against CRE's limit of 15). It plans create, open, resolve and invalidate actions with a planner shared with our fallback keeper, fetches Data Streams evidence, and writes one signed report to our SchedulerReceiver through the Keystone forwarder. The receiver accepts only the forwarder and the configured workflow owner, then executes the batch.

Timing is the point. A 15-minute market must be created before its start, opened at it and resolved at its end, and a missed boundary strands bets. So a TypeScript fallback keeper does the same job, and an on-chain leader flag arbitrates between the two. A CRE outage delays a round instead of stranding money.

Evidence: the official simulator, run against the live Monad testnet factory, planned 8 actions on 2026-10-10 (3 creates, 5 invalidations) and 3 actions on 2026-10-13 (2 chain reads). A broadcast run on 2026-10-11 wrote on-chain through the forwarder: status success, a round created and a stranded round invalidated. Its first attempt was correctly refused by the receiver, because the simulator stamps a placeholder workflow identity, which shows the owner check works.

Gaps: the workflow is simulated and broadcast, not deployed: deployment needs CRE Early Access, which our account does not have yet. The testnet rounds are created by our TypeScript scheduler today. Data Streams reports on testnet come from a test shim.

Where to look:
- Workflow (onCron): https://github.com/nisargpatel7042lva/converge-markets/blob/main/services/scheduler/cre/scheduler/main.ts#L98
- Data Streams request: https://github.com/nisargpatel7042lva/converge-markets/blob/main/services/scheduler/cre/scheduler/main.ts#L70
- Shared planner: https://github.com/nisargpatel7042lva/converge-markets/blob/main/packages/sdk/src/planner.ts
- On-chain receiver: https://github.com/nisargpatel7042lva/converge-markets/blob/main/contracts/src/scheduler/SchedulerReceiver.sol#L27
- Simulation, 2026-10-10: https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/evidence/cre/simulate-testnet.txt
- Simulation, 2026-10-11: https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/evidence/cre/simulate-testnet-2026-10-11.txt
- Broadcast write-up: https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/evidence/cre/broadcast-testnet-2026-10-11.md
- Broadcast transaction: https://testnet.monadvision.com/tx/0xf84bf488de7305b79d575f32f17dbc57ad7629b5cc6a7bd31dcb5cb77bbeb76d

## Bounty: Monad Foundation, "Best Mera-Powered UX on Monad"

Mera is the entire account layer; there is no other. A passkey (WebAuthn PRF) yields 32 bytes, and those bytes are the account. Nothing secret is stored. Signing happens in a session that lives for one confirmation and then zeroes the key, and one passkey prompt covers both the approval and the order of a bet. A build check fails if any other account library appears.

The experience: no seed phrase, no extension, no sign-up form. The account is shown as a handle like proud-impala-87. An in-app faucet provides gas and test dollars, so a new person gets from landing page to a filled bet in seconds. On live Monad testnet a fresh account did it in 18.7 s (ETH), 18.6 s (BTC) and 22.7 s (MON). A person can still leave: after a passkey prompt the app shows a recovery phrase that derives the same address in MetaMask or Rabby, and the passkey restores the account on a new device. Unsupported browsers get a plain-language explanation, not a crash.

Proof: Playwright drives the real passkey flow in Chromium's virtual authenticator with no test-only account. Gap: not tested on a physical phone; PRF support depends on device and browser.

Where to look:
- Create account: https://github.com/nisargpatel7042lva/converge-markets/blob/main/apps/web/src/lib/account.ts#L94
- Restore on a new device: https://github.com/nisargpatel7042lva/converge-markets/blob/main/apps/web/src/lib/account.ts#L112
- One-confirmation signing session: https://github.com/nisargpatel7042lva/converge-markets/blob/main/apps/web/src/lib/account.ts#L140
- Recovery phrase after a passkey prompt: https://github.com/nisargpatel7042lva/converge-markets/blob/main/apps/web/src/lib/account.ts#L162
- Key derivation from the passkey secret: https://github.com/nisargpatel7042lva/converge-markets/blob/main/apps/web/src/lib/derive.ts#L14
- Build check that Mera is the only account layer: https://github.com/nisargpatel7042lva/converge-markets/blob/main/apps/web/scripts/check-deps.mjs
- End-to-end passkey tests: https://github.com/nisargpatel7042lva/converge-markets/blob/main/apps/web/e2e/flows.spec.ts
- Timed live-testnet trades: https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/evidence/phase-10/mera-testnet-trade.json (ETH), https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/evidence/phase-10/mera-testnet-trade-btc.json (BTC), https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/evidence/phase-10/mera-testnet-trade-mon.json (MON)
- Browser and PRF support matrix: https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/EXTERNAL.md

## Bounty: Envio, "Best Use of Envio"

We built a HyperIndex indexer for the whole product: markets, trades, positions with average-cost PnL, vault value and APY history, epochs, partners and protocol totals. It has a typed GraphQL client and a reconcile tool that checks indexed rows against the chain. The app's Earn page (performance and APY), My bets (history and PnL) and the stats page's volume chart read from it, with the chain as the fallback for anything that must be exact, such as exits and claims.

Evidence: 100 handler tests pass on Envio 3.14.1. The indexer is hosted on Envio Cloud (Development plan), synced 100% on Monad testnet with 830 events, and the deployed stats page queries it (4 requests, all HTTP 200). It holds 64 markets (43 resolved), 15 trades, 7 users and a vault value of $4,010.05, which matches the chain. An earlier run over a 7,600-block window compared indexed volumes with the keeper's logged premiums (equal) and sampled entities with the chain (27 of 29 match; the other 2 differ by exactly the first LP deposit, which settled before the window).

Gaps: the plan has no static production endpoint (a new deployment gets a new URL) and rate-limits bursts of requests; the data is testnet play-money history; the full reconcile run against the hosted endpoint is recorded in the evidence file when it completes.

Where to look:
- Indexer config: https://github.com/nisargpatel7042lva/converge-markets/blob/main/indexer/config.yaml
- Schema: https://github.com/nisargpatel7042lva/converge-markets/blob/main/indexer/schema.graphql
- Handlers: https://github.com/nisargpatel7042lva/converge-markets/tree/main/indexer/src/handlers
- Typed GraphQL client: https://github.com/nisargpatel7042lva/converge-markets/blob/main/packages/sdk/src/indexer.ts#L693
- App feature reading the indexer (Earn): https://github.com/nisargpatel7042lva/converge-markets/blob/main/apps/web/src/lib/queries.ts#L129
- Hosted deployment evidence: https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/evidence/phase-10/envio-hosted.md
- Run against real testnet data: https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/evidence/phase-10/envio-testnet-window.md
- Handler test log (100 passing): https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/evidence/phase-10/indexer-tests.txt
- Public GraphQL endpoint: https://indexer.dev.hyperindex.xyz/33a020f/v1/graphql

## Bounties we did not enter, and why

- **Agora, Best Mobile Trading App:** it requires a balance held in AUSD and trades executed through Perpl. We use neither.
- **Monad Foundation, Mera: One Passkey, Many Keys:** it rewards using the passkey's secret for work that is not signing transactions. We use it only to derive the wallet key (and its recovery phrase).
