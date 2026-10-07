# @converge/sdk

Put a prediction market on your Monad app, with the Converge Vault's liquidity behind it.

A partner app creates a **price-threshold market** ("will ETH be at or above $3,200 at 20:00 UTC?"), and the vault quotes both outcomes within a block or two, under hard caps. Your users trade from your page; you earn a share of the redeem fee. The SDK is a thin, typed wrapper over [viem](https://viem.sh): it works with any viem public and wallet client, and it never holds keys.

```sh
pnpm add @converge/sdk viem
```

## Quickstart

```ts
import { createPublicClient, createWalletClient, http } from "viem";
import { monadTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { createConvergeClient, DataStreamsRestSource } from "@converge/sdk";
import addresses from "./converge-addresses.json"; // { registry, vault, venue, collateral }: deployments/<network>.json

const account = privateKeyToAccount(process.env.PARTNER_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain: monadTestnet, transport: http() });
const walletClient = createWalletClient({ account, chain: monadTestnet, transport: http() });
const converge = createConvergeClient({ publicClient, walletClient, addresses });

// 1. create the market: you must be an approved partner with a bond (docs/partners.md)
const { market } = await converge.createPartnerMarket({ asset: "ETH/USD", strike: "3200", end: new Date("2026-10-08T20:00:00Z") });
// 2. the vault's prices for both outcomes (spot: the asset's current price, for the indication)
const quotes = await converge.getQuotes(market, { spot: 3150 });
console.log(quotes.up.ask?.price, quotes.down.ask?.price);
// 3. a user buys 5 USDC of UP; a keeper fills it ~2 s later at the oracle price of that second
const order = await converge.buy({ market, side: "UP", amount: "5", spot: 3150 });
console.log(await converge.waitForFill(order.orderId));
// 4. follow every fill (the indexer if you pass `indexer: { url }`, else the vault's events)
converge.subscribeFills({ market }, (f) => console.log(f.action, f.side, f.price));
// 5. after the end: submit the oracle price, then the winners redeem
const reports = new DataStreamsRestSource(process.env.DS_URL!, process.env.DS_KEY!, process.env.DS_SECRET!);
await converge.resolve(market, { reports });
await converge.redeem(market);
```

## The API

| Call | What it does |
| --- | --- |
| `createPartnerMarket({ asset, strike, end })` | Creates the market through the `PartnerRegistry`. It is open at once. Reverts with the contract's error name (`BondTooLow`, `FeedNotAllowed`, `InvalidDuration`, …). |
| `getMarket(market)` | Terms, state, phase (`LIVE`, `RESOLVING`, `SETTLED`), strike, end price, partner, whether the vault is quoting it. |
| `getQuotes(market, { spot, at? })` | Bid and ask for UP and for DOWN with the size at each, and the implied probability. `quoting: false` when there is no depth. |
| `buy({ market, side, amount, spot, slippageBps? })` | Approves the venue if needed and places an order. The order never pays more than the shown price plus the slippage; unspent escrow is refunded. |
| `sell({ market, side, shares, spot, slippageBps? })` | The mirror image: never receives less than the shown bid minus the slippage. |
| `waitForFill(orderId)` | Resolves with `EXECUTED` (and the shares and premium) or `EXPIRED`. |
| `expireOrder(orderId)` | Refunds an order nobody executed in time. |
| `resolve(market, { reports })` | After the end: fetches the oracle report for the end time, submits it, waits for the oracle's window and finalizes. Anyone can call it. |
| `redeem(market)` | Burns the signer's UP and DOWN of a resolved market and pays out. |
| `getPosition(market, account?)` | UP and DOWN balances and what `redeem` would pay. |
| `subscribeFills({ market? }, onFill)` | Calls you for every fill. Returns the unsubscribe function. |

Helpers: `parseStrike("3200.5")`, `assetIdFor("ETH/USD")`, `formatStrike(bigint)`, plus the lower-level transaction builders in `trade.ts` (`planBuy`, `placeOrderTx`, `redeemTx`, …) and the typed indexer client (`createIndexerClient`) if you want to build your own flow. ABIs for every contract are exported (`partnerRegistryAbi`, `convergeVaultAbi`, …).

## How trading works

- **Forward-priced.** A trade is an order; about two seconds later a keeper executes it at the oracle report for that second. The price you show from `getQuotes` is an indication, and the **limit price** (the slippage you pass) is the guarantee. If the market moves past the limit the order simply does not fill and the escrow comes back.
- **Prices** are numbers between 0 and 1 (1.00 is what a winning share pays). **Amounts** are collateral units as decimal strings; **shares** are the collateral's base units (6 decimals for USDC).
- **Strike** is in the oracle's 18-decimal scale; pass a decimal string and the SDK scales it.
- **Settlement.** Up wins if the oracle price at the end is at or above the strike (a tie goes UP). If the oracle cannot produce the price, the market is invalid and every share pays 0.5.
- **Exits.** Nothing in the partner programme can stop a holder from redeeming a resolved market or merging a pair.

## Errors

Every error the SDK raises on purpose is a `ConvergeError` with a `code`: `NO_WALLET`, `NOT_QUOTING`, `BAD_INPUT`, `NOT_RESOLVED`, `TIMEOUT`, `REVERTED`, `NO_REPORT`. Calls that send a transaction are simulated first, so a revert surfaces with the contract's custom error name before any gas is spent.

## Requirements and status

- Node 20 or newer, viem ^2.54 (a peer dependency).
- The partner programme is on **Monad testnet**; the oracle there is a mock verifier with a test signer, so a report source for testnet is `TestSignerStreamsSource`. On mainnet use `DataStreamsRestSource` with Chainlink Data Streams credentials.
- The integration guide, the economics and the risk limits are in [docs/partners.md](../../docs/partners.md).
