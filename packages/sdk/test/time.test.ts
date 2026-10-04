import { describe, expect, it } from "vitest";
import {
  FIFTEEN_MINUTES as M15,
  ONE_HOUR as H1,
  isAligned,
  isoUtc,
  nextBoundary,
  recentStarts,
  roundStart,
  upcomingStarts,
} from "../src/time";

const t = (iso: string) => BigInt(Date.parse(iso) / 1000);

describe("UTC boundaries", () => {
  it("aligns 15m and 1h rounds to the UTC wall clock", () => {
    expect(roundStart(t("2026-10-01T14:22:59Z"), M15)).toBe(t("2026-10-01T14:15:00Z"));
    expect(nextBoundary(t("2026-10-01T14:22:59Z"), M15)).toBe(t("2026-10-01T14:30:00Z"));
    expect(roundStart(t("2026-10-01T14:22:59Z"), H1)).toBe(t("2026-10-01T14:00:00Z"));
    expect(nextBoundary(t("2026-10-01T14:59:59Z"), H1)).toBe(t("2026-10-01T15:00:00Z"));
    expect(isAligned(t("2026-10-01T14:15:00Z"), M15)).toBe(true);
    expect(isAligned(t("2026-10-01T14:15:00Z"), H1)).toBe(false);
  });

  it("an exact boundary is its own round start; the next boundary is strictly later", () => {
    const b = t("2026-10-01T14:15:00Z");
    expect(roundStart(b, M15)).toBe(b);
    expect(nextBoundary(b, M15)).toBe(b + M15);
  });

  it("crosses month, year and leap-day edges without DST effects", () => {
    expect(nextBoundary(t("2026-10-31T23:59:30Z"), M15)).toBe(t("2026-11-01T00:00:00Z"));
    expect(nextBoundary(t("2026-12-31T23:45:00Z"), H1)).toBe(t("2027-01-01T00:00:00Z"));
    expect(nextBoundary(t("2028-02-28T23:50:00Z"), M15)).toBe(t("2028-02-29T00:00:00Z"));
    expect(nextBoundary(t("2028-02-29T23:59:59Z"), H1)).toBe(t("2028-03-01T00:00:00Z"));
    // Europe/US DST change dates are irrelevant: unix time is UTC.
    expect(nextBoundary(t("2026-03-29T00:59:00Z"), H1)).toBe(t("2026-03-29T01:00:00Z"));
    expect(nextBoundary(t("2026-11-01T05:59:00Z"), H1)).toBe(t("2026-11-01T06:00:00Z"));
  });

  it("lists upcoming and recent starts", () => {
    const now = t("2026-10-01T14:22:00Z");
    expect(upcomingStarts(now, M15, 3)).toEqual([
      t("2026-10-01T14:30:00Z"),
      t("2026-10-01T14:45:00Z"),
      t("2026-10-01T15:00:00Z"),
    ]);
    expect(recentStarts(now, M15, 1800n)).toEqual([
      t("2026-10-01T14:15:00Z"),
      t("2026-10-01T14:00:00Z"),
    ]);
    expect(isoUtc(t("2026-10-01T14:15:00Z"))).toBe("2026-10-01T14:15:00Z");
  });

  it("rejects unsupported durations and negative time", () => {
    expect(() => roundStart(100n, 60n)).toThrow("unsupported duration");
    expect(() => roundStart(-1n, M15)).toThrow("negative time");
  });
});
