# ADR-007: Gas for a new passkey account, and onboarding

- Status: **Proposed. DECISION NEEDED from Nisarg** (the default below is implemented behind a switch)
- Date: 2026-10-07
- Numbering: the Phase 7 prompt calls this "ADR-004"; ADR-004 already exists (forward-priced execution), so this is ADR-007.
- Builds on: ADR-001 (venue), ADR-004 (forward-priced execution), ADR-005 (vault), Mera (EXTERNAL.md)

## Context

A Mera account is an EOA whose key is derived from a passkey's PRF output. It starts with **no MON**, and on Monad every transaction (the approval, the order, a claim) pays gas in MON, billed on the gas limit (about 0.001 to 0.07 MON per action on testnet at 102 gwei, see `docs/evidence/phase-5/costs.md`). A user who has to find MON before their first trade has already left. The target is landing to first trade in under 60 seconds with no wallet jargon.

## Options

1. **Gas drip from a minimal relayer (implemented as the default).** A server route sends a small MON top-up to an account that holds less than the app's gas reserve (0.05 MON, one constant shared by the trade sheet, the funding page and the relayer) **and** has deposited at least $1 of the stablecoin. Testnet drip: 0.1 MON (the reserve plus the 0.001 MON order reward plus margin). It can top the same account up again after 24 hours (a winner who spent their gas can still claim). Abuse limits: per-IP and per-address cooldowns, a daily budget, a hard cap on the amount, one in-flight request per address, one send at a time from the hot key. A separate testnet-only faucet route mints free test dollars and tops up gas from its own, smaller budget so it cannot drain the real drip. The relayer holds one hot key with a small balance; a leak costs at most the balance. It never holds user funds or keys, but it is a server we run and fund.
2. **EIP-7702 sponsored transactions.** The Mera account (an EOA) delegates to a sponsor contract for one transaction and a relayer pays the gas. viem's `signAuthorization` is supported by `toViemAccount` (the Mera adapter signs EIP-7702 authorizations). **Not verified on Monad**: whether the chain accepts type-4 transactions is not recorded in any source we verified (EXTERNAL.md). Nothing is built on it until verified (one `eth_estimateGas` of a type-4 transaction on testnet answers it).
3. **ERC-4337 paymaster / bundler.** Needs a smart account (a contract wallet), which Mera does not create (it is a plain EOA from a passkey, "without adding smart-account contracts"); adopting it changes the account model and breaks "exportable to MetaMask with the same address". Rejected for v1.
4. **The vault or the venue pays.** The venue already takes a native reward from the taker for executors; the taker still needs MON to place the order. Rejected.
5. **Users bring MON** (faucet link, exchange). Honest but fails the 60 second bar; kept as the fallback when the drip is off or exhausted.

## Decision (default, to be confirmed)

Option 1 now, with the amount and the budgets in env (`DRIP_WEI`, `DRIP_DAILY_BUDGET_WEI`, `FAUCET_DAILY_BUDGET_WEI`), disabled unless the relayer key is configured. Option 2 is the preferred long-term answer **if** Monad supports type-4 transactions: no relayer balance is spent on accounts that never trade, and the user never holds MON at all. It needs a decision and one verification.

## Consequences

- A funded hot key on the server (Vercel env var `DRIP_PRIVATE_KEY`, never committed, never returned to the browser). Its balance bounds the loss.
- On serverless every counter (IP, address, daily budget) is in memory per instance and resets on a cold start: **they are best effort, not a guarantee**. A production deployment needs a shared store (KV) for them; the hot key's balance is the only hard bound until then.
- Sybil drip farming (many passkeys): bounded by the daily budget, the $1 deposit gate and the per-IP limit; **not prevented, and a $1 deposit is not a meaningful cost on a test network or for a determined attacker with real dollars to recycle** (the dollar is theirs again after withdrawal). If farming matters, raise the gate or require a larger first deposit.
- Analytics event `funded` fires once the account holds both a stablecoin balance and the gas reserve.
- The numbers: a keeper execution costs 0.068 MON (paid by the keeper, `docs/evidence/phase-5/costs.md`); the user's own `approve` and `placeOrder` gas on Monad testnet was **not measured** (no run with the app on testnet yet), so the reserve is a generous estimate, not a measurement.

## Needs from Nisarg

1. Confirm option 1 as the default for the demo, or choose another.
2. A funded relayer key (0.5 MON is plenty for the demo) set as `DRIP_PRIVATE_KEY` in Vercel.
3. Approve a one-off verification of EIP-7702 on Monad testnet (an `eth_estimateGas` of a type-4 transaction), which decides whether option 2 replaces option 1.
