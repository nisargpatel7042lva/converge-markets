# The testnet backend in one container: price relay, keeper and round scheduler, supervised together.
# Build from the repo root:
#   docker build -f ops/testnet-backend/Dockerfile -t converge-testnet-backend .
FROM node:24-slim
WORKDIR /app
RUN npm install -g pnpm@11.0.8
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/sdk ./packages/sdk
COPY packages/strategy ./packages/strategy
COPY services/keeper ./services/keeper
COPY scripts/keeper-live ./scripts/keeper-live
COPY config ./config
COPY deployments ./deployments
RUN pnpm install --frozen-lockfile --filter @converge/keeper... --filter @converge/keeper-live... --prod=false \
  && mkdir -p /var/lib/converge && chown node:node /var/lib/converge
COPY ops/testnet-backend/entrypoint.sh /app/entrypoint.sh
USER node
ENV KEEPER_CONFIG=/app/config/keeper.testnet.json HTTP_HOST=0.0.0.0 HTTP_PORT=9100 \
    OUT_DIR=/var/lib/converge KILL_FILE=/var/lib/converge/KILL MODE=live \
    RPC_URLS=https://testnet-rpc.monad.xyz,https://rpc-testnet.monadinfra.com WS_URL=wss://testnet-rpc.monad.xyz
EXPOSE 9100
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bash", "/app/entrypoint.sh"]
