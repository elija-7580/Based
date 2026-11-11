# based-server (TypeScript, ADR 0011) – Sync v2, /collab, MCP, Dateien. BSD-75: läuft nicht als root, Dateisystem
# schreibgeschützt bis auf /data (siehe docker-compose.yml), HEALTHCHECK auf /health.
FROM node:22-bookworm-slim
ENV CI=1 PNPM_HOME=/pnpm NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
# Nur was der Server braucht (Workspace-Pakete werden als Quelle per tsx geladen).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
RUN pnpm install --frozen-lockfile --filter @based/server... \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
ENV BASED_DB=/data/based.sqlite BASED_PORT=8787 BASED_HOST=0.0.0.0
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BASED_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
WORKDIR /app/apps/server
ENTRYPOINT ["node", "--import", "tsx", "src/main.ts"]
