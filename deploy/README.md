# Deploying based-server

`based-server` keeps your workspace online 24/7 on a small VPS:

| Endpoint | Purpose |
| --- | --- |
| `POST /mcp` | MCP (Streamable HTTP, JSON). Connect Claude, ChatGPT, Cursor, … |
| `GET /sync/pull?since=…`, `POST /sync/push` | Sync for the Mac/iPhone apps (works next to iCloud) |
| `POST /ask` `{prompt, model}` | Run the workspace agent once |
| `POST /agents/run` `{agent}` | Run a stored agent now |
| `GET /health` | Liveness |

All endpoints except `/health` need `Authorization: Bearer $BASED_TOKEN`.
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
