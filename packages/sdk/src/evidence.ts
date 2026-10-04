/**
 * Evidence for Market.open/resolve. The scheduler only relays evidence; the market's resolver
 * verifies it onchain (round-proof uniqueness / Data Streams signatures), so a scheduler bug or
 * compromise cannot choose an outcome — at worst it fails to act (liveness).
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { encodeAbiParameters, hashMessage, keccak256, type Hex, type LocalAccount } from "viem";
import { dataStreamsAuthHeaders } from "./streams-auth";

/** Source of Data Streams full reports for a boundary (the report whose window contains it). */
export interface StreamsReportSource {
  /** Returns the full report payload, or null if not available yet. */
  reportAt(feedId: Hex, timestamp: bigint): Promise<Hex | null>;
}

/**
 * Chainlink Data Streams REST client, implemented from
 * https://docs.chain.link/data-streams/reference/data-streams-api/interface-api and
 * .../authentication (read 2026-10-04): GET /api/v1/reports?feedID=&timestamp= with HMAC headers.
 * UNVERIFIED against the live API (no credentials yet, see docs/EXTERNAL.md).
 */
export class DataStreamsRestSource implements StreamsReportSource {
  constructor(
    private readonly baseUrl: string, // https://api.dataengine.chain.link (mainnet) / api.testnet-dataengine.chain.link
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static authHeaders(
    method: string,
    pathWithQuery: string,
    apiKey: string,
    apiSecret: string,
    timestampMs: number,
    body = "",
  ): Record<string, string> {
    return dataStreamsAuthHeaders(method, pathWithQuery, apiKey, apiSecret, timestampMs, body);
  }

  async reportAt(feedId: Hex, timestamp: bigint): Promise<Hex | null> {
    const path = `/api/v1/reports?feedID=${feedId}&timestamp=${timestamp}`;
    const res = await this.fetchImpl(this.baseUrl + path, {
      headers: DataStreamsRestSource.authHeaders(
        "GET",
        path,
        this.apiKey,
        this.apiSecret,
        Date.now(),
      ),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`data streams ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { report?: { fullReport?: string } };
    const full = body.report?.fullReport;
    if (!full || !/^0x[0-9a-fA-F]*$/.test(full)) throw new Error("data streams: no fullReport");
    return full as Hex;
  }
}

/** Price feeder for the test signer (e.g. mirrors Chainlink mainnet prices). */
export type PriceAt = (timestamp: bigint) => Promise<bigint | null>;

/**
 * TEST-ONLY: signs v3-shaped reports for MockStreamsVerifierProxy (testnet / local). Mirrors the
 * payload layout used in contracts/test/Base.t.sol and contracts/script/lifecycle.sh. Whoever
 * holds the key controls prices: never use with a real VerifierProxy deployment.
 */
export class TestSignerStreamsSource implements StreamsReportSource {
  constructor(
    private readonly signer: LocalAccount,
    private readonly price: PriceAt,
  ) {}

  async reportAt(feedId: Hex, timestamp: bigint): Promise<Hex | null> {
    const px = await this.price(timestamp);
    if (px === null) return null;
    const reportData = encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint32" },
        { type: "uint32" },
        { type: "uint192" },
        { type: "uint192" },
        { type: "uint32" },
        { type: "int192" },
        { type: "int192" },
        { type: "int192" },
      ],
      [
        feedId,
        Number(timestamp),
        Number(timestamp),
        0n,
        0n,
        Number(timestamp) + 86_400,
        px,
        px,
        px,
      ],
    );
    if (!this.signer.signMessage) throw new Error("signer cannot sign messages");
    const sig = await this.signer.signMessage({ message: { raw: keccak256(reportData) } });
    const zero = `0x${"00".repeat(32)}` as Hex;
    return encodeAbiParameters(
      [{ type: "bytes32[3]" }, { type: "bytes" }, { type: "bytes" }],
      [[zero, zero, zero], reportData, sig],
    );
  }
}

/**
 * TEST-ONLY synchronous variant of TestSignerStreamsSource (for runtimes/tests that need sync
 * evidence callbacks). Same payload layout.
 */
export function signTestReportSync(
  privateKey: Hex,
  feedId: Hex,
  timestamp: bigint,
  price: bigint,
): Hex {
  const reportData = encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "uint32" },
      { type: "uint32" },
      { type: "uint192" },
      { type: "uint192" },
      { type: "uint32" },
      { type: "int192" },
      { type: "int192" },
      { type: "int192" },
    ],
    [
      feedId,
      Number(timestamp),
      Number(timestamp),
      0n,
      0n,
      Number(timestamp) + 86_400,
      price,
      price,
      price,
    ],
  );
  const digest = hashMessage({ raw: keccak256(reportData) });
  const sig = secp256k1.sign(digest.slice(2), privateKey.slice(2), { lowS: true });
  const r = sig.r.toString(16).padStart(64, "0");
  const s = sig.s.toString(16).padStart(64, "0");
  const v = (27 + sig.recovery).toString(16);
  const zero = `0x${"00".repeat(32)}` as Hex;
  return encodeAbiParameters(
    [{ type: "bytes32[3]" }, { type: "bytes" }, { type: "bytes" }],
    [[zero, zero, zero], reportData, `0x${r}${s}${v}` as Hex],
  );
}
