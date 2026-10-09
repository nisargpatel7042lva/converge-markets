/**
 * TESTNET ONLY. A stand-in for the Chainlink Data Streams REST API (/api/v1/reports) for the CRE
 * simulation on Monad testnet, where there is no Data Streams verifier: it answers with a full report
 * for the TEST feed, signed by the test signer the MockStreamsVerifierProxy trusts, priced from the
 * keeper's reference price (the local relay, else Coinbase). The workflow cannot tell it from the real
 * API: same path, same JSON shape (`{ report: { fullReport } }`), same request signing (ignored here).
 *
 *   pnpm --filter @converge/keeper exec tsx scripts/cre-streams-shim.ts [port=9311]
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { signTestReportSync } from "@converge/sdk";
import type { Hex } from "viem";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const key = (k: string): string => {
  const line = readFileSync(`${root}.env`, "utf8").split("\n").find((l) => l.startsWith(`${k}=`));
  if (!line) throw new Error(`${k} missing in .env`);
  return line.slice(k.length + 1).trim();
};
const dep = JSON.parse(readFileSync(`${root}deployments/testnet.json`, "utf8")) as { testFeedId: Hex };
const signer = key("STREAMS_TEST_SIGNER_KEY") as Hex;
const port = Number(process.argv[2] ?? 9311);

async function price(): Promise<number> {
  try {
    const j = (await (await fetch("http://127.0.0.1:9203/price", { signal: AbortSignal.timeout(2000) })).json()) as { price: number };
    if (j.price > 0) return j.price;
  } catch {
    /* fall back */
  }
  const j = (await (await fetch("https://api.exchange.coinbase.com/products/ETH-USD/ticker", { signal: AbortSignal.timeout(5000) })).json()) as { bid: string; ask: string };
  return (Number(j.bid) + Number(j.ask)) / 2;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (code: number, body: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (url.pathname !== "/api/v1/reports") return send(404, { error: "not found" });
  const feed = url.searchParams.get("feedID");
  const ts = Number(url.searchParams.get("timestamp"));
  if (feed?.toLowerCase() !== dep.testFeedId.toLowerCase()) return send(404, { error: "unknown feed" });
  if (!Number.isInteger(ts) || ts <= 0 || ts > Date.now() / 1000 + 5) return send(400, { error: "bad timestamp" });
  try {
    const px = await price();
    const fullReport = signTestReportSync(signer, dep.testFeedId, BigInt(ts), BigInt(Math.round(px * 1e8)) * 10n ** 10n);
    console.log(`[streams-shim] report for ${ts}: ${px.toFixed(2)}`);
    send(200, { report: { feedID: dep.testFeedId, validFromTimestamp: ts, observationsTimestamp: ts, fullReport } });
  } catch (e) {
    send(502, { error: String(e) });
  }
}).listen(port, "127.0.0.1", () => console.log(`[streams-shim] listening on http://127.0.0.1:${port}`));
