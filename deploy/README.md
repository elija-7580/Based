# Deploying based-server

`based-server` keeps your workspace online 24/7 on a small VPS:

| Endpoint | Purpose |
| --- | --- |
| `POST /mcp` | MCP (Streamable HTTP, JSON). Connect Claude, ChatGPT, Cursor, … |
| `GET /sync/pull?since=…`, `POST /sync/push` | Sync for the Mac/iPhone apps (works next to iCloud) |
| `POST /ask` `{prompt, model}` | Run the workspace agent once |
| `POST /agents/run` `{agent}` | Run a stored agent now |
| `GET /health` | Liveness |

All endpoints except `/health`, `/app` and the sharing pages (`/s/…`, `/p/…`, invite accept) need
`Authorization: Bearer $BASED_TOKEN` – the header only; `?token=` in the URL is ignored (it would end up in logs).
Routes are registered in one table with auth middleware (`Packages/BasedBrain/Sources/BasedBrain/Server/`, ADR 0006):
a new route is owner-only unless it says otherwise. Limits: 1 MiB request body (32 MiB for sync pushes and MCP),
413 above that; 30 s receive timeout; 64 simultaneous connections (503 beyond). CORS headers are only sent for the
origin of `BASED_PUBLIC_URL`.

**Without a token the server only listens on 127.0.0.1.** To open it to the network anyway (e.g. a trusted LAN
during setup), pass `--insecure-public` (or `BASED_INSECURE_PUBLIC=1`); it logs a warning and every endpoint
except the sandboxes is open to anyone who can reach it.
Scheduled agents run inside the server (every minute it checks the **Agents** database in your
Agent Brain page: `Schedule` such as `daily 07:00`, `weekdays 18:00`, `every 30m`, `weekly mon 09:00`
or 5-field cron; `Model` such as `anthropic/claude-sonnet-4-5`; `Daily token budget`).

## Docker (recommended)

```bash
git clone https://github.com/elija-7580/Based && cd Based/deploy
cat > .env <<EOT
BASED_DOMAIN=based.example.com
BASED_TOKEN=$(openssl rand -hex 32)
ANTHROPIC_API_KEY=sk-ant-…
OPENAI_API_KEY=sk-…
EOT
docker compose up -d --build
curl https://based.example.com/health
```

Caddy obtains the TLS certificate automatically. Point the DNS A record at the VPS first.

## Bare metal

```bash
swift build -c release --package-path Packages/BasedBrain
sudo install Packages/BasedBrain/.build/release/based-server /usr/local/bin/
sudo useradd -r based && sudo mkdir -p /var/lib/based /etc/based && sudo chown based /var/lib/based
echo "BASED_TOKEN=$(openssl rand -hex 32)" | sudo tee /etc/based/env
sudo cp deploy/based-server.service /etc/systemd/system/ && sudo systemctl enable --now based-server
```

## Connect the apps

Settings → **AI** → *Based server*: URL `https://based.example.com`, token from `.env`, **Connect**.
The app pushes its workspace on first connect and then syncs every 20 s plus on every change.

## Connect AI clients (MCP)

See `claude-desktop.json`. Remote: URL `https://based.example.com/mcp` with the bearer token.
Local (no server): `based-server --stdio --db <path to based.sqlite>`.
Every client gets the same tools (`search`, `read_page`, `create_page`, `query_database`, `memory_save`, `load_skill`, …),
your pages as resources (`based://page/<id>`), and your skills as prompts.

## Backups

The whole workspace is one SQLite file (`/data/based.sqlite` in the volume). `sqlite3 based.sqlite ".backup b.sqlite"` or snapshot the volume.

## Sharing

Pages shared from the app (Share ⌄ → *Share on the web…*) are served here: `/s/<secret>` for links and invites,
`/p/<id>` for published pages. Set `BASED_PUBLIC_URL` (docker-compose derives it from `BASED_DOMAIN`) so links carry
the right address, and optionally `BASED_APPLE_APP_ID=<TeamID>.<bundle id>` so they open in the Based app.
Details and endpoints: [`docs/sharing.md`](../docs/sharing.md).

## Coding-agent daemon (Happier-style)

The same `based-server` is the daemon that runs Claude Code / Codex / Gemini
for your iPhone (and for Macs that prefer it). It needs the agent CLIs on the
machine (`npm i -g @zed-industries/claude-code-acp @zed-industries/codex-acp`
or `npx` available; `gemini`, `opencode`, `pi` optional) and the same
end-to-end key as your devices:

```
based-server --db /var/lib/based/based.sqlite --token "$TOKEN" \
  --cipher-key "$(cat /etc/based/session.key)" --machine vps-1
```

| Endpoint | Purpose |
| --- | --- |
| `GET /acp/agents` | installed agents |
| `GET/POST /sessions` | list / start `{agent, cwd, title, prompt}` |
| `POST /sessions/{id}/prompt` | send a message (blocks until the turn ends) |
| `GET /sessions/{id}/transcript` | decrypted Markdown |
| `POST /sessions/{id}/cancel` · `/stop` · `/switch {agent}` | control |
| `GET /inbox?pending=true` · `POST /inbox/{id}/resolve {decision}` | approvals |
| `GET /connections` · `POST /connections/reload` | MCP connections |

Secrets for connections come from environment variables named after the
Keychain key (`CONNECTION.GITHUB` → `CONNECTION_GITHUB` works too). Sessions,
Inbox and Connections are ordinary records, so they sync to every app.

## Sandbox for coding agents (BSD-53)

By default (`--sandbox local`) coding agents run directly in the project folder, as on the Mac. With
`--sandbox docker` (or `BASED_SANDBOX=docker`) every agent session/run gets its own container:

```sh
docker build -f deploy/sandbox.Dockerfile -t based-sandbox:latest deploy
based-server --token "$BASED_TOKEN" --sandbox docker \
  --sandbox-mount /home/based/.claude:/root/.claude \
  --sandbox-mount /home/based/.codex:/root/.codex
```

- Container: `based-<project>-<session>`, project folder mounted at `/workspace/<project>`, `--cpus 2 --memory 4096m
  --pids-limit 1024 --security-opt no-new-privileges` (`BASED_SANDBOX_CPUS`, `BASED_SANDBOX_MEMORY_MB`), network on
  (`--sandbox-no-network` / `BASED_SANDBOX_NETWORK=none` turns it off).
- **Secrets:** nothing from the server's environment enters the container except an allowlist (`LANG`, `LC_*`, `TERM`,
  `TZ`, `CI`, `NO_COLOR`; more names with `--sandbox-env NAME`). Names that look like secrets (`*TOKEN*`, `*_KEY`,
  `*SECRET*`, …) are dropped even when listed. Values are passed as `docker exec -e NAME`, never on the command line.
  Agent logins come from read-only mounts (`--sandbox-mount host:container`, `:ro` is added).
- **Snapshots** (owner token required; an open server without token never exposes these routes):
  `GET /sandboxes`, `POST /sandboxes/{session}/snapshot {"name":"green"}` (= `docker commit` + tar.gz of the folder in
  `sandbox-snapshots/` next to the database), `POST /sandboxes/{session}/restore {"snapshot":"green"}` (new container
  from the snapshot image; the current folder is kept as `<folder>.before-restore-<time>`), `POST /sandboxes/{session}/destroy`.
  The Runs database shows `Sandbox` (`docker:<id>`) and `Snapshots` per run.
- **Docker socket:** based-server needs to run `docker`, i.e. its user must be in the `docker` group (bare metal) or the
  container gets `-v /var/run/docker.sock:/var/run/docker.sock` plus the docker CLI. **Security:** access to the Docker
  socket is root-equivalent on the host. Only enable `--sandbox docker` on a machine dedicated to Based, with a token,
  behind TLS.
- Not yet: stdio MCP servers (incl. `based`) inside the container – sandboxed agents currently get no MCP servers;
  Claude Code runs through its ACP adapter instead of the native driver in this mode.

## Secrets and coding agents (BSD-33)

Agents started by Based (Claude Code, Codex, Gemini, ACP adapters, MCP servers over stdio) never inherit the
server's environment wholesale. They get an allowlist (`PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `XDG_*`, `TERM`,
`TMPDIR`, proxies/CA bundles, toolchain paths, `DOCKER_*` for the sandbox CLI) plus agent config folders
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Everything named `BASED_*` or looking like a secret (`*_TOKEN`, `*_KEY`,
`*SECRET*`, `*PASSWORD*` …) is dropped – `BASED_TOKEN`, `BASED_CIPHER_KEY` and `ANTHROPIC_API_KEY` stay with the
server. To let a key through to one agent on purpose, list it in the defaults key `based.agentEnv.<agent-id>`
(comma-separated, e.g. `defaults write <app-domain> based.agentEnv.claude ANTHROPIC_API_KEY` on the Mac).

The MCP config for Claude Code is written to a private file (`$TMPDIR/based-mcp-<uid>/…json`, mode 0600, deleted
when the session ends) instead of the command line, and it carries a per-session token (`bds_…`) that only opens
`/mcp/session/<that session>` – not `/mcp`, not `/sync/*` – and is revoked when the session stops.
