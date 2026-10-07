import type { Round } from "./data";

/** Rounds cross the server/client boundary as JSON: bigints travel as decimal strings. */
export type WireRound = Omit<Round, "strike" | "endPrice"> & { strike: string; endPrice: string };

export const toWire = (r: Round): WireRound => ({
  ...r,
  strike: r.strike.toString(),
  endPrice: r.endPrice.toString(),
});
export const fromWire = (r: WireRound): Round => ({
  ...r,
  strike: BigInt(r.strike),
  endPrice: BigInt(r.endPrice),
});
