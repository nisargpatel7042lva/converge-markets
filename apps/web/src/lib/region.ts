import regions from "../../config/regions.json";

export type RegionDecision = { blocked: boolean; reason?: "country" | "subdivision" };

/**
 * Pure decision used by the edge middleware: the country (and subdivision) the CDN reports for the
 * request against the configured list. An unknown country (no header) is allowed: local
 * development has no CDN, and a missing header must not lock everyone out. Operators can add countries with
 * RESTRICTED_COUNTRIES_EXTRA (comma separated); removing one means editing the config file.
 */
export function regionDecision(
  country: string | null | undefined,
  subdivision: string | null | undefined,
  extra: string | undefined = undefined,
): RegionDecision {
  const list = [...regions.restricted, ...(extra ? extra.split(",") : [])]
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  const c = country?.trim().toUpperCase();
  if (c && list.includes(c)) return { blocked: true, reason: "country" };
  const subs = (regions.restrictedSubdivisions as Record<string, string[] | string>)[c ?? ""];
  const sd = subdivision?.trim().toUpperCase();
  if (c && sd && Array.isArray(subs) && subs.includes(sd))
    return { blocked: true, reason: "subdivision" };
  return { blocked: false };
}
