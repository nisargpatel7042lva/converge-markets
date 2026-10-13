# Converge pitch video, long cut (2:44): script for the AI voiceover

> The submission form allows a pitch of up to 2 minutes: use [SCRIPT-2min.md](SCRIPT-2min.md). This longer cut is kept for other uses.

**Length:** about 2:43 at a normal reading pace (373 words, 150 words a minute). Paste the plain text below into your voice tool. The captions in the video are burned in from this same text, so keep the words as written.

**The angle:** liquidity stops being something every market has to beg for and becomes infrastructure. The video is bold about the idea and exact about the evidence: every figure is in [numbers.md](../numbers.md), and it says *testnet, test money, no outside users yet* on screen and aloud.

## Copy-paste voiceover

```text
Every prediction market dies the same way. It opens empty. No price. No counterparty. The first trader finds nothing, and walks away. A fifteen-minute market does that ninety-six times a day. Nobody has solved the cold start.

Converge ends it. We turn liquidity into infrastructure. Deposit once into a single vault. That vault makes the market in every round, on every asset, from the very first second. Liquidity providers earn from spreads, never from token emissions.

But a vault that quotes on-chain gets hunted by faster traders. We measured it. Our first design lost eighty-eight dollars a day to a bot with a one-second lead. So we redesigned the market itself. Orders fill two seconds later, at the oracle's price for that second. Backtested on ninety-one days of real prices, that turns the loss into about fifty dollars a day, under pessimistic assumptions. It breaks if a rival leads by three seconds. We say that out loud.

Now watch a brand-new user. Face ID. No seed phrase, no extension: Mera turns a passkey into the wallet. Add test money, tap Up, confirm once. The keeper fills it. Eighteen point seven seconds from landing page to a live bet, on Monad testnet. Ethereum, Bitcoin, MON: one vault quotes them all.

This only works on Monad. A block every three hundred milliseconds. Serving a trade costs about a sixth of a cent. On Ethereum, about ten cents. Fifty-seven times cheaper, at today's gas prices.

The whole stack is real. Chainlink CRE is the orchestration layer, and we've broadcast its reports on-chain. Each round's Up token becomes its own order book on Kuru. Envio indexes the history. Mera is the entire account layer.

And it's a platform. Any Monad app can launch a market with instant depth: one call, under hard caps. Loss limits are enforced on-chain: one percent per market, eight percent in total. And users can always exit.

The trades you just watched ran live on testnet, with test money. No outside users yet. We're telling you first. Ten phases built, with four hundred and twelve contract tests. Four things unlock mainnet: Chainlink Data Streams access, CRE deploy access, Kuru market-creation rights, and an external audit. Converge. A market maker for every short round.
```

## Voice settings that work

- One calm, confident narrator, not hype. Medium pace (about 150 words a minute), a touch slower on the numbers.
- Keep each paragraph as its own take, or leave a half-second pause between paragraphs: the video changes scene there.
- The numbers are spelled out as words on purpose, so the voice does not misread "$49.6".

## Scene by scene

| Time | Scene | On screen | Words |
|---|---|---|---:|
| 0:00 to 0:16 | The cold start | The empty-market card; "No price. No counterparty. 96 times a day." | 37 |
| 0:16 to 0:33 | Liquidity as infrastructure | "Liquidity, as infrastructure." LPs, one vault, ETH, BTC and MON rounds | 39 |
| 0:33 to 1:06 | The speed fix | −$88/day vs +$49.6/day bars, the 2-second fill timeline, and the 3 s caveat chip | 81 |
| 1:06 to 1:30 | First trade, live | Real phone footage: passkey account to filled bet, a timer, ETH 18.7 s, BTC 18.6 s, MON 22.7 s | 52 |
| 1:30 to 1:45 | Why Monad | 0.302 s blocks; $0.0017 vs $0.0965 per trade; 57× | 33 |
| 1:45 to 2:01 | The stack | Mera, Chainlink CRE, Kuru and Envio tiles, each with its honest status chip | 38 |
| 2:01 to 2:17 | Platform and safety | The one-call partner snippet; 1% and 8% loss limits; users can always exit | 37 |
| 2:17 to 2:43 | Honest status and the ask | "Testnet. Test money. No outside users yet." then the four asks, then the logo and tagline | 56 |

## Where every figure comes from

| Said in the video | Source |
|---|---|
| 96 empty starts a day | 24 hours x 4 rounds an hour (numbers.md N37) |
| −$88 a day, about $50 a day, −$145.3 at a 3 s lead | 91 days of 1-second prices, $5,000 vault, pessimistic flow (N11 to N14) |
| 18.7 s landing to filled bet (ETH), 18.6 s BTC, 22.7 s MON | live testnet runs, one each (N48, N49) |
| 0.302 s blocks | 200,000 blocks measured (N1) |
| $0.0017 vs $0.0965 a trade, 57× | measured Monad gas vs the same gas at Ethereum's current price (N5, N9, N10) |
| Chainlink CRE reports broadcast on-chain | testnet broadcast through the forwarder (N47) |
| 1% per market, 8% in total | read from the vault on chain (N21) |
| 412 contract tests, ten phases | N18; the phase reports |

## What the video deliberately does not say

- No users, volume or revenue claims: there are none yet.
- It does not call the code audited (it is internally reviewed twice) and does not say the CRE workflow is deployed (it is not: Early Access). The Envio tile says hosting is still to come.
- It shows the 3-second break in the speed fix on screen: a judge who finds a limit alone trusts you less than one who is told.
- The partner footnote says the end-to-end demo ran on a local chain, and the speed claim is labelled a backtest.
- "The trades you just watched ran live" refers only to the phone footage; the backtest and the empty-market card are labelled as such.

## Re-timing to your audio

Generate the voice, note its length in seconds, then run `node make-timeline.mjs --audio-seconds <length>` and `node render.mjs --audio your-voice.mp3`. Every scene and caption scales to fit, and the result is `out/converge-pitch-with-voice.mp4`. Or send me the audio file and I will do it.
