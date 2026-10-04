/**
 * Runtime-agnostic contract reads.
 *
 * Read logic (round finding, state snapshots) is written once as generators that yield `Call`
 * requests and receive decoded results. Two drivers execute them:
 *  - `runAsync` with a viem PublicClient (fallback service, tests);
 *  - `runSync` with any synchronous executor (the Chainlink CRE workflow, whose EVM capability
 *    returns results via `.result()`).
 */
import {
  decodeFunctionResult,
  encodeFunctionData,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

export type Call = {
  to: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  /** When true, a revert yields `{ ok: false }` instead of throwing. */
  allowRevert?: boolean;
};

export type CallResult = { ok: true; value: unknown } | { ok: false };

export type Reader<T> = Generator<Call, T, CallResult>;

export function encodeCall(c: Call): Hex {
  return encodeFunctionData({
    abi: c.abi,
    functionName: c.functionName,
    args: c.args ?? [],
  } as Parameters<typeof encodeFunctionData>[0]);
}

export function decodeCall(c: Call, data: Hex): unknown {
  return decodeFunctionResult({
    abi: c.abi,
    functionName: c.functionName,
    data,
  } as Parameters<typeof decodeFunctionResult>[0]);
}

/** Unwraps a successful result (throws if the call reverted and reverts were not allowed). */
export function value<T>(r: CallResult): T {
  if (!r.ok) throw new Error("call reverted");
  return r.value as T;
}

/** Drives a reader with a viem client (eth_call at `blockNumber`, default latest). */
export async function runAsync<T>(
  reader: Reader<T>,
  client: Pick<PublicClient, "call">,
  blockNumber?: bigint,
): Promise<T> {
  let step = reader.next(undefined as unknown as CallResult);
  while (!step.done) {
    const c = step.value;
    let res: CallResult;
    try {
      const out = await client.call({
        to: c.to,
        data: encodeCall(c),
        ...(blockNumber === undefined ? {} : { blockNumber }),
      });
      res = { ok: true, value: decodeCall(c, out.data ?? "0x") };
    } catch (e) {
      if (!c.allowRevert) throw e;
      res = { ok: false };
    }
    step = reader.next(res);
  }
  return step.value;
}

/** Drives a reader with a synchronous executor returning raw return data (or throwing). */
export function runSync<T>(reader: Reader<T>, exec: (to: Address, data: Hex) => Hex): T {
  let step = reader.next(undefined as unknown as CallResult);
  while (!step.done) {
    const c = step.value;
    let res: CallResult;
    try {
      res = { ok: true, value: decodeCall(c, exec(c.to, encodeCall(c))) };
    } catch (e) {
      if (!c.allowRevert) throw e;
      res = { ok: false };
    }
    step = reader.next(res);
  }
  return step.value;
}
