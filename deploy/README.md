# Deploying based-server

`based-server` (TypeScript, `apps/server`, ADR 0011) keeps your workspace online on a small VPS: sync for every
device, real-time text, MCP for AI clients, sharing links and scheduled agent runs. Full reference (options,
endpoints, limits): [`docs/server.md`](../docs/server.md).

> Since BSD-168 this folder deploys the TypeScript server only. The old Swift server lives in `legacy/deploy/` and is
> no longer maintained. Both read and write the **same SQLite file** – to switch, stop the old container and start this
> one on the same volume. Never run both on one file at the same time.

## Docker (recommended)

```bash
git clone https://github.com/elija-7580/Based && cd Based/deploy
cat > .env <<EOT
BASED_DOMAIN=based.example.com
BASED_TOKEN=$(openssl rand -hex 32)
# optional: scheduled agent runs on the server (otherwise they run while the app is open)
BASED_ANTHROPIC_API_KEY=
EOT
docker compose up -d --build
curl https://based.example.com/health      # {"ok":true,"impl":"ts",…}
```

- `based` runs as user `node`, read-only file system except `/data` and `/tmp`, no extra capabilities, health check on
  `/health`.
- `backup` writes a daily `sqlite3 .backup` of `/data/based.sqlite` into the `based-backup` volume (7 days, `backup.sh`).
- `caddy` obtains the TLS certificate automatically and forwards WebSockets (`/collab`). Point the DNS A record at the
  VPS first.

Without `BASED_TOKEN` the server refuses to start.

## Bare metal

```bash
corepack enable && pnpm install --frozen-lockfile --filter @based/server...
BASED_TOKEN=$(openssl rand -hex 32) BASED_DB=/var/lib/based/based.sqlite \
  pnpm --filter @based/server start -- --port 8787 --public-url https://based.example.com
```

## Connect the apps

Based Next → Settings → **Sync & server**: URL `https://based.example.com`, token from `.env`, **Connect**.
On a Mac without a server, Settings → Sync & server → *Local server & command line* starts one inside the app.

## Connect AI clients (MCP)

See `claude-desktop.json`. Remote: `https://based.example.com/mcp` with the bearer token. Local on the Mac: turn on
Settings → Sync & server → *Local server* in Based Next, then use `http://127.0.0.1:47821/mcp` with the token from
`~/.config/based/local.json` (only while the app runs). A server started with `--stdio --db <file>` works for a
workspace file on disk.

## Sandbox for coding agents

`--sandbox docker` (or `BASED_SANDBOX=docker`) gives every run its own container; build the image with
`docker build -f deploy/sandbox.Dockerfile -t based-sandbox:latest deploy`. Coding agents (Claude Code, Codex) need
`--coding-root <folder>`. Details and the security notes: [`docs/server.md`](../docs/server.md#sandbox-pro-lauf-bsd-161).
