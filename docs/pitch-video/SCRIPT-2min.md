# Converge pitch video (2-minute cut): script for the AI voiceover

**Length:** about 1:52 at a normal reading pace (240 words, 150 words a minute). Paste the plain text below into your voice tool. The captions in the video are burned in from this same text, so keep the words as written.

**The angle:** liquidity stops being something every market has to beg for and becomes infrastructure. The video is bold about the idea and exact about the evidence: every figure is in [numbers.md](../numbers.md), and it says *testnet, test money, no outside users yet* on screen and aloud.

## Copy-paste voiceover

```text
Every prediction market starts empty. No price, no counterparty. A fifteen-minute market does that ninety-six times a day. Nobody has solved the cold start.

Converge ends it. Liquidity becomes infrastructure: deposit once into one vault, and it makes the market in every round, on every asset, from the first second.

Faster traders hunt on-chain quotes: our first design lost eighty-eight dollars a day. So orders now fill two seconds later, at the oracle's price for that second. About fifty dollars a day, in backtest. It breaks at a three-second lead. We say so.

Watch a new user. Face ID creates the account, no seed phrase. Add test money, tap Up, confirm once. The keeper fills it. Eighteen point seven seconds, landing page to live bet, on Monad testnet. Ethereum, Bitcoin, MON: one vault quotes them all.

Monad's blocks take three hundred milliseconds. Serving a trade costs a sixth of a cent. On Ethereum, about ten cents.

Chainlink CRE orchestrates. Kuru lists each Up token as an order book. Envio indexes. Mera is the account layer.

Any Monad app can launch a market with depth in one call. Loss limits are on-chain: one percent per market, eight in total. Users can always exit.

I'm Nisarg, building this alone. It runs on testnet with test money, and no outside users yet. Mainnet needs Chainlink Data Streams, CRE deploy access, Kuru rights and an audit. Converge: a market maker for every short round.
```

## Voice settings that work

- One calm, confident narrator, not hype. Medium pace (about 150 words a minute), a touch slower on the numbers.
- Keep each paragraph as its own take, or leave a half-second pause between paragraphs: the video changes scene there.
- The numbers are spelled out as words on purpose, so the voice does not misread "$49.6".

## Scene by scene

| Time | Scene | On screen | Words |
|---|---|---|---:|
| 0:00 to 0:10 | The cold start | The empty-market card; "No price. No counterparty. 96 times a day." | 24 |
| 0:10 to 0:22 | Liquidity as infrastructure | "Liquidity, as infrastructure." LPs, one vault, ETH, BTC and MON rounds | 26 |
| 0:22 to 0:40 | The speed fix | −$88/day vs +$49.6/day bars, the 2-second fill timeline, and the 3 s caveat chip | 43 |
| 0:40 to 1:03 | First trade, live | Real phone footage: passkey account to filled bet, a timer, ETH 18.7 s, BTC 18.6 s, MON 22.7 s | 43 |
| 1:03 to 1:12 | Why Monad | 0.302 s blocks; $0.0017 vs $0.0965 per trade; 57× | 20 |
| 1:12 to 1:22 | The stack | Mera, Chainlink CRE, Kuru and Envio tiles, each with its honest status chip | 19 |
| 1:22 to 1:34 | Platform and safety | The one-call partner snippet; 1% and 8% loss limits; users can always exit | 27 |
| 1:34 to 1:52 | Team, honest status and the ask | "Testnet. Test money. No outside users yet." then the four asks, then the logo and tagline | 38 |

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
