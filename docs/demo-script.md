# Demo video script: 3 minutes

Read aloud at 150 words per minute the voiceover is **under 3:00**; `node scripts/docs/check-demo-script.mjs` counts it (each segment has a word budget of seconds x 2.5, and the total must be at most 450 words). Record on Monad testnet unless a shot says otherwise. Every claim on screen is in [numbers.md](numbers.md).

**Before recording:** run `.testnet/start-keeper.sh` and `.testnet/start-scheduler.sh`, check `http://127.0.0.1:9100/status` says `ready: true`, and fund the keeper and the scheduler wallet (about 1 MON per hour for the scheduler). Record the phone shot in a round with at least 8 minutes left. Open `/stats` and read the live numbers just before recording; update the bracketed values in the 1:40 voiceover to match.

---

## 0:00 to 0:20: The problem (VO budget 50 words)

**Shot:** a prediction-market page with a 15-minute round and an empty book: no bids, no asks, a wide spread. Cut to a clock counting down to zero and a fresh empty round.

**On screen:** "A 15-minute market starts with zero liquidity. Every 15 minutes."

**VO:** Prediction markets live or die on liquidity. A fifteen-minute round starts empty, every fifteen minutes. The first trader finds no price, or moves it to the extreme, and leaves. Converge fixes that: one vault that quotes every round, from the first second.

---

## 0:20 to 1:00: The first trade, on a phone, with Face ID (VO budget 100 words)

**Shot:** a real phone screen recording, one take, with a visible timer starting at the landing page. Landing, Start with Face ID, the account appears as a handle, Add test money, open the live round, tap Up, confirm with Face ID, the card shows "You're in", then the fill lands.

**On screen:** a timer; "No seed phrase. No extension. No sign-up form."; at the fill: "Filled 2 s after confirm, at the oracle price for that second"; a small caption: "Automated test, local chain: landing to filled bet in 4.9 s".

**VO:** On a phone, with no seed phrase and no extension. Face ID creates the account: Mera turns a passkey into the wallet. Add test money, pick Up, confirm once. The order fills two seconds later, at the oracle's price for that second, so nobody trades against a price they already saw move. Our automated test does the whole path in under five seconds on a local chain.

---

## 1:00 to 1:40: The vault's price on Kuru (VO budget 100 words)

**Shot:** split screen. Left: the app's market page with the "Also on Kuru" panel (bid, ask, the vault's ask). Right: the lister's log scrolling `quote 0.672 / 0.753 around fair 0.712`. Then the explorer page of the Kuru market, and the taker's buy and sell transactions.

**On screen:** "A round's UP token can be its own market on Kuru"; "Re-quote on a 6-cent move: $0.0014 on Monad, about $0.08 on Ethereum"; "Buy $2.00, sell back $1.82: the spread".

**VO:** A round's UP token can also be a market on Kuru's order book. A lister creates it, mints inventory, and quotes both sides around the vault's fair value. It re-quotes when fair value moves six cents, not every block. One re-quote costs about a seventh of a cent on Monad, against eight cents on Ethereum. A second wallet buys two dollars of Up from the book, and sells it back.

---

## 1:40 to 2:20: The backtest and the live result (VO budget 100 words)

**Shot:** the backtest report's headline lines, then the delay-versus-lead heatmap. Cut to `/stats`: money in the vault, value of one share, return since launch, rounds settled, and the "How the rounds ended" bar.

**On screen:** "As first designed: -$88/day"; "Forward-priced: +$49.6/day, pessimistic flow, $5,000 vault"; "Fails at a 3 s lead: -$145.3/day"; the live stats numbers; "Testnet. Test money."

**VO:** We backtested ninety-one days of one-second prices. Our first design lost eighty-eight dollars a day to faster bots. Forward pricing turns that into about fifty dollars a day on a five-thousand-dollar vault, under pessimistic assumptions, but it breaks if a rival leads by three seconds. Live on testnet, the vault's share price is up [one point two percent] since launch. Settlement gaps show up on the same page.

---

## 2:20 to 2:45: The partner API and the vision (VO budget 62 words)

**Shot:** the five-line SDK snippet that creates a partner market (from [docs/partners.md](partners.md)), then the registry contract on the explorer, then the roadmap line.

**On screen:** "One SDK call: a market with depth, under hard caps"; "Registry live on testnet"; "Next: long-tail markets, more venues".

**VO:** Any Monad app can launch a market with instant depth: one SDK call, an approved template, and the vault quotes it under hard caps. The registry is live on testnet. Next come long-tail markets and more venues, and mainnet once an external audit is done.

---

## 2:45 to 3:00: The ask (VO budget 37 words)

**Shot:** the logo on the dark background, then four lines appearing one at a time.

**On screen:** "Chainlink Data Streams access" / "CRE deploy access" / "Kuru market-creation rights" / "An external audit".

**VO:** Four things unlock mainnet: Chainlink Data Streams access, CRE deploy access, Kuru market-creation rights, and an external audit. Converge: a market maker for every short round.

---

## Shot checklist

1. Phone recording first (it needs the longest round). Screen-record at 60 fps; keep the timer in frame.
2. Do not edit the fill: if a bet is cancelled and refunded, the take stands and the refund card is part of the story (a bet that moves more than the tolerance in two seconds is refunded by design).
3. If the keeper has pulled quotes when you record ("Prices are temporarily pulled" on `/stats`), wait for it to clear. Do not hide it.
4. Frame every number from the same moment: stats page, backtest report, explorer.
