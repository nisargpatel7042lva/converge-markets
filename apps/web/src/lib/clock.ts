import { publicClient } from "./chain";

/**
 * "Now" for countdowns and rounds is the chain's time, not this device's clock: a phone that is
 * a minute off must not show a round that has already ended as live, and a local test chain can
 * run ahead of the wall clock. The offset is refreshed from the latest block every few seconds.
 */
let offsetSec = 0;
let synced = false;

export const nowSec = () => Math.floor(Date.now() / 1000 + offsetSec);
/** Chain time with sub-second resolution (for the odds, which depend on the time left). */
export const nowSecFloat = () => Date.now() / 1000 + offsetSec;
export const isClockSynced = () => synced;

export async function syncClock(): Promise<void> {
  try {
    const t0 = Date.now() / 1000;
    const block = await publicClient.getBlock({ blockTag: "latest" });
    // The block is up to a block time old and its timestamp has whole-second resolution, so each sample
    // is off by up to a second or two. Applying every sample made the countdown jump by a second every
    // few seconds; instead the offset follows an exponential average and ignores sub-second noise.
    const sample = Number(block.timestamp) - (t0 + (Date.now() / 1000 - t0) / 2);
    if (!synced || Math.abs(sample - offsetSec) > 5)
      offsetSec = sample; // first sync, or the chain clock really moved
    else offsetSec += (sample - offsetSec) * 0.2;
    synced = true;
  } catch {
    // keep the previous offset
  }
}
