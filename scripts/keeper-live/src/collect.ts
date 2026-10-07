/**
 * Scrapes the keeper's /metrics every 15 s and appends the series the evidence needs to a JSONL
 * file (no Prometheus needed for the run itself; the compose stack scrapes the same endpoint).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const url = process.env.KEEPER_URL ?? "http://127.0.0.1:9100";
const out = process.env.OUT ?? "docs/evidence/phase-5/metrics.jsonl";
const every = Number(process.env.EVERY_MS ?? "15000");
mkdirSync(dirname(out), { recursive: true });

function parse(text: string): Record<string, number> {
  const r: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (!line.startsWith("keeper_") || line.startsWith("keeper_process_")) continue;
    const i = line.lastIndexOf(" ");
    const v = Number(line.slice(i + 1));
    if (Number.isFinite(v)) r[line.slice(0, i)] = v;
  }
  return r;
}

for (;;) {
  try {
    const text = await (await fetch(`${url}/metrics`)).text();
    appendFileSync(out, `${JSON.stringify({ t: new Date().toISOString(), m: parse(text) })}\n`);
  } catch (e) {
    appendFileSync(out, `${JSON.stringify({ t: new Date().toISOString(), error: String(e) })}\n`);
  }
  await new Promise((r) => setTimeout(r, every));
}
