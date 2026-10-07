# ADR-007: Gas for a new passkey account, and onboarding

- Status: **Proposed. DECISION NEEDED from Nisarg** (the default below is implemented behind a switch)
- Date: 2026-10-07
- Numbering: the Phase 7 prompt calls this "ADR-004"; ADR-004 already exists (forward-priced execution), so this is ADR-007.
- Builds on: ADR-001 (venue), ADR-004 (forward-priced execution), ADR-005 (vault), Mera (EXTERNAL.md)

## Context

A Mera account is an EOA whose key is derived from a passkey's PRF output. It starts with **no MON**, and on Monad every transaction (the approval, the order, a claim) pays gas in MON, billed on the gas limit (about 0.001 to 0.07 MON per action on testnet at 102 gwei, see `docs/evidence/phase-5/costs.md`). A user who has to find MON before their first trade has already left. The target is landing to first trade in under 60 seconds with no wallet jargon.

## Options

1. **Gas drip from a minimal relayer (implemented as the default).** After an account's first stablecoin deposit, a server route sends one small MON top-up (testnet default 0.05 MON, enough for about 10 small actions). Abuse limits: eligibility is read from the chain (account has never sent a transaction, holds less than the drip, holds at least 1 unit of the stablecoin), one drip per address and per IP window, a global daily budget, a hard cap on the amount. The relayer holds one hot key with a small balance; a leak costs at most the balance. It is a custody-free helper (it never holds user funds or keys) but it is a server we run and fund.
2. **EIP-7702 sponsored transactions.** The Mera account (an EOA) delegates to a sponsor contract for one transaction and a relayer pays the gas. viem's `signAuthorization` is supported by `toViemAccount` (the Mera adapter signs EIP-7702 authorizations). **Not verified on Monad**: whether the chain accepts type-4 transactions is not recorded in any source we verified (EXTERNAL.md). Nothing is built on it until verified (one `eth_estimateGas` of a type-4 transaction on testnet answers it).
3. **ERC-4337 paymaster / bundler.** Needs a smart account (a contract wallet), which Mera does not create (it is a plain EOA from a passkey, "without adding smart-account contracts"); adopting it changes the account model and breaks "exportable to MetaMask with the same address". Rejected for v1.
4. **The vault or the venue pays.** The venue already takes a native reward from the taker for executors; the taker still needs MON to place the order. Rejected.
5. **Users bring MON** (faucet link, exchange). Honest but fails the 60 second bar; kept as the fallback when the drip is off or exhausted.

## Decision (default, to be confirmed)

Option 1 now, with the amount, the budget and the eligibility rule in env (`DRIP_WEI`, `DRIP_DAILY_BUDGET_WEI`), disabled unless the relayer key is configured. Option 2 is the preferred long-term answer **if** Monad supports type-4 transactions: no relayer balance is spent on accounts that never trade, and the user never holds MON at all. It needs a decision and one verification.

## Consequences

- A funded hot key on the server (Vercel env var `DRIP_PRIVATE_KEY`, never committed, never returned to the browser). Its balance bounds the loss.
- On serverless the per-IP and global counters are best effort (in-memory per instance). The chain-derived rule (one drip per address because the account must have nonce 0 and a low balance) is the real limit; a production deployment needs a KV store for the IP and daily budget counters.
- Sybil drip farming (many passkeys): bounded by the daily budget and by requiring a stablecoin deposit first; not prevented. On mainnet "first stablecoin deposit" means a real deposit, which makes farming cost real money.
- Analytics event `funded` fires when the drip lands, for the funnel.

## Needs from Nisarg

1. Confirm option 1 as the default for the demo, or choose another.
2. A funded relayer key (0.5 MON is plenty for the demo) set as `DRIP_PRIVATE_KEY` in Vercel.
3. Approve a one-off verification of EIP-7702 on Monad testnet (an `eth_estimateGas` of a type-4 transaction), which decides whether option 2 replaces option 1.
