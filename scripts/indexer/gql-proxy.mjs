/* global process, console */
// Read-only front for the LOCAL Envio dev Hasura (which is gated by an admin secret and has no CORS):
// forwards GraphQL queries to it with the secret added, refuses mutations and subscriptions, and answers
// the browser's CORS preflight. For the local testnet demo only; Envio Cloud serves a public endpoint itself.
//   node scripts/indexer/gql-proxy.mjs [listenPort=8081] [upstream=http://127.0.0.1:8080/v1/graphql]
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8081);
const upstream = process.argv[3] ?? "http://127.0.0.1:8080/v1/graphql";
const secret = process.env.HASURA_ADMIN_SECRET ?? "testing";
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

createServer(async (req, res) => {
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  if (req.method !== "POST") return res.writeHead(405, cors).end();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  if (body.length > 20_000 || /\b(mutation|subscription)\b/i.test(body))
    return res
      .writeHead(400, { ...cors, "content-type": "application/json" })
      .end('{"errors":[{"message":"read-only endpoint"}]}');
  try {
    const r = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hasura-admin-secret": secret },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    res.writeHead(r.status, { ...cors, "content-type": "application/json" }).end(await r.text());
  } catch (e) {
    res
      .writeHead(502, { ...cors, "content-type": "application/json" })
      .end(JSON.stringify({ errors: [{ message: String(e) }] }));
  }
}).listen(port, "127.0.0.1", () =>
  console.log(`read-only GraphQL proxy on http://127.0.0.1:${port} -> ${upstream}`),
);
