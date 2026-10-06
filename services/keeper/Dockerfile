# Converge keeper. Build from the repo root:
#   docker build -f services/keeper/Dockerfile -t converge-keeper .
FROM node:24-slim
WORKDIR /app
RUN npm install -g pnpm@11.0.8
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/sdk ./packages/sdk
COPY packages/strategy ./packages/strategy
COPY services/keeper ./services/keeper
COPY config ./config
RUN pnpm install --frozen-lockfile --filter @converge/keeper... --prod=false \
  && mkdir -p /var/lib/converge-keeper && chown node:node /var/lib/converge-keeper
USER node
WORKDIR /app/services/keeper
ENV KEEPER_CONFIG=/app/config/keeper.testnet.json \
    HTTP_HOST=0.0.0.0 HTTP_PORT=9100 \
    OUT_DIR=/var/lib/converge-keeper KILL_FILE=/var/lib/converge-keeper/KILL \
    MODE=dry-run
EXPOSE 9100
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.HTTP_PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/main.ts"]
