# Phase 8 report: liquidity-as-a-service for other Monad apps

**Status: COMPLETE WITH CAVEATS.** A third-party app can create a price-threshold market from an approved template through the public SDK and get two-sided depth from the Converge Vault under caps that the vault enforces itself. Built, tested (377 contract tests, 97 SDK tests, 108 keeper unit tests plus three anvil end-to-end suites, 100 indexer tests, 9 demo tests), reviewed twice by a hostile subagent, and demonstrated end to end on a local chain with the real contracts and the real keeper. **Not done: the testnet deployment and the testnet demo (acceptance criterion 2).** The testnet needs about 2.2 MON of gas for the contracts alone (simulated: 21.16 M gas at 102 gwei); the deployer holds 0.26 MON and the faucet is web-only. Everything is one command away once the account is funded (`contracts/script/deploy-partners.sh`, then `examples/partner-demo/scripts/run-demo.ts`). Nothing below claims a testnet result.

## What was built

- **Contracts** (ADR-008, `docs/adr/ADR-008-partner-liquidity.md`):
  - `contracts/src/partners/PartnerRegistry.sol`: a second market factory. The owner approves partners with an exposure cap, a fee share and a feed allowlist; partners post a bond in collateral; `createThresholdMarket(feed, strike, end)` clones the standard `Market` and tokens and opens the market in the same transaction (start = now, 15 minutes to 7 days). The owner can slash a bond (to the vault by default), void a market, suspend a partner; the guardian can pause and suspend. Bond withdrawals wait 7 days and 24 hours after the last market ends. Redeem fees (default 0.5 %, at most 1 %) are split by a per-market fee-share snapshot between partner and treasury, pulled with `withdrawFees`.
  - `contracts/src/resolvers/ThresholdResolver.sol`: a one-market resolver that pins the strike for the start boundary and forwards the end price to the real Data Streams resolver. `Market` itself is untouched.
  - `contracts/src/vault/ConvergeVault.sol` (vault v4): one-time `setPartnerRegistry`; a second branch in the market check; per-partner and global exposure caps and `maxPartnerFraction` of NAV (default 10 %, ceiling 30 %) enforced on every `splitForInventory` from the vault's own position table; 6 partner slots of 16, 3 per partner; an active-status gate on new allocation, quoting and fills. Nothing else changed.
  - `contracts/src/vault/QuoteMath.sol`: `d2` saturates when `spot / strike` rounds to zero (found by the review, see below).
  - `contracts/script/DeployPartners.s.sol`, `deploy-partners.sh` (with `DRY_RUN=1`).
- **SDK** `packages/sdk`: `createConvergeClient` with `createPartnerMarket`, `getMarket`, `getQuotes`, `buy`, `sell`, `waitForFill`, `expireOrder`, `resolve`, `redeem`, `getPosition`, `subscribeFills` (indexer, else vault events), `getPartner`, `postBond`, `withdrawFees`. Full TSDoc, publish-ready `package.json` (tsup build, `publishConfig`, peer dependency on viem, MIT licence), `scripts/check-pack.mjs` (packs the tarball, checks its contents and loads it in plain Node), README with a quickstart of at most 20 lines of code (a test enforces it and checks the methods exist).
- **Keeper** `services/keeper`: reads `vault.partnerRegistry()` (no configuration), notices a new partner market within about a block, mirrors the caps when sizing splits, gives each of a partner's markets a third of its cap, funds only strikes within 5x of its own spot, merges the pairs of inactive partner markets, submits the end price of partner markets the vault traded in.
- **Indexer** `indexer`: follows the registry the vault announces (`PartnerRegistrySet`): markets carry `partner` and `voided`; a `Partner` entity tracks caps, bond, pending withdrawals, slashes, voids, fees and allowed feeds.
- **Demo** `examples/partner-demo`: a Next.js page ("Will ETH be at or above $3,200 at 20:00 UTC?") with live Yes/No prices and the dollars behind each, a demo account or browser wallet, buy, live fills, collect after settlement; `lib/flow.ts` is the whole journey as one function; `scripts/create-market.ts` and `scripts/run-demo.ts` are the CLIs. `check:sdk-only` fails if it imports anything but react, next, viem or the root of `@converge/sdk`.
- **Docs**: `docs/partners.md` (integration guide, economics, risk limits, governance), ADR-008, `docs/security/threat-model.md` section 8, `docs/EXTERNAL.md` (Phase 8 additions), `docs/phases/PHASE-8-plan.md`.

## How to verify it yourself

```bash
export PATH=$HOME/.foundry/bin:$HOME/.local/bin:$PATH
make check-8                                  # everything below; ~10 min; ends with "check-8 OK"
cat docs/evidence/phase-8/check-8.txt         # the saved output of the last run
cat docs/evidence/phase-8/anvil-demo.json     # the journey: create, quote, trade, resolve, redeem
cd contracts && DRY_RUN=1 bash script/deploy-partners.sh   # the testnet deployment, simulated: gas and MON
```

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `make check-8` passes (contract tests incl. cap enforcement, SDK tests) | **PASS.** forge 377 passed, 0 failed, 1 skipped (a fork test); forge lint and fmt clean; slither exit 0 (no medium/high); coverage gate: vault 99.3 %, venue 100 %, QuoteMath 100 %, PartnerRegistry 99.3 %, ThresholdResolver 100 %; SDK 97, keeper 108, indexer 100, demo 9, plus the pack check, the config freshness check, the demo build and `check:sdk-only` | `check-8.txt`, `coverage-summary.txt`, `slither.txt` |
| 2 | Demo on testnet: create via SDK, quotes within 2 blocks, trade, resolve, redeem; evidence saved | **NOT MET on testnet (BLOCKED: funds).** **Met on a local anvil chain** (0.4 s blocks, the real contracts, the real keeper, a test-signer oracle, only the public SDK): quoted **1 block** after creation (587 ms), buy filled in 3.1 s at 0.55 for 5.40 shares, a subscription saw the fill, resolved above the strike, redeemed, +2.40 USDC net. With a 5 s slow tick the quote still arrives within 3 blocks (`partners-kick.test.ts`; it fails without the per-block registry look: 8 blocks). Monad's inclusion time is 0.5 to 1.5 s, so expect 2 to 4 blocks there, not measured | `anvil-demo.json`, `check-8.txt` |
| 3 | Caps proven by tests (a partner cannot pull more than its cap of vault liquidity) | **PASS for the collateral the vault splits into a partner's markets**: single market, sum over markets, 40 one-unit splits, per partner, global, vault fraction, lowered cap, slots; and a stateful suite (256 runs x 100 calls) with a hostile keeper asking for arbitrary amounts while the owner changes caps, suspends and voids, checking after every accepted allocation. **Stated precisely, not rounded up:** the cap bounds split collateral; the vault's directional trading loss in a partner market is bounded by the per-market loss ceiling (1 % of NAV) and the 8 % total, not by the cap (tests drive sells into a market with a 40 USDC and a 1 USDC cap) | `VaultPartners.t.sol`, `PartnerCapInvariants.t.sol` |
| 4 | Hostile review: no open CRITICAL or HIGH | **PASS** after two rounds (below) | this report |

## Test summary

forge 377 (new: PartnerRegistry 36, VaultPartners 30, DeployPartners 3, PartnerCapInvariants 3 properties, QuoteMath regression); SDK 97 (new: partner client 38, README 3); keeper unit 108 (17 new planner cases) and anvil integration: `partners` (7 steps through the public SDK), `partner-demo-flow`, `partners-kick`; indexer 100 (new: partner 4, ABI parity of the registry events); demo 9. The anvil suites were run 8 times in a row after the last fixes without a failure; earlier they showed a timing flake (a taker order not executed inside the venue's 4 s window on a loaded machine; the order then expires and refunds): the SDK-level tests now place it again, as a user would, and the demo flow records `orderAttempts`. Each starts its own anvil, so `check-8` runs them one at a time.

## Hostile review (subagent, senior auditor and product reviewer)

- **Round 1: 0 CRITICAL, 3 HIGH, 10 MEDIUM, several LOW.** All three HIGH fixed with a regression test each:
  - **H1** a partner strike far above the spot (accepted by the registry) made `QuoteMath.d2` call `lnWad(0)`; one donated outcome token then froze the vault's checkpoint, epoch settlement and every fill for the life of the market, with no on-chain remedy. Fixed in `d2`, the registry bounds strikes to `int192.max`, the keeper funds only strikes within 5x of its spot; reproduced and then verified (the test fails with `LnWadUndefined` without the fix; a 20k-run fuzz of the math over the full range found no other revert).
  - **H2** `Market.claimFees` is permissionless and paid the registry with no accounting, stranding fees. Fixed with `liabilities` accounting, credit by the market's reported accrual and `sweepStray`.
  - **H3** the SDK's log scans ignored Monad's 100-block `eth_getLogs` limit. Fixed: windows of at most 90 blocks, a two-block overlap with deduplication.
  - MEDIUMs fixed: the "cap" claim reworded to what it bounds and tested; a single partner could hold all partner slots (3 per partner now) and the keeper gave the first market the whole cap (a third each); inactive partner markets were never unwound; a partner market the vault emptied was never resolved; the indexer missed `PartnerFeedSet` and counted voids twice; the deploy script now announces the registry to the vault before approving partners; keeper RPC cost (candidate cap, short caches, a rate limit on the pickup); demo page (a zero-fill was shown as a fill, a failed spot price fell back to the strike); SDK footguns (an unscaled bigint strike, `resolve` after the oracle's grace, `canCreate` ignoring the pause, indexer priming); evidence regenerated, now recording who submitted the end price and who finalized.
- **Round 2: 0 CRITICAL, 0 HIGH.** H1 and H3 FIXED; H2 PARTIAL (see open items); M1 and M4 and M6 FIXED; M2, M3, M5, M8, M9 PARTIAL; M7 and M10 open at the time. Round 2 also found new problems in the round-1 fixes, all fixed: the candidate list could starve the newest markets (running markets now come first), a partner's second market got no depth (a fixed third of the cap per market), the SDK `resolve` re-sent the report every 1.5 s (once now, then polls), unthrottled pickup, a stale evidence file (regenerated with the final code).

## Deviations from the spec and ADRs written

- **ADR-008** (new). Deviation: "price-threshold markets on **any** Chainlink feed" is delivered as any **Data Streams** feed the owner has onboarded (three owner calls) **and that has an 18-decimal price**: Chainlink's v3 streams carry 8 or 18 decimals depending on the stream, and the vault and markets assume 18 (as the core markets always did). Push-feed assets (round proofs) get no vault depth.
- The template is a **new market source beside the v1 contracts**, not a change to them (v1 is immutable): `PartnerRegistry` + `ThresholdResolver` clone the existing `Market`; this needs **a new vault (v4) and venue on testnet**, as v2 to v3 did. Vault v3 stays on chain, archived in `deployments/testnet.json` by the script.
- "Keeper picks them up automatically": yes, from `vault.partnerRegistry()`.
- "Subscribe to fills via the indexer": `subscribeFills` uses the indexer when configured and the vault's on-chain events otherwise. The hosted indexer is still BLOCKED (no token), so the indexer path is tested with a stub endpoint and the handlers with mock events, not against a running indexer.
- Added beyond the spec: `getPartner`, `postBond`, `withdrawFees`, `expireOrder`, `resolve` in the SDK (a partner cannot operate without them); the per-market third of the cap and the 3-slot limit (found necessary by the review).

## Known issues and risks (specific, no rounding up)

1. **No testnet run.** The 2-block claim is shown on a local chain only. Expect 2 to 4 blocks on Monad.
2. **Fee diversion (MEDIUM, open).** Anyone can call `Market.claimFees()` right after a redeem; the registry cannot attribute it, so `sweepStray` credits it to the treasury and the partner's share is lost. A griefer pays only gas. Fix (v2): a per-market fee sink contract as `feeRecipient`. Partners should `collectFees` right after redeems.
3. **Dust pins a slot (MEDIUM, open).** One wei of an outcome token donated to a registered market stops the vault pruning it after its pairs are merged, so an unwanted partner market keeps its slot until it ends (up to 7 days). Slots are bounded (6, 3 per partner), so it delays other partners and does not lose funds. Fix (v2): a dust threshold in `pruneEmpty`.
4. **Partner losses draw on the same loss budget as the core rounds** (1 % per market, 8 % total of NAV), and a 7-day market is quoted near its widest for days; unmatched tokens in it are valued in a wide NAV band. Caps bound it; they do not remove it.
5. **Governance is one owner** (a Safe on mainnet): no void undo, no partner revoke (only suspend), fees owed cannot be slashed, a bond withdrawal's date is fixed at request time, the treasury fee credit is keyed by the address at collection time. No dispute process.
6. **A strike nobody should trade** is accepted by the registry; the keeper does not fund it (5x band) and the vault now survives it, but another keeper without that guard would fund it; the bond and `voidMarket` are the remedy.
7. **The testnet oracle is a mock** with a test signer: any feed id verifies there and whoever holds the signer decides prices. Mainnet needs real feed ids and credentials.
8. **Keeper timing.** Orders must be executed inside 2 to 6 seconds of placement; on a loaded machine an order can expire and refund (seen in the anvil suites before the retry logic; the product behaviour is "place it again"). `check-8` runs the anvil suites one at a time for this reason.
9. **Vault v4 is 42 KB**, above Ethereum's 24 KB limit; it relies on Monad's 128 KB limit (`code_size_limit` in `foundry.toml`), as v3 did. The coverage build of the deploy script exceeds even that, so `DeployPartnersTest` is excluded from the coverage run only.
10. **Gas snapshot** (`contracts/.gas-snapshot`) was regenerated: the vault grew and every vault test deploys it, so existing tests' gas moved; no test was changed to get there.
11. The SDK package name `@converge/sdk` and the MIT licence file are my choices to match the SPDX headers; the npm scope must exist before publishing, and nothing was published.

## Needs from Nisarg

1. **About 3 MON of testnet gas** to the deployer `0xe36848e8654a86Fd2F7f97DDB3C56042fFD54dd1` (2.2 for the deployment; the rest for the demo wallets), and about 0.3 MON each to the demo partner and trader addresses (generated into `.env` as `PARTNER_PRIVATE_KEY` and `TAKER_PRIVATE_KEY`; run `cast wallet address --private-key …` locally to read them, they were never printed). Then: `bash contracts/script/deploy-partners.sh`, restart the keeper against the new vault, `pnpm --filter partner-demo exec tsx scripts/run-demo.ts` (about 20 minutes: the shortest market is 15). That produces `docs/evidence/phase-8/testnet-demo.json` and closes criterion 2.
2. **Mainnet governance values** (testnet demo values in brackets): minimum bond [10 USDC], per-partner cap [40 USDC], all partners together [500 USDC; vault fraction 10 % of NAV], redeem fee [0.5 %], partner fee share [30 %], and whether a slashed bond goes to the vault [the script sets the vault] or the treasury.
3. **Which feeds to onboard first**, each needing a real 18-decimal Data Streams feed id on mainnet.
4. **The licence and the npm scope** for `@converge/sdk` before it is published.
5. Older items still open: the Phase 5 2 h live run, the Phase 7 phone test, the hosted Envio token, ADR-007's gas decision, the region list, legal review.

## Readiness for the next phase

**Yes for Phase 9 (security hardening + mainnet beta) on the code**, with two conditions: the testnet run above should happen first (it is the only place the 2-block claim and the keeper's behaviour on Monad's timing can be measured), and the two open MEDIUMs (fee diversion, dust pin) should be fixed with the Phase 9 contract changes since they need a redeploy anyway.
