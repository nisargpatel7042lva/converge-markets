import { readConfig } from "../lib/config";
import { MarketEmbed } from "./MarketEmbed";

// Read on the server at request time so one build can point at any deployment.
export const dynamic = "force-dynamic";

export default function Page() {
  const cfg = readConfig(process.env);
  return (
    <main>
      <header>
        <h1>Your app, with a market and real depth</h1>
        <p>
          This page is the whole integration: the market below was created by a partner app and the
          Converge Vault quotes both sides. It uses only <code>@converge/sdk</code>.
        </p>
      </header>
      <MarketEmbed cfg={cfg} />
    </main>
  );
}
