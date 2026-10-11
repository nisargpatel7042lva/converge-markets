# Metropolis submission: ready-to-paste answers

Repo: https://github.com/nisargpatel7042lva/converge-markets. Links below use `…/blob/main/<path>#L<line>` and are checked by `node scripts/docs/check-links.mjs` (every path exists and every line is in range; every transaction hash exists on Monad testnet). Every number is in [numbers.md](numbers.md) with its source.

**Honesty note for the form.** Everything runs on Monad testnet with test money. There are no outside users yet. The oracle on testnet is a mock verifier with a test signer. The code is reviewed internally, not externally audited. Where a bounty has a gap, it is stated under that bounty.

## Track

**Track 01: Onchain Finance and Trading.**

## One-liner

Converge is an onchain vault that makes a two-sided market in every 15-minute UP/DOWN round on Monad: liquidity providers deposit once, traders bet from a phone with a passkey.

## Description (about 200 words)

Thin prediction markets fail because every short round starts with no liquidity. Converge fixes the supply side. One vault (`ConvergeVault`) prices every round with a fair-value model and quotes both sides inside hard on-chain loss limits (1 % of the vault per market, 8 % in total). Traders place an order from a phone; it fills two seconds later at the oracle's price for that second, so nobody trades against a price they could already see move. Accounts are Mera passkeys: no seed phrase, no extension. A Chainlink CRE workflow (simulated on testnet; a TypeScript scheduler runs the rounds today) is built to create, open and resolve them, a Kuru lister puts a round's UP token on Kuru's order book (run for two live rounds), and an Envio indexer (local; hosting in progress) serves history.

We report what did not work. Our first design (keeper-posted quotes) lost $88/day in a 30-day hold-out backtest against a bot with a one-second lead; forward-priced execution turns that into +$49.6/day under pessimistic flow, but only for leads under the two-second delay. A re-quote costs $0.0014 on Monad at live prices against about $0.08 on Ethereum. It is live on Monad testnet with a $4,029 test vault; the code has had two internal reviews and 412 contract tests, no external audit yet.

## Links

| | |
|---|---|
| Demo video | **[pending: record per [demo-script.md](demo-script.md); Nisarg adds the URL]** |
| Repo | https://github.com/nisargpatel7042lva/converge-markets |
| App (testnet) | https://converge-markets-app.vercel.app (the deployed build is older than `main`; run `.demo/start.sh` for the current one) |
| Live numbers | https://converge-markets-app.vercel.app/stats |
| Backtest report | https://github.com/nisargpatel7042lva/converge-markets/blob/main/backtest/report/REPORT.md |

---

## Bounty: Kuru, "Bring New Assets and Markets to Kuru"

**What we built.** A service that lists each Converge round's UP token (a fully collateralised binary outcome token that converges to 0 or 1) as its own market on Kuru's order book, seeds it, quotes both sides around the vault's fair value, then tears it down and redeems at the end of the round.

**Why it is meaningful.** It is a new class of asset for a spot order book: markets born and dead every 15 minutes, priced as digital options, and always redeemable, so a maker can mint inventory and an arbitrageur can always close a mispricing. The infrastructure to make that viable is the contribution: permissionless creation, idempotent market addresses (no registry), a re-quote policy sized by measured cost, and an app panel that shows Kuru's book next to the vault's price.

**Where to look.**

- Create the market through `Router.deployProxy`, idempotently: [`lister.ts:141`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/services/kuru/src/lister.ts#L141) (`ensureListed`).
- Seed (split into UP + DOWN, deposit to Kuru's margin account): [`lister.ts:208`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/services/kuru/src/lister.ts#L208). Atomic cancel-and-replace quote with `batchUpdate`: [`lister.ts:268`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/services/kuru/src/lister.ts#L268). Teardown and redeem: [`lister.ts:327`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/services/kuru/src/lister.ts#L327), [`lister.ts:352`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/services/kuru/src/lister.ts#L352).
- Tick-aligned quote and the re-quote policy (6 cents or 4 minutes, never faster than 30 s): [`kuru.ts:66`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/services/kuru/src/kuru.ts#L66), [`kuru.ts:75`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/services/kuru/src/kuru.ts#L75), [`kuru.ts:85`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/services/kuru/src/kuru.ts#L85). Unit tests: `services/kuru/test/quote.test.ts`.
- App: Kuru's book next to the vault's price, found with `Router.computeAddress`: [`apps/web/src/lib/kuru.ts:29`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/apps/web/src/lib/kuru.ts#L29), [`kuru-panel.tsx:13`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/apps/web/src/components/kuru-panel.tsx#L13).
- Docs and measured costs: [docs/kuru/INTEGRATION.md](https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/kuru/INTEGRATION.md). All transactions of the round: [docs/evidence/kuru/rounds.md](https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/evidence/kuru/rounds.md).

**Transactions (Monad testnet).**

- Kuru market created for the 13:45Z round's UP token: [`0x15a05421…303f`](https://testnet.monadvision.com/tx/0x15a054219d00ed2e81c5b6b2032b7004026323d7edf925e3a3f2c56bc3b0303f); the market is [`0x75525B25…eE33`](https://testnet.monadvision.com/address/0x75525B25c504F7a2D78F2847F7A06Bed1631eE33).
- A separate wallet bought 2.2 UP for $2.00 from the book: [`0x3e414205…f9ff9621`](https://testnet.monadvision.com/tx/0x3e414205f412a52dff08f9afc0d9ba4b84f5e897a1b9c295811f428c74ff9621); sold it back for $1.82: [`0xc31bb2c4…e6e280`](https://testnet.monadvision.com/tx/0xc31bb2c4f4d262f51b3ffdb2b0ff9443126728b3c703849fd1779dbb7786e280). The $0.18 round trip is the quoted spread.
- 18 two-sided quotes in 11 minutes, listed in `rounds.md`.

**Gaps, stated plainly.** Testnet only; the maker is our own wallet, so the book proves the pipeline, not organic demand. Kuru mainnet market creation is owner-gated and we have no creation rights. The re-quote policy was tuned after a first run quoted too eagerly; re-run on 2026-10-11 it posted 3 quotes in the first 7 minutes of a round (the first run posted 18 in 11 minutes). That second round's teardown is pending gas, and `bestBidAsk()`'s price scale was found to differ between Kuru market implementations, which the app and service now handle.

---

## Bounty: Chainlink, "Best workflow with CRE"

**What we built.** A CRE workflow that is the orchestration layer: on a cron it reads the whole factory in one call through a lens contract, plans create, open, resolve and invalidate actions, fetches Data Streams evidence, and writes one signed report to `SchedulerReceiver` through the Keystone forwarder. A TypeScript fallback keeper does the same job if the DON is unavailable, arbitrated by an on-chain leader flag so the two never fight.

**Why it is meaningful.** Short rounds need exact timing and cannot afford a single point of failure. The workflow is built around CRE's real limit of 15 EVM reads per run (it uses 2) and the fallback means a CRE outage delays a round instead of stranding money.

**Where to look.**

- The workflow: [`services/scheduler/cre/scheduler/main.ts:98`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/services/scheduler/cre/scheduler/main.ts#L98) (`onCron`); the Data Streams request: [`main.ts:70`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/services/scheduler/cre/scheduler/main.ts#L70).
- Shared planner: [`packages/sdk/src/planner.ts`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/packages/sdk/src/planner.ts); the receiver: [`SchedulerReceiver.sol:27`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/contracts/src/scheduler/SchedulerReceiver.sol#L27).
- **Simulation against live Monad testnet (official CRE simulator, dry run):** 2 chain reads, 8 planned actions (3 creates, 5 invalidations) on 2026-10-10, and 1 planned action once the stranded rounds had been cleaned up on 2026-10-11 (the workflow follows the live state): [docs/evidence/cre/simulate-testnet.txt](https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/evidence/cre/simulate-testnet.txt) and [simulate-testnet-2026-10-11.txt](https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/evidence/cre/simulate-testnet-2026-10-11.txt). Reproduce: `bash scripts/cre/simulate-testnet.sh`.
- Real Chainlink data: the Chainlink push feeds on Monad mainnet were read round by round (155,440 BTC and 78,416 ETH updates) to measure their basis against Binance and their cadence ([REPORT.md](https://github.com/nisargpatel7042lva/converge-markets/blob/main/backtest/report/REPORT.md)); the resolver accepted real Chainlink proofs at all 72 boundaries of a mainnet-fork dry run ([docs/evidence/phase-2/mainnet-fork-dry-run.md](https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/evidence/phase-2/mainnet-fork-dry-run.md)); this document's MON/USD price is a live read of Chainlink on Monad mainnet.
- Reliability: a 3.0-hour real-time soak of the fallback path resolved 26 of 26 rounds, none missed ([docs/evidence/phase-2/soak-local.md](https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/evidence/phase-2/soak-local.md)).

**Gaps, stated plainly.** The CRE workflow has been simulated, **not deployed**: deployment needs CRE Early Access, which our account does not have yet. The simulation did not broadcast, so there is no CRE transaction to link. The rounds on testnet are created by the TypeScript scheduler. Data Streams has never run on a real report (no credentials), so on testnet the price report is signed by a test key.

---

## Bounty: Monad Foundation, "Best Mera-Powered UX"

**What we built.** Mera is the entire account layer. A passkey (WebAuthn PRF) gives 32 bytes; those bytes are the account. Nothing secret is stored. Signing happens in a session that exists for one confirmation and then zeroes the key. The approval and the order of one bet share a single passkey prompt.

**Why it is meaningful.** A prediction bet has to take seconds, from a phone, for someone who has never held a wallet. There is no seed phrase to lose, no extension, no sign-up form; the account is shown as a handle (`calm-otter-47`); a person can still leave: the recovery phrase, shown after a passkey prompt, derives the same address in MetaMask or Rabby.

**Where to look.**

- Create, restore on a new device, one-confirmation signing session, recovery export: [`account.ts:94`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/apps/web/src/lib/account.ts#L94), [`:112`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/apps/web/src/lib/account.ts#L112), [`:140`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/apps/web/src/lib/account.ts#L140), [`:162`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/apps/web/src/lib/account.ts#L162). Derivation that matches MetaMask: [`derive.ts`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/apps/web/src/lib/derive.ts).
- Mera is the only account layer, enforced by the build: [`scripts/check-deps.mjs`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/apps/web/scripts/check-deps.mjs).
- Proof: Playwright runs the real passkey flow in Chromium's virtual authenticator with PRF, with no test-only account: [`e2e/flows.spec.ts`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/apps/web/e2e/flows.spec.ts). The 10 end-to-end tests pass, with one caveat: in a full single-worker run the settlement test is order-dependent flaky (it failed in about half of today's full runs and passed alone 3 of 3), so a full run shows 9 or 10 passing (log: [docs/evidence/phase-10/e2e.txt](https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/evidence/phase-10/e2e.txt)); the timed first trade, from landing to a confirmed fill, took 4.9 s on a local chain ([Phase 7 report](https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/phases/PHASE-7-report.md)). Lighthouse on mobile (performance / accessibility / best practices), measured on the Phase 7 build before the later redesign: 98 / 100 / 100 on the landing page, 93 / 100 / 100 on stats.

**Gaps, stated plainly.** Not tested on a physical phone in this repository. Mera's passkey support depends on the device and browser (the PRF matrix is in [docs/EXTERNAL.md](https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/EXTERNAL.md)); an unsupported browser gets a plain-language explanation, not a crash.

---

## Bounty: Envio, "Best Use of Envio"

**What we built.** HyperIndex is the read side of the product: markets, trades, positions with average-cost PnL, vault NAV and APY history, epochs, partners and protocol totals, with a typed GraphQL client and a reconcile tool that compares indexed rows with the chain at the indexer's own block. The app's Earn page and My bets (including finished markets from earlier days) use it, and the stats page adds its daily-volume chart when an endpoint is configured, with the chain as the fallback for anything that must be exact, such as exits and claims.

**Why it is meaningful.** A prediction market's trust comes from history a user can check: what you traded, what the vault earned, what happened to each round. Computing realised PnL and APY from raw logs in the browser does not scale; an indexer does, and the reconcile tool shows the indexer agrees with the chain.

**Where to look.**

- Config (generated from the deployment file so addresses never drift), schema and handlers: [`indexer/config.yaml`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/indexer/config.yaml), [`schema.graphql`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/indexer/schema.graphql), [`handlers/`](https://github.com/nisargpatel7042lva/converge-markets/tree/main/indexer/src/handlers).
- 100 handler tests pass on the current `envio` 3.14.1 (`pnpm --filter @converge/indexer test`; log: [docs/evidence/phase-10/indexer-tests.txt](https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/evidence/phase-10/indexer-tests.txt)). The typed client: [`packages/sdk/src/indexer.ts:693`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/packages/sdk/src/indexer.ts#L693). App use: [`queries.ts:129`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/apps/web/src/lib/queries.ts#L129), [`:146`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/apps/web/src/lib/queries.ts#L146). Every query the app runs: [`indexer/QUERIES.md`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/indexer/QUERIES.md).
- **Against real testnet data (2026-10-11):** the indexer was run over a 7,600-block window of the live deployment (91 events). Its volumes equal what the keeper logged on chain (2 trades, 13,655,339 in one round and 1 trade, 1,960,780 in the next), all 6 internal invariants pass, 27 of 29 sampled entities match the chain (the other 2 differ by exactly the first LP deposit, which settled before the window), and the app's stats and Earn pages query it: [docs/evidence/phase-10/envio-testnet-window.md](https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/evidence/phase-10/envio-testnet-window.md). Run it yourself: [`scripts/indexer/run-local-testnet.sh`](https://github.com/nisargpatel7042lva/converge-markets/blob/main/scripts/indexer/run-local-testnet.sh) indexes the live testnet deployment locally with no token. Local backfill and lag evidence: [docs/phases/PHASE-6-report.md](https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/phases/PHASE-6-report.md).

**Gaps, stated plainly.** **The indexer is not hosted yet.** A deployment on Envio Cloud (branch `envio`, indexer directory `indexer`) is in progress, so the stats page derives its judge-facing numbers from the chain instead of the indexer. Backfill speed and lag were measured against a local indexer on an RPC source, not against HyperSync.

---

## Anything else worth a judge's time

- The partner API: another Monad app creates a price-threshold market from an approved template with one SDK call and gets depth from the vault under per-partner and global caps ([docs/partners.md](https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/partners.md)). The registry is deployed on testnet ([`0xB50b2Ce1…129E`](https://testnet.monadvision.com/address/0xB50b2Ce17704A15642743F528f91bF7EeD02129E)); the end-to-end partner demo on file ran on a local chain.
- Security: [docs/security/internal-audit.md](https://github.com/nisargpatel7042lva/converge-markets/blob/main/docs/security/internal-audit.md); the invariant runs found a real solvency bug that two reviews missed.
