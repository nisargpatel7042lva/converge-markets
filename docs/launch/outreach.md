# Outreach: DM templates and tracking

Rules for every message: say **testnet and test money** in the first two lines; never say "audited" (it is internally reviewed twice, not externally); never quote a return or APY (the backtest gives sensitivities that depend on volume we have not seen); one clear ask; keep it under 90 words. Facts to use are in [../numbers.md](../numbers.md). Nothing here claims a relationship, partnership or conversation that has not happened.

## 1. Monad traders

**Ask:** try one round on testnet and tell me where it felt wrong.

> Hey [name], I'm building Converge: 15-minute UP/DOWN rounds on Monad where one vault makes the market, so a new round isn't empty. It's on testnet with test money, no real funds, no seed phrase (Face ID passkey).
>
> Could you place one bet and tell me what felt off, especially the 2-second fill? [app link] takes about a minute. Honest feedback is the whole ask. Thanks.

Follow-up after 3 days, once: "No pressure. If you tried it, even a one-line reaction helps."

## 2. Liquidity providers (LP farmers)

**Ask:** deposit test USDC into the vault and report what you'd need to see before depositing real money.

> Hey [name], Converge is a vault that quotes every 15-minute prediction round on Monad. LP returns come from spreads only, no token emissions, and you can lose money: loss limits are 1% of the vault per market and 8% in total, enforced on chain.
>
> It's testnet with free test USDC. I'd value your read on the risk page and what you'd need to see first (audit, caps, track record). [vault page link]. Not financial advice, no yield promised.

Follow-up once after 3 days. Never mention a percentage return.

## 3. Potential partner apps (for example Kizzy, CRSH)

**Ask:** a 20-minute call, or an honest "this doesn't fit".

> Hi [name], I'm Nisarg. Converge is a Monad vault that quotes short UP/DOWN markets. We built a partner API: an approved app creates a price-threshold market with one SDK call and the vault quotes it under per-partner and global caps, so a new market isn't empty. It's live on testnet (registry [address]); the end-to-end demo I have is on a local chain.
>
> Does depth for new markets matter to you? If so, I'd show it in 20 minutes. If not, tell me why, that helps too. [docs/partners.md link]

Notes: do not reference any post-mortem or private conversation unless you have the link or the permission. Do not imply a partnership. If they ask about audits, say: "internally reviewed twice, external audit pending".

## Tracking

Update after every send and every reply. "Status" is one of: not contacted, sent, replied, call booked, trying it, declined, no reply after follow-up.

| Name or handle | Segment | Channel | Template | Date sent | Follow-up due | Reply (one line) | Status | Next step |
|---|---|---|---|---|---|---|---|---|
| Kizzy | Partner app | X DM | 3 | | | | not contacted | Find the right person; link the post-mortem only if verified |
| CRSH | Partner app | X DM | 3 | | | | not contacted | Confirm the correct handle first |
| [trader 1] | Monad trader | X DM | 1 | | | | not contacted | |
| [trader 2] | Monad trader | X DM | 1 | | | | not contacted | |
| [LP 1] | LP | X DM | 2 | | | | not contacted | |
| [LP 2] | LP | X DM | 2 | | | | not contacted | |

## What to record from every reply

1. Did they place a bet or deposit? (the only traction that counts)
2. The first thing that confused them.
3. Whether the 2-second fill, the 50-cent refund on a cancelled round, or the risk page was the sticking point.
4. Any request we can ship in a day.
