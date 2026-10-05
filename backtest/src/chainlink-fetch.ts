/** `pnpm --filter @converge/backtest backtest:chainlink` (needs MONAD_MAINNET_RPC_URL). */
import { fetchBasis } from "./data/chainlink";

const rpc = process.env.MONAD_MAINNET_RPC_URL;
if (!rpc) throw new Error("set MONAD_MAINNET_RPC_URL (an archive-capable Monad mainnet RPC)");
await fetchBasis(rpc);
