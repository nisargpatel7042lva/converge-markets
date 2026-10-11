# The keeper's "price unhealthy" flicker: root cause and fix

**Symptom.** On testnet the keeper pulled every quote about once a minute with `PRICE_UNHEALTHY, FEW_SOURCES`, then restored them about 15 s later. While quotes were pulled nothing could fill, and each pull and restore cost gas (the keeper wallet drained from 1.26 MON to 0.001 MON).

**What it was not.** A stalled keeper: over five minutes the event loop's drift stayed between 0 and 10 ms and the keeper logged 0 `event loop stalled` lines. A dead relay: the relay's own silence watchdog never fired. A slow exchange connection through the relay: see the next point.

**Cause.** Binance's `ethusdt@bookTicker` stream only sends when the best bid or ask changes. In a quiet market it goes silent for seconds at a time. Measured 2026-10-11 over 300 s with three listeners side by side (the relay's Binance port, the relay's Coinbase port, and a direct connection to `wss://stream.binance.com`): the relay and the direct connection went quiet **at identical moments**, for 2.5 to 2.8 s, five times in five minutes, so the gap is in the exchange feed itself; the keeper's own log showed two instances at 3.06 s and 3.33 s. The keeper drops a source that has been silent for more than `staleMs` (3,000 ms), so each quiet Binance gap left only Coinbase, which is below `minSources` (2): "FEW_SOURCES", all quotes pulled. The config already had a per-source override for exactly this situation (Coinbase's ticker, 12 s), but Binance had been assumed fast.

**Fix.** A per-source freshness window for Binance of **8,000 ms** in `config/keeper.testnet.json` and `config/keeper.mainnet.base.json`, between the longest quiet gap seen (3.3 s) and the 10 s socket watchdog, which closes and reopens a connection that is truly dead. A dead feed is still caught: a source silent past its window still counts as missing, and the divergence and shock checks still compare the sources. Also shortened the relay's Coinbase keep-alive replay from 3 s to 1 s. No safety check was loosened or removed.

**Pinned by a test.** `services/keeper/test/unit/price.test.ts` reads the real shipped config files and asserts that a 5 s quiet Binance book stays healthy, that a feed silent past its window still gives `FEW_SOURCES`, and that the window is at least 5 s and under 10 s.

**Diagnostics kept.** The keeper's `risk state changed` log now lists each source's age and health, and an `event loop stalled` warning is logged for any stall over a second, so the next incident can be told apart quickly.

**Result.** After the fix, with one keeper running and its wallet funded: 0 quote pulls in the first 9 minutes (the log is `.testnet/keeper.log`; the longer window is in the Phase 10 addendum). Before: roughly one pull a minute.

**A mistake worth recording.** My first restart did not stop the old keeper, so for a while two keepers shared one wallet and the new config appeared not to work. The per-source ages in the new log line exposed it within a minute (Binance still marked stale at 3,057 ms under an 8,000 ms limit).
