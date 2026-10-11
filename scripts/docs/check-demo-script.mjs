/* global console, process, URL */
// Checks that docs/demo-script.md fits 3:00 when read aloud at 150 words per minute.
// Each "## <start> to <end>: ... (VO budget N words)" segment has a budget of seconds x 2.5; every "**VO:**" paragraph is counted.
import { readFileSync } from "node:fs";
const text = readFileSync(new URL("../../docs/demo-script.md", import.meta.url), "utf8");
const segs = [
  ...text.matchAll(
    /^## (\d+):(\d+) to (\d+):(\d+)[^\n]*?\(VO budget (\d+) words\)\n([\s\S]*?)(?=^## |\n## |$(?![\s\S]))/gm,
  ),
];
let total = 0;
let bad = false;
const WPM = 150;
for (const m of segs) {
  const secs = Number(m[3]) * 60 + Number(m[4]) - (Number(m[1]) * 60 + Number(m[2]));
  const budget = Number(m[5]);
  const vo = (m[6].match(/\*\*VO:\*\*\s*([^\n]+)/) ?? [])[1] ?? "";
  const words = vo.trim().split(/\s+/).filter(Boolean).length;
  const needs = (words / WPM) * 60;
  const ok = words <= budget && words <= secs * 2.5 && needs <= secs;
  if (!ok) bad = true;
  total += words;
  console.log(
    `${m[1]}:${m[2].padStart(2, "0")}-${m[3]}:${m[4].padStart(2, "0")}  ${String(words).padStart(3)} words / budget ${budget}  speaks in ${needs.toFixed(1)} s of ${secs} s  ${ok ? "OK" : "TOO LONG"}`,
  );
}
const secsTotal = (total / WPM) * 60;
console.log(
  `total ${total} words = ${secsTotal.toFixed(1)} s at ${WPM} wpm (limit 180 s, 450 words)`,
);
if (segs.length !== 5 && segs.length !== 6) {
  console.log(`expected 5 or 6 timed segments, found ${segs.length}`);
  bad = true;
}
if (total > 450 || secsTotal > 180) bad = true;
process.exit(bad ? 1 : 0);
