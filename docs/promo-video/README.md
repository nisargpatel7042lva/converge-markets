# 30-second promo sources

Not the video itself (it is uploaded to a video host). `promo.html` is the first, calm cut; `promo2.html` is the motion cut locked to the beat of `gen-music.mjs` (an original 30 s track at 120 BPM, synthesised in code: no samples, no third-party audio).

- `node gen-music.mjs` writes `work/music.wav`.
- `node render-promo.mjs` renders a page frame by frame (1080p, 30 fps); mux the music with ffmpeg.
- `assets/footage.webm` (git-ignored) is cut from the demo walkthrough recording made by `docs/demo-video/record-journey.mjs`.
