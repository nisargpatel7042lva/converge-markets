# Testnet backend: keep the markets running without your laptop

Three processes make the testnet markets live: the **price relay** (real Binance, Coinbase, OKX and Gate prices), the **keeper** (the vault's quotes, executions, volatility) and the **scheduler** (creates, opens and resolves each 15-minute round for ETH, BTC and MON). Today they run on one developer machine, so the markets stop when it sleeps. This folder packages them as one container (`Dockerfile`, `entrypoint.sh`) that any host with Docker can keep running.

Status: the image builds, and in a smoke test (dry-run, throwaway keys) the relay and keeper came up healthy with all three prices. It has **not been deployed to a host**: that needs an account of yours and three secrets (below).

## What you need to decide

1. **A host.** Anything that runs a Docker image all day: Fly.io (`fly.toml` here), Railway, Render, a small VPS. The app on Vercel cannot run these: they are long-lived processes with sockets.
2. **Three keys, never pasted into chat.** Set them as the host's secrets:

   | Secret | What it is | Needs |
   |---|---|---|
   | `KEEPER_PRIVATE_KEY` | the vault's KEEPER key | MON for gas |
   | `STREAMS_TEST_SIGNER_KEY` | the testnet price signer (test-only verifier) | nothing |
   | `SCHEDULER_PRIVATE_KEY` | creates rounds | the factory's `CREATOR_ROLE` and MON for gas |

   Use a **dedicated scheduler key** rather than the deployer key (which owns the vault, the factory and the resolver on testnet). Grant it the role from the deployer: `cast send <factory> "grantRole(bytes32,address)" $(cast keccak CREATOR_ROLE) <new address> --private-key ...`. `DEPLOYER_PRIVATE_KEY` is accepted as a fallback.
3. **MON to run on.** Measured: about **0.2 MON per series per 15-minute round** (keeper plus scheduler), so about **2.6 MON an hour for ETH, BTC and MON, about 63 a day** (`docs/evidence/phase-10/multi-asset-testnet.md`). ETH alone is about 21 a day. If you cannot fund that, run fewer series (`SERIES=ETH,BTC`) or only during judging windows. The in-app faucet also spends 0.1 MON of gas per new account.

## Run it

```bash
docker build -f ops/testnet-backend/Dockerfile -t converge-testnet-backend .
docker run -d --restart unless-stopped --name converge-testnet-backend \
  -e KEEPER_PRIVATE_KEY -e STREAMS_TEST_SIGNER_KEY -e SCHEDULER_PRIVATE_KEY \
  converge-testnet-backend
```

(`-e NAME` with no value passes your shell's variable without printing it.) Options: `SERIES=ETH,BTC,MON`, `RUN_SCHEDULER=0` (relay and keeper only), `MODE=dry-run` (log what the keeper would send). The keeper's status is on port 9100 inside the container (`/status`, `/health`).

If any of the three processes stops, the container exits so the host restarts it. **Run only one copy**: two keepers or two schedulers spend double the gas and fight over nonces.

## Not in the container

The Kuru lister (`services/kuru`, ETH series only) and the Vercel app's faucet key stay where they are.
