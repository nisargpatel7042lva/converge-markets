import { mnemonicToAccount, privateKeyToAddress } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { privateKeyFromPrf, mnemonicFromPrf } from "../src/lib/derive";
import { handleOf } from "../src/lib/handle";
import { regionDecision } from "../src/lib/region";
import { clock, nativeAmount, pct, short, signedUsd, usd } from "../src/lib/format";
import { gridStarts } from "../src/lib/data";

describe("account derivation (the Mera guide's path)", () => {
  const prf = new Uint8Array(32).map((_, i) => i * 7 + 1);
  it("derives the same address MetaMask derives from the exported phrase", () => {
    const key = privateKeyFromPrf(prf);
    const hex = `0x${Buffer.from(key).toString("hex")}` as const;
    const viaPhrase = mnemonicToAccount(mnemonicFromPrf(prf));
    expect(privateKeyToAddress(hex)).toBe(viaPhrase.address);
    expect(mnemonicFromPrf(prf).split(" ")).toHaveLength(24);
  });
  it("is deterministic and rejects a wrong-sized secret", () => {
    expect(Buffer.from(privateKeyFromPrf(prf)).toString("hex")).toBe(
      Buffer.from(privateKeyFromPrf(prf)).toString("hex"),
    );
    expect(() => privateKeyFromPrf(new Uint8Array(16))).toThrow();
  });
});

describe("handles", () => {
  it("are friendly, stable and case-insensitive", () => {
    const a = "0x00000000000000000000000000000000000000AA";
    expect(handleOf(a)).toMatch(/^[a-z]+-[a-z]+-\d\d$/);
    expect(handleOf(a)).toBe(handleOf(a.toLowerCase()));
    expect(handleOf(a)).not.toBe(handleOf("0x00000000000000000000000000000000000000AB"));
  });
});

describe("region block", () => {
  it("blocks India and the embargoed countries by default, and nobody else", () => {
    expect(regionDecision("IN", null).blocked).toBe(true);
    expect(regionDecision("in", null).blocked).toBe(true);
    for (const c of ["CU", "IR", "KP", "SY"]) expect(regionDecision(c, null).blocked).toBe(true);
    expect(regionDecision("DE", null).blocked).toBe(false);
    expect(regionDecision("US", null).blocked).toBe(false); // a legal decision, flagged for Nisarg
  });
  it("blocks the sanctioned Ukrainian regions by subdivision", () => {
    expect(regionDecision("UA", "43")).toEqual({ blocked: true, reason: "subdivision" });
    expect(regionDecision("UA", "30").blocked).toBe(false);
  });
  it("lets a missing header through; an extra list adds countries and never removes one", () => {
    expect(regionDecision(null, null).blocked).toBe(false);
    expect(regionDecision("DE", null, "DE, FR").blocked).toBe(true);
    expect(regionDecision("IN", null, "DE").blocked).toBe(true); // India stays blocked
    expect(regionDecision("UA", "40").blocked).toBe(true); // Sevastopol
  });
});

describe("formatting", () => {
  it("formats money, percentages and clocks", () => {
    expect(usd(12_500_000n)).toBe("$12.50");
    expect(usd(-1_234_567n)).toBe("-$1.23");
    expect(signedUsd(5_000_000n)).toBe("+$5.00");
    expect(pct(0.634)).toBe("63%");
    expect(clock(73)).toBe("1:13");
    expect(clock(3725)).toBe("1:02:05");
    expect(clock(-5)).toBe("0:00");
    expect(short("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
    expect(nativeAmount(50_000_000_000_000_000n)).toBe("0.050");
  });
});

describe("round grid", () => {
  it("lists the starts around now on the series' grid", () => {
    expect(gridStarts(900, 1_000_450, 2, 1)).toEqual(
      [998_100, 999_000, 999_900, 1_000_800].map((x) => x),
    );
  });
});
