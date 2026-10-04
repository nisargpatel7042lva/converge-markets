import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeAbiParameters, hashMessage, keccak256, recoverAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DataStreamsRestSource, TestSignerStreamsSource } from "../src/evidence";

describe("Data Streams REST auth (docs: METHOD PATH BODY_HASH API_KEY TIMESTAMP, HMAC-SHA256 hex)", () => {
  it("matches an independent node:crypto implementation", () => {
    const path = "/api/v1/reports?feedID=0x0003abc&timestamp=1790864100";
    const h = DataStreamsRestSource.authHeaders("GET", path, "key-uuid", "secret", 1716211845123);
    const bodyHash = createHash("sha256").update("").digest("hex");
    const expected = createHmac("sha256", "secret")
      .update(`GET ${path} ${bodyHash} key-uuid 1716211845123`)
      .digest("hex");
    expect(h).toEqual({
      Authorization: "key-uuid",
      "X-Authorization-Timestamp": "1716211845123",
      "X-Authorization-Signature-SHA256": expected,
    });
  });

  it("requests the report for a timestamp and returns fullReport; 404 means not yet", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      if (url.includes("timestamp=2")) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ report: { fullReport: "0xabcd" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const src = new DataStreamsRestSource("https://api.example", "k", "s", fetchImpl);
    expect(await src.reportAt("0x0003" as Hex, 1n)).toBe("0xabcd");
    expect(await src.reportAt("0x0003" as Hex, 2n)).toBeNull();
    expect(seen[0]).toBe("https://api.example/api/v1/reports?feedID=0x0003&timestamp=1");
  });
});

describe("TestSignerStreamsSource (TEST-ONLY)", () => {
  it("produces the payload MockStreamsVerifierProxy verifies (EIP-191 over keccak(reportData))", async () => {
    const acct = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const src = new TestSignerStreamsSource(acct, async () => 3000n * 10n ** 18n);
    const feed = `0x0003${"00".repeat(30)}` as Hex;
    const payload = await src.reportAt(feed, 1_790_864_100n);
    const [, reportData, sig] = decodeAbiParameters(
      [{ type: "bytes32[3]" }, { type: "bytes" }, { type: "bytes" }],
      payload!,
    );
    const signer = await recoverAddress({
      hash: hashMessage({ raw: keccak256(reportData) }),
      signature: sig,
    });
    expect(signer).toBe(acct.address);
    const fields = decodeAbiParameters(
      [
        "bytes32",
        "uint32",
        "uint32",
        "uint192",
        "uint192",
        "uint32",
        "int192",
        "int192",
        "int192",
      ].map((type) => ({ type })),
      reportData,
    );
    expect(fields[0]).toBe(feed);
    expect(fields[1]).toBe(1_790_864_100);
    expect(fields[2]).toBe(1_790_864_100);
    expect(fields[6]).toBe(3000n * 10n ** 18n);
  });

  it("returns null when no price is available", async () => {
    const src = new TestSignerStreamsSource(
      privateKeyToAccount(`0x${"22".repeat(32)}`),
      async () => null,
    );
    expect(await src.reportAt("0x00" as Hex, 1n)).toBeNull();
  });
});

describe("signTestReportSync (TEST-ONLY)", () => {
  it("is byte-identical to the async TestSignerStreamsSource payload", async () => {
    const { signTestReportSync } = await import("../src/evidence");
    const pk = `0x${"33".repeat(32)}` as Hex;
    const feed = `0x0003${"11".repeat(30)}` as Hex;
    const asyncPayload = await new TestSignerStreamsSource(
      privateKeyToAccount(pk),
      async () => 42n,
    ).reportAt(feed, 1_790_864_100n);
    expect(signTestReportSync(pk, feed, 1_790_864_100n, 42n)).toBe(asyncPayload);
  });
});
