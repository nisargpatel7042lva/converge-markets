# The indexer on Envio Cloud (2026-10-13)

The HyperIndex indexer (`indexer/`, Envio 3.14.1) is deployed on Envio Cloud from the `envio` branch (commit `a3371f9`, root directory `indexer`, region EU, Development plan) and the live app reads from it.

| | |
|---|---|
| Endpoint (public) | `https://indexer.dev.hyperindex.xyz/33a020f/v1/graphql` |
| Deployment (dashboard) | Active; Monad Testnet (10143) synced 100%, block 70,689,476 of 70,689,478; 830 events processed; 196 addresses; source HyperSync (about 1,140 requests a minute); historical sync took 1 minute |
| Health query | `{ _meta { chainId progressBlock sourceBlock isReady eventsProcessed } }` returned chain 10143, `isReady: true`, 2 blocks behind the source, 830 events |
| What it holds | 4 assets (BTC, TEST, TEST-BTC, TEST-MON: the last two were added on 2026-10-11); 64 markets, 43 resolved; 15 trades; 7 users; volume 149.364021 USDC (149,364,021 base units); vault value 4,010.048925 USDC; 204 sampled entities |
| Browser access | A preflight from `https://converge-markets-app.vercel.app` is answered with that origin allowed (CORS), so the app can query it directly |
| In the live app | `NEXT_PUBLIC_INDEXER_URL` is set on the Vercel production environment. A headless-browser visit to `/stats` on the deployed site made 4 requests to the endpoint, all HTTP 200, with no console errors, and the page says "Read straight from Monad testnet and the open indexer" |

## What this found

- **No aggregate queries.** The hosted endpoint has entity roots but no `*_aggregate` roots. The app and the SDK never use them; the reconcile and latency tools did, so reconcile now skips its row-count cross-check when they are missing and says so.
- **Rate limit on bursts.** Sequential requests were fine at about 4 a second (80 of 80 answered), but parallel bursts got HTTP 429. Reconcile now spaces its requests and backs off, and the app's queries retry once (`queries.ts`). The Development plan's limits are Envio's, not ours.
- **No static endpoint on this plan.** "Promote to production" needs a paid plan, so the endpoint URL belongs to this deployment: a new push to the `envio` branch creates a new deployment with a new URL, which would have to be set again on Vercel (the variable is baked in at build time).

## Honest limits

- The indexer's history starts at the factory's deploy block (68,426,048); it holds this testnet's data, played with test money.
- The reconcile run against this endpoint samples every indexed entity and compares it with direct chain reads at the same block; its result is recorded in `reconcile-hosted.md` when it completes (the earlier run, against a local indexer on a 7,600-block window, is in `envio-testnet-window.md`).
- Backfill speed was measured against HyperSync here (1 minute for 830 events); earlier local numbers were against an RPC source.
