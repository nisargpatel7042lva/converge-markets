import { describe, expect, it } from "vitest";
import { unbatchOnRestricted } from "../../src/chain/clients";

const rpcBody = (calls: { id: number; method: string }[]) => JSON.stringify(calls);

/** A fake endpoint: `strict` ones refuse every batch the way rpc-testnet.monadinfra.com does, and answer single calls. */
function fakeFetch(strictOrigins: string[], status = 200) {
  const seen: { origin: string; batch: boolean }[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const origin = new URL(url).origin;
    const body = JSON.parse(String(init?.body));
    const batch = Array.isArray(body);
    seen.push({ origin, batch });
    if (batch && strictOrigins.includes(origin))
      return new Response("Restricted JSON RPC method\n", {
        status,
        headers: { "content-type": "text/plain" },
      });
    const answer = (c: { id: number; method: string }) => ({
      jsonrpc: "2.0",
      id: c.id,
      result: `${c.method}@${origin}`,
    });
    return new Response(JSON.stringify(batch ? body.map(answer) : answer(body)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { f, seen };
}

describe("unbatchOnRestricted (an endpoint that refuses batches must not take the keeper down)", () => {
  const calls = [
    { id: 1, method: "eth_getTransactionCount" },
    { id: 2, method: "eth_estimateGas" },
    { id: 3, method: "eth_gasPrice" },
  ];

  for (const status of [200, 403]) {
    it(`sends the calls one by one and returns them in order when a batch is refused (HTTP ${status})`, async () => {
      const { f, seen } = fakeFetch(["https://strict.example"], status);
      const fetchFn = unbatchOnRestricted(f);
      const res = await fetchFn("https://strict.example", { method: "POST", body: rpcBody(calls) });
      const out = (await res.json()) as { id: number; result: string }[];
      expect(out.map((x) => x.id)).toEqual([1, 2, 3]);
      expect(out.map((x) => x.result)).toEqual(
        calls.map((c) => `${c.method}@https://strict.example`),
      );
      expect(seen.filter((s) => s.batch)).toHaveLength(1); // one refused batch, then three singles
      expect(seen.filter((s) => !s.batch)).toHaveLength(3);
    });
  }

  it("remembers the refusal: the next batch goes straight to single calls", async () => {
    const { f, seen } = fakeFetch(["https://strict.example"]);
    const fetchFn = unbatchOnRestricted(f);
    await fetchFn("https://strict.example", { method: "POST", body: rpcBody(calls) });
    seen.length = 0;
    await fetchFn("https://strict.example", { method: "POST", body: rpcBody(calls) });
    expect(seen.filter((s) => s.batch)).toHaveLength(0);
    expect(seen).toHaveLength(3);
  });

  it("leaves an endpoint that accepts batches alone", async () => {
    const { f, seen } = fakeFetch(["https://strict.example"]);
    const fetchFn = unbatchOnRestricted(f);
    const res = await fetchFn("https://ok.example", { method: "POST", body: rpcBody(calls) });
    expect(((await res.json()) as unknown[]).length).toBe(3);
    expect(seen).toEqual([{ origin: "https://ok.example", batch: true }]);
  });

  it("does not touch a single, non-batched call", async () => {
    const { f, seen } = fakeFetch(["https://strict.example"]);
    const fetchFn = unbatchOnRestricted(f);
    await fetchFn("https://strict.example", { method: "POST", body: JSON.stringify(calls[0]) });
    expect(seen).toEqual([{ origin: "https://strict.example", batch: false }]);
  });
});
