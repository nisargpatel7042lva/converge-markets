import { publicClient } from "./chain";

/**
 * "Now" for countdowns and rounds is the chain's time, not this device's clock: a phone that is
 * a minute off must not show a round that has already ended as live, and a local test chain can
 * run ahead of the wall clock. The offset is refreshed from the latest block every few seconds.
 */
let offsetSec = 0;
let synced = false;

export const nowSec = () => Math.floor(Date.now() / 1000 + offsetSec);
export const isClockSynced = () => synced;

export async function syncClock(): Promise<void> {
  try {
    const t0 = Date.now() / 1000;
    const block = await publicClient.getBlock({ blockTag: "latest" });
    // the block is up to one block time old: that error (under a second) is fine for countdowns
    offsetSec = Number(block.timestamp) - (t0 + (Date.now() / 1000 - t0) / 2);
    synced = true;
  } catch {
    // keep the previous offset
  }
}
