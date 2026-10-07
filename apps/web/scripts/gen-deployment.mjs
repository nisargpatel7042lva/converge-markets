/* global console */
// Writes src/config/testnet.json from deployments/testnet.json: the addresses the app needs and
// the series it lists. Run after a redeploy: `pnpm --filter @converge/web gen:deployment`.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dep = JSON.parse(readFileSync(resolve(here, "../../../deployments/testnet.json"), "utf8"));
const out = {
  name: "Monad testnet",
  network: "testnet",
  chainId: dep.chainId,
  rpcUrl: "https://testnet-rpc.monad.xyz",
  explorerUrl: "https://testnet.monadvision.com",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  nativeSymbol: "MON",
  usdc: dep.collateral_tUSDC,
  factory: dep.marketFactory,
  vault: dep.vault.vault,
  venue: dep.vault.forwardVenue,
  minRewardWei: "1000000000000000",
  deployBlock: dep.vault.deployBlock,
  testnet: true,
  series: [
    {
      label: "TEST/USD",
      assetId: dep.assetTEST,
      name: "ETH",
      pair: "ETH/USD",
      symbol: "ETH",
      binance: "ETHUSDT",
      coinbase: "ETH-USD",
      durations: [900],
      decimals: 2,
    },
  ],
};
writeFileSync(resolve(here, "../src/config/testnet.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log("wrote src/config/testnet.json", out.vault, out.venue);
