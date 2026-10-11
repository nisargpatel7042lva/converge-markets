/* global console, process, URL */
// Each post of docs/launch/x-thread.md must fit X's 280 characters (a link counts as 23). Posts are the paragraphs after "**n/**".
import { readFileSync } from "node:fs";
const t = readFileSync(new URL("../../docs/launch/x-thread.md", import.meta.url), "utf8");
const posts = [...t.matchAll(/^\*\*(\d+)\/\*\*\n([^\n]+)/gm)].map((m) => [Number(m[1]), m[2]]);
let bad = false;
for (const [n, p] of posts) {
  const len = p.replace(/https?:\/\/\S+/g, "x".repeat(23)).length;
  console.log(
    `${String(n).padStart(2)}/ ${String(len).padStart(3)} chars ${len <= 280 ? "OK" : "TOO LONG"}`,
  );
  if (len > 280) bad = true;
}
if (posts.length < 8 || posts.length > 10) {
  console.log(`expected 8 to 10 posts, found ${posts.length}`);
  bad = true;
}
process.exit(bad ? 1 : 0);
