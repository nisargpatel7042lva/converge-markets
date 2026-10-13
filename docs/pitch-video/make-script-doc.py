# Regenerates SCRIPT.md from scenes.json and timeline.json (run `node make-timeline.mjs` first).
import json
import os
sc = json.load(open(os.environ.get('SCENES','scenes.json')))['scenes']; tl = json.load(open('timeline.json'))
fmt = lambda x: f"{int(x // 60)}:{int(x % 60):02d}"
beats = {
 'cold-start': 'The empty-market card; "No price. No counterparty. 96 times a day."',
 'infrastructure': '"Liquidity, as infrastructure." LPs, one vault, ETH, BTC and MON rounds',
 'speed': '−$88/day vs +$49.6/day bars, the 2-second fill timeline, and the 3 s caveat chip',
 'demo': 'Real phone footage: passkey account to filled bet, a timer, ETH 18.7 s, BTC 18.6 s, MON 22.7 s',
 'monad': '0.302 s blocks; $0.0017 vs $0.0965 per trade; 57×',
 'stack': 'Mera, Chainlink CRE, Kuru and Envio tiles, each with its honest status chip',
 'platform': 'The one-call partner snippet; 1% and 8% loss limits; users can always exit',
 'ask': '"Testnet. Test money. No outside users yet." then the four asks, then the logo and tagline',
}
o = []
o.append("# Converge pitch video: script for the AI voiceover\n")
o.append(f"**Length:** about {fmt(tl['total'])} at a normal reading pace ({sum(s['words'] for s in tl['scenes'])} words, 150 words a minute). Paste the plain text below into your voice tool. The captions in the video are burned in from this same text, so keep the words as written.\n")
o.append("**The angle:** liquidity stops being something every market has to beg for and becomes infrastructure. The video is bold about the idea and exact about the evidence: every figure is in [numbers.md](../numbers.md), and it says *testnet, test money, no outside users yet* on screen and aloud.\n")
o.append("## Copy-paste voiceover\n")
o.append("```text\n" + "\n\n".join(s['vo'] for s in sc) + "\n```\n")
o.append("## Voice settings that work\n")
o.append("- One calm, confident narrator, not hype. Medium pace (about 150 words a minute), a touch slower on the numbers.\n- Keep each paragraph as its own take, or leave a half-second pause between paragraphs: the video changes scene there.\n- The numbers are spelled out as words on purpose, so the voice does not misread \"$49.6\".\n")
o.append("## Scene by scene\n")
o.append("| Time | Scene | On screen | Words |\n|---|---|---|---:|")
for s in tl['scenes']:
    o.append(f"| {fmt(s['start'])} to {fmt(s['start'] + s['duration'])} | {s['label']} | {beats[s['id']]} | {s['words']} |")
o.append("\n## Where every figure comes from\n")
o.append("| Said in the video | Source |\n|---|---|\n| 96 empty starts a day | 24 hours x 4 rounds an hour (numbers.md N37) |\n| −$88 a day, about $50 a day, −$145.3 at a 3 s lead | 91 days of 1-second prices, $5,000 vault, pessimistic flow (N11 to N14) |\n| 18.7 s landing to filled bet (ETH), 18.6 s BTC, 22.7 s MON | live testnet runs, one each (N48, N49) |\n| 0.302 s blocks | 200,000 blocks measured (N1) |\n| $0.0017 vs $0.0965 a trade, 57× | measured Monad gas vs the same gas at Ethereum's current price (N5, N9, N10) |\n| Chainlink CRE reports broadcast on-chain | testnet broadcast through the forwarder (N47) |\n| 1% per market, 8% in total | read from the vault on chain (N21) |\n| 412 contract tests, ten phases | N18; the phase reports |\n")
o.append("## What the video deliberately does not say\n")
o.append("- No users, volume or revenue claims: there are none yet.\n- It does not call the code audited (it is internally reviewed twice) and does not say the CRE workflow is deployed (it is not: Early Access). The Envio tile says hosting is still to come.\n- It shows the 3-second break in the speed fix on screen: a judge who finds a limit alone trusts you less than one who is told.\n- The partner footnote says the end-to-end demo ran on a local chain, and the speed claim is labelled a backtest.\n- \"The trades you just watched ran live\" refers only to the phone footage; the backtest and the empty-market card are labelled as such.\n")
o.append("## Re-timing to your audio\n")
o.append("Generate the voice, note its length in seconds, then run `node make-timeline.mjs --audio-seconds <length>` and `node render.mjs --audio your-voice.mp3`. Every scene and caption scales to fit, and the result is `out/converge-pitch-with-voice.mp4`. Or send me the audio file and I will do it.\n")
open(os.environ.get('SCRIPT_OUT','SCRIPT.md'), 'w').write("\n".join(o))
