// Builds timeline.json (scene starts, caption cues), captions.srt and script-vo.txt from scenes.json.
// Re-time to a real voiceover: node make-timeline.mjs --audio-seconds 171.4  (scales every scene proportionally)
import { readFileSync, writeFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync(new URL("./scenes.json", import.meta.url)));
const argAudio = process.argv.indexOf("--audio-seconds");
const audioSeconds = argAudio > 0 ? Number(process.argv[argAudio + 1]) : null;
const words = (s) => s.trim().split(/\s+/).length;
const sentences = (s) => s.match(/[^.?!]+[.?!]+(\s|$)/g).map((x) => x.trim());
let t = 0;
const scenes = cfg.scenes.map((sc) => {
  const w = words(sc.vo);
  const dur = Math.max(sc.minSeconds, w / cfg.wordsPerSecond + cfg.padSeconds);
  const out = { ...sc, words: w, start: t, duration: dur };
  t += dur;
  return out;
});
const design = t;
const k = audioSeconds ? audioSeconds / design : 1;
// caption cues: each sentence gets time in proportion to its words, split further if long (max 11 words a cue)
const cues = [];
for (const sc of scenes) {
  sc.start *= k;
  sc.duration *= k;
  const speak = sc.duration - cfg.padSeconds * k;
  const tw = sc.words;
  let cursor = sc.start + 0.25 * k;
  for (const sen of sentences(sc.vo)) {
    const ws = sen.split(/\s+/);
    const parts = [];
    for (let i = 0; i < ws.length; i += 11) parts.push(ws.slice(i, i + 11).join(" "));
    const balanced = parts.length > 1 ? (() => { const n = Math.ceil(ws.length / 11), sz = Math.ceil(ws.length / n); const r = []; for (let i = 0; i < ws.length; i += sz) r.push(ws.slice(i, i + sz).join(" ")); return r; })() : parts;
    for (const p of balanced) {
      const d = (words(p) / tw) * speak;
      cues.push({ start: cursor, end: cursor + d, text: p, scene: sc.id });
      cursor += d;
    }
  }
}
const total = scenes.at(-1).start + scenes.at(-1).duration;
writeFileSync(new URL("./timeline.json", import.meta.url), JSON.stringify({ total, scenes, cues }, null, 1));
const f = (x) => { const ms = Math.round(x * 1000); const p = (n, l = 2) => String(n).padStart(l, "0"); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
writeFileSync(new URL("./captions.srt", import.meta.url), cues.map((c, i) => `${i + 1}\n${f(c.start)} --> ${f(c.end)}\n${c.text}\n`).join("\n"));
writeFileSync(new URL("./script-vo.txt", import.meta.url), cfg.scenes.map((s) => s.vo).join("\n\n") + "\n");
console.log(`scenes ${scenes.length}, words ${scenes.reduce((a, s) => a + s.words, 0)}, design length ${design.toFixed(1)} s, video length ${total.toFixed(1)} s`);
for (const s of scenes) console.log(`${s.start.toFixed(1).padStart(6)}  ${s.duration.toFixed(1).padStart(5)}s  ${s.words}w  ${s.id}`);
