import {
  DataStreamsRestSource,
  TestSignerStreamsSource,
  type StreamsReportSource,
} from "@converge/sdk";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { Env } from "./config";
import type { ReferencePrice } from "./price/aggregator";

/** 18-decimal price from a float (8 digits of precision is far below a tick of any feed). */
export const price18 = (x: number): bigint => BigInt(Math.round(x * 1e8)) * 10n ** 10n;

/**
 * Where the reports for an order's second and for an epoch end come from.
 * - data-streams: the Chainlink API (needs credentials; BLOCKED until Nisarg provides them).
 * - test-signer (TEST-ONLY): reports signed by the test key for MockStreamsVerifierProxy, priced from
 *   the keeper's own reference price history at the requested second.
 */
export function makeReportSource(
  env: Pick<
    Env,
    | "STREAMS_SOURCE"
    | "STREAMS_TEST_SIGNER_KEY"
    | "DATA_STREAMS_API_URL"
    | "DATA_STREAMS_API_KEY"
    | "DATA_STREAMS_API_SECRET"
  >,
  refs: ReadonlyMap<string, ReferencePrice>,
  /** chain time minus wall-clock time in ms (a chain whose clock differs from this machine's). */
  offsetMs: () => number = () => 0,
): (feedId: Hex) => StreamsReportSource {
  if (env.STREAMS_SOURCE === "data-streams") {
    const src = new DataStreamsRestSource(
      env.DATA_STREAMS_API_URL as string,
      env.DATA_STREAMS_API_KEY as string,
      env.DATA_STREAMS_API_SECRET as string,
    );
    return () => src;
  }
  const signer = privateKeyToAccount(env.STREAMS_TEST_SIGNER_KEY as Hex);
  const cache = new Map<string, StreamsReportSource>();
  return (feedId) => {
    const k = feedId.toLowerCase();
    let s = cache.get(k);
    if (!s) {
      const ref = refs.get(k);
      s = new TestSignerStreamsSource(signer, async (ts) => {
        const p = ref?.priceAt(Number(ts) * 1000 - offsetMs());
        return p === undefined || p === null ? null : price18(p);
      });
      cache.set(k, s);
    }
    return s;
  };
}
