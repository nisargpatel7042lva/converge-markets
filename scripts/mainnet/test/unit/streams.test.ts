import { encodeAbiParameters, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  decodeFullReport,
  fetchReportAt,
  judgeSamples,
  type DecodedReport,
  type Sample,
} from "../../src/check-streams";

const FEED: Hex = `0x0003${"ab".repeat(30)}`;
const px = (usd: number, dec = 18) => BigInt(Math.round(usd * 1e6)) * 10n ** BigInt(dec - 6);

function fullReport(r: Partial<DecodedReport> & { price: bigint }): Hex {
  const data = encodeAbiParameters(
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
      r.feedId ?? FEED,
      r.validFrom ?? 1,
      r.observations ?? 2,
      r.nativeFee ?? 0n,
      r.linkFee ?? 0n,
      r.expiresAt ?? 1000,
      r.price,
      r.bid ?? r.price,
      r.ask ?? r.price,
    ],
  );
  return encodeAbiParameters(
    [
      { type: "bytes32[3]" },
      { type: "bytes" },
      { type: "bytes32[]" },
      { type: "bytes32[]" },
      { type: "bytes32" },
    ],
    [
      [`0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`],
      data,
      [],
      [],
      `0x${"00".repeat(32)}`,
    ],
  );
}

/** Reports of `len` seconds each, back to back from `start`; one sample per second. */
function run(
  start: number,
  seconds: number,
  len: number,
  over: Partial<DecodedReport> = {},
  gapAfter = -1,
): Sample[] {
  const out: Sample[] = [];
  let from = start;
  let to = start + len - 1;
  for (let t = start; t < start + seconds; t++) {
    if (t > to) {
      from = to + 1 + (to === gapAfter ? 2 : 0);
      to = from + len - 1;
    }
    out.push({
      at: t,
      report: {
        feedId: FEED,
        validFrom: from,
        observations: to,
        expiresAt: to + 86_400,
        nativeFee: 0n,
        linkFee: 0n,
        price: px(2500),
        bid: px(2499),
        ask: px(2501),
        ...over,
      },
    });
  }
  return out;
}
const levels = (s: Sample[], o = {}) => judgeSamples(s, { feedId: FEED, expectedUsd: 2500, ...o });
const fails = (s: Sample[], o = {}) =>
  levels(s, o)
    .filter((c) => c.level === "FAIL")
    .map((c) => c.what);

describe("Data Streams live check (pure part)", () => {
  it("decodes a full report", () => {
    const d = decodeFullReport(fullReport({ price: px(2500), validFrom: 10, observations: 12 }));
    expect(d).toMatchObject({ feedId: FEED, validFrom: 10, observations: 12, price: px(2500) });
  });

  it("passes contiguous 18-decimal reports whose windows contain the asked second", () => {
    expect(fails(run(1000, 30, 4))).toEqual([]);
    expect(levels(run(1000, 30, 4)).some((c) => c.level === "WARN")).toBe(false);
  });

  it("fails on a gap between windows (a second without a canonical report)", () => {
    const s = run(1000, 30, 4, {}, 1003);
    // seconds in the gap are asked for but no report covers them
    const bad = fails(s.filter((x) => x.at !== 1004 && x.at !== 1005));
    expect(bad.join("\n")).toMatch(/GAP between windows/);
  });

  it("fails when a report's window does not contain the second it was fetched for", () => {
    const s = run(1000, 10, 4);
    s[5]!.report = { ...s[5]!.report, validFrom: 900, observations: 905 };
    expect(fails(s).join("\n")).toMatch(/do not contain the second/);
  });

  it("flags overlapping windows as a warning, not silence", () => {
    const a = run(1000, 4, 4);
    const b = run(1004, 4, 4).map((x) => ({ ...x, report: { ...x.report, validFrom: 1003 } }));
    expect(levels([...a, ...b]).some((c) => c.level === "WARN" && /overlap/.test(c.what))).toBe(
      true,
    );
  });

  it("fails an 8-decimal stream and a wrong price, and passes 18 decimals", () => {
    expect(
      fails(run(1000, 10, 4, { price: px(2500, 8), bid: px(2500, 8), ask: px(2500, 8) })).join(
        "\n",
      ),
    ).toMatch(/8 decimals/);
    expect(
      fails(run(1000, 10, 4, { price: px(900), bid: px(900), ask: px(900) })).join("\n"),
    ).toMatch(/not within/);
    expect(fails(run(1000, 10, 4))).toEqual([]);
  });

  it("fails a wrong stream id, a non-v3 id, a crossed book and an expired-looking report", () => {
    expect(fails(run(1000, 10, 4, { feedId: `0x0003${"cd".repeat(30)}` })).join("\n")).toMatch(
      /configured stream id/,
    );
    expect(fails(run(1000, 10, 4, { feedId: `0x0002${"ab".repeat(30)}` }), {}).join("\n")).toMatch(
      /schema v3|configured stream id/,
    );
    expect(fails(run(1000, 10, 4, { bid: px(2600) })).join("\n")).toMatch(/bid <= price/);
    expect(fails(run(1000, 10, 4, { expiresAt: 5 })).join("\n")).toMatch(/expiresAt/);
  });

  it("warns on a fee-carrying report (the vault forwards no value) and on a sample that never crosses a report boundary", () => {
    const w = levels(run(1000, 10, 4, { nativeFee: 1n }));
    expect(w.some((c) => c.level === "WARN" && /non-zero fee/.test(c.what))).toBe(true);
    expect(
      levels(run(1000, 3, 50)).some((c) => c.level === "WARN" && /one report/.test(c.what)),
    ).toBe(true);
  });

  it("refuses too few or non-consecutive samples", () => {
    expect(fails(run(1000, 1, 4)).join("\n")).toMatch(/at least 2/);
    const s = run(1000, 10, 4).filter((x) => x.at !== 1005);
    expect(fails(s).join("\n")).toMatch(/consecutive/);
  });
});

describe("Data Streams REST fetch", () => {
  it("signs the request and parses the answer", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fake = (async (url: string, init: { headers: Record<string, string> }) => {
      seen = { url, headers: init.headers };
      return new Response(
        JSON.stringify({
          report: { validFromTimestamp: 5, observationsTimestamp: 7, fullReport: "0xabcd" },
        }),
      );
    }) as unknown as typeof fetch;
    const r = await fetchReportAt(
      "https://api.example",
      "key",
      "secret",
      FEED,
      1234,
      fake,
      () => 1_700_000_000_000,
    );
    expect(r).toEqual({ validFrom: 5, observations: 7, fullReport: "0xabcd" });
    expect(seen!.url).toBe(`https://api.example/api/v1/reports?feedID=${FEED}&timestamp=1234`);
    expect(seen!.headers.Authorization).toBe("key");
    expect(seen!.headers["X-Authorization-Timestamp"]).toBe("1700000000000");
    expect(seen!.headers["X-Authorization-Signature-SHA256"]).toMatch(/^[0-9a-f]{64}$/);
    const bad = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(fetchReportAt("https://api.example", "k", "s", FEED, 1, bad)).rejects.toThrow(
      /401/,
    );
  });
});
