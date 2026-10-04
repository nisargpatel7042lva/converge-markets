import { describe, expect, it } from "vitest";
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionResult,
  type Address,
  type Hex,
} from "viem";
import { aggregatorV3Abi } from "../src/abi/generated";
import { runAsync, runSync, type Call, type CallResult } from "../src/calls";
import {
  aggRoundOf,
  encodeRoundProof,
  findFirstRoundAtOrAfter,
  makeRoundId,
  phaseOf,
} from "../src/rounds";

const FEED = "0x00000000000000000000000000000000000000fe" as Address;

/** In-memory proxy: rounds keyed by full round id; `latest` is the proxy's current round. */
class FakeFeed {
  rounds = new Map<bigint, { answer: bigint; updatedAt: bigint }>();
  latest = 0n;
  calls = 0;
  set(phase: bigint, agg: bigint, answer: bigint, updatedAt: bigint) {
    const id = makeRoundId(phase, agg);
    this.rounds.set(id, { answer, updatedAt });
    this.latest = id;
    return id;
  }
  answer(c: Call): CallResult {
    this.calls++;
    if (c.functionName === "latestRoundData") {
      const r = this.rounds.get(this.latest) ?? { answer: 0n, updatedAt: 0n };
      return { ok: true, value: [this.latest, r.answer, r.updatedAt, r.updatedAt, this.latest] };
    }
    const id = (c.args as [bigint])[0];
    const r = this.rounds.get(id);
    if (!r) return { ok: false }; // proxy reverts on unknown rounds
    return { ok: true, value: [id, r.answer, r.updatedAt, r.updatedAt, id] };
  }
}

function drive(feed: FakeFeed, t: bigint) {
  const gen = findFirstRoundAtOrAfter(FEED, t);
  let step = gen.next(undefined as unknown as CallResult);
  while (!step.done) step = gen.next(feed.answer(step.value));
  return step.value;
}

describe("first round at or after T", () => {
  it("finds the first qualifying round with a binary search", () => {
    const f = new FakeFeed();
    for (let i = 1n; i <= 1000n; i++) f.set(1n, i, i * 10n, 1_000n + i * 30n); // every 30 s
    const r = drive(f, 1_000n + 500n * 30n - 1n);
    expect(r).toEqual({
      kind: "found",
      roundId: makeRoundId(1n, 500n),
      updatedAt: 16_000n,
      answer: 5000n,
    });
    expect(f.calls).toBeLessThan(20); // ~log2(1000)
  });

  it("handles an exact hit and irregular gaps between updates", () => {
    const f = new FakeFeed();
    const gaps = [10n, 1061n, 20n, 3607n, 30n]; // observed Monad mainnet gaps (Phase 0 evidence)
    let ts = 5_000n;
    f.set(1n, 1n, 1n, ts);
    gaps.forEach((g, i) => f.set(1n, BigInt(i + 2), BigInt(i + 2), (ts += g)));
    // T inside the 3607 s gap -> the round after the gap
    const r = drive(f, 5_000n + 10n + 1061n + 20n + 1n);
    expect(r.kind === "found" && aggRoundOf(r.roundId)).toBe(5n);
    const exact = drive(f, 5_010n);
    expect(exact.kind === "found" && aggRoundOf(exact.roundId)).toBe(2n);
  });

  it("returns not-yet when no round has been published since T", () => {
    const f = new FakeFeed();
    f.set(1n, 1n, 1n, 100n);
    f.set(1n, 2n, 1n, 200n);
    expect(drive(f, 201n)).toEqual({ kind: "not-yet", latestUpdatedAt: 200n });
  });

  it("only searches the proxy's current phase (aggregator migration)", () => {
    const f = new FakeFeed();
    f.set(1n, 1n, 1n, 100n);
    f.set(1n, 2n, 1n, 300n); // old phase would qualify for T=250...
    f.set(2n, 1n, 7n, 200n);
    f.set(2n, 2n, 8n, 260n); // ...but the proxy is on phase 2 now
    const r = drive(f, 250n);
    expect(r.kind === "found" && phaseOf(r.roundId)).toBe(2n);
    expect(r.kind === "found" && aggRoundOf(r.roundId)).toBe(2n);
  });

  it("reports first-of-phase when round 1 of the current phase is the first at/after T", () => {
    const f = new FakeFeed();
    f.set(1n, 1n, 1n, 100n);
    f.set(2n, 1n, 2n, 300n);
    f.set(2n, 2n, 3n, 330n);
    expect(drive(f, 250n)).toEqual({ kind: "first-of-phase", roundId: makeRoundId(2n, 1n) });
  });

  it("reports a missing round inside the phase instead of skipping it", () => {
    const f = new FakeFeed();
    for (let i = 1n; i <= 8n; i++) f.set(1n, i, i, i * 100n);
    f.rounds.delete(makeRoundId(1n, 4n));
    expect(drive(f, 350n)).toEqual({ kind: "missing-round", roundId: makeRoundId(1n, 4n) });
  });

  it("runs identically through the sync and async drivers (real ABI encode/decode)", async () => {
    const f = new FakeFeed();
    for (let i = 1n; i <= 50n; i++) f.set(3n, i, i, i * 60n);
    const exec = (_to: Address, data: Hex): Hex => {
      const { functionName, args } = decodeFunctionData({ abi: aggregatorV3Abi, data });
      const res = f.answer({ to: FEED, abi: aggregatorV3Abi, functionName, args: args ?? [] });
      if (!res.ok) throw new Error("execution reverted");
      return encodeFunctionResult({
        abi: aggregatorV3Abi,
        functionName,
        result: res.value,
      } as Parameters<typeof encodeFunctionResult>[0]);
    };
    const syncRes = runSync(findFirstRoundAtOrAfter(FEED, 1_201n), exec);
    const client = {
      call: async ({ to, data }: { to: Address; data: Hex }) => ({ data: exec(to, data) }),
    };
    const asyncRes = await runAsync(findFirstRoundAtOrAfter(FEED, 1_201n), client as never);
    expect(syncRes).toEqual({
      kind: "found",
      roundId: makeRoundId(3n, 21n),
      updatedAt: 1_260n,
      answer: 21n,
    });
    expect(asyncRes).toEqual(syncRes);
  });

  it("encodes the proof the resolver expects (abi.encode(uint80))", () => {
    const id = makeRoundId(1n, 42n);
    const [decoded] = decodeAbiParameters([{ type: "uint80" }], encodeRoundProof(id));
    expect(decoded).toBe(id);
  });
});
