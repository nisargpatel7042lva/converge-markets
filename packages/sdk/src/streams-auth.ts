/**
 * Data Streams REST/WebSocket auth headers, per
 * https://docs.chain.link/data-streams/reference/data-streams-api/authentication (read 2026-10-04):
 * string to sign = "METHOD FULL_PATH BODY_HASH API_KEY TIMESTAMP" (single spaces), signature =
 * hex(HMAC-SHA256(apiSecret, stringToSign)), BODY_HASH = hex(sha256(body)). Fetch-free so the
 * CRE workflow (Javy/QuickJS runtime) can import it.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export function dataStreamsAuthHeaders(
  method: string,
  pathWithQuery: string,
  apiKey: string,
  apiSecret: string,
  timestampMs: number,
  body = "",
): Record<string, string> {
  const bodyHash = bytesToHex(sha256(utf8ToBytes(body)));
  const toSign = `${method} ${pathWithQuery} ${bodyHash} ${apiKey} ${timestampMs}`;
  const sig = bytesToHex(hmac(sha256, utf8ToBytes(apiSecret), utf8ToBytes(toSign)));
  return {
    Authorization: apiKey,
    "X-Authorization-Timestamp": String(timestampMs),
    "X-Authorization-Signature-SHA256": sig,
  };
}
