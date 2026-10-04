# Converge fallback scheduler. Build from the repo root:
#   docker build -f services/scheduler/fallback/Dockerfile -t converge-scheduler .
FROM node:24-slim
WORKDIR /app
RUN npm install -g pnpm@11.0.8
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/sdk ./packages/sdk
COPY services/scheduler/fallback ./services/scheduler/fallback
COPY config ./config
RUN pnpm install --frozen-lockfile --filter @converge/scheduler-fallback... --prod=false
USER node
WORKDIR /app/services/scheduler/fallback
ENV SERIES_CONFIG=/app/config/series.json HEALTH_PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.HEALTH_PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/main.ts"]
