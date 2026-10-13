# Pitch video sources

The videos themselves are not in the repository (they are uploaded to a video host). What is here is everything needed to rebuild them:

- `SCRIPT-2min.md`: the voiceover for the 2-minute pitch the submission form asks for (240 words). `SCRIPT.md` is the longer 2:44 version.
- `scenes-2min.json` / `scenes.json`: the scripts as data; `make-timeline.mjs` turns them into timings, `captions*.srt` and the voiceover text (`script-vo.txt`).
- `index.html` + `render.mjs`: the exact-frame renderer (1080p, 24 fps, captions burned in). Re-time to a real voiceover with `node make-timeline.mjs --audio-seconds <length>`, then `node render.mjs --audio voice.mp3`.
- The phone clip the demo scene plays is `assets/trade-eth.webm`: copy it from `docs/evidence/phase-10/mera-testnet-trade.webm` (git-ignored here).
