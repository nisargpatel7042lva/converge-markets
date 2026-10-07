import { MarketsView } from "@/components/markets-view";
import { readAllRounds } from "@/lib/data";
import { toWire } from "@/lib/serialize";

// Rendered on the server per request: the first paint already has the rounds, no client round trip.
export const dynamic = "force-dynamic";

export default async function Markets() {
  const serverNow = Math.floor(Date.now() / 1000);
  let initial = null;
  try {
    initial = (
      await Promise.race([
        readAllRounds(serverNow),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("slow rpc")), 2500)),
      ])
    ).map(toWire);
  } catch {
    // the client loads them (and shows its own loading and error states)
  }
  return <MarketsView initial={initial} serverNow={serverNow} />;
}
