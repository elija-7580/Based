# Based

Local-first notes, databases and opt-in agents — everything Notion can do and a bit more, with your data on your
device. Built clean-room from public documentation.

**Based Next** is the app: a TypeScript stack (ADR [0011](docs/adr/0011-typescript-stack.md)) with one interface
for every platform — a web client, a Tauri 2 desktop app for the Mac (Windows, Linux and mobile later) and a
TypeScript `based-server` for sync, real-time text, MCP and sharing. The original Swift app is frozen in
[`legacy/`](legacy/README.md) and only serves as the specification and the source of the golden fixtures.

## Download for Mac

**[Download Based-Next.dmg](https://github.com/elija-7580/Based/releases/download/next-latest/Based-Next.dmg)** →
open it → drag *Based Next* into Applications. macOS 13 or later, Apple silicon and Intel. First launch and updates:
[`docs/desktop.md`](docs/desktop.md).

## Repository layout

| Path | What |
|---|---|
| `packages/core` | Model, store, editing, databases, formulas, import/export, search (platform-free) |
| `packages/sync` | Sync v2 client, SQLite persistence |
| `packages/editor` | Block editor (BlockNote + Yjs), whiteboard |
| `packages/database-ui`, `packages/ui`, `packages/design-tokens` | Database views, shared UI, design language „Based Default“ |
| `packages/brain` | Chat engines, agents, runs, permissions, skills, MCP connections |
| `apps/web` | The app (React + Vite); Playwright on WebKit and Chromium |
| `apps/desktop` | Tauri 2 shell for the Mac ([docs/desktop.md](docs/desktop.md)) |
| `apps/server` | `based-server` ([docs/server.md](docs/server.md), deploy: [`deploy/`](deploy/README.md)) |
| `apps/cli` | `based` command line |
| `fixtures/` | Golden fixtures exported from the Swift code ([README](fixtures/README.md)) |
| `docs/` | Sync protocol, sharing, MCP, platforms, design; `docs/adr/` — decisions ([index](docs/adr/README.md)) |
| `replica/` | Parity matrix (`features.csv`, column `ts`), backlog, build log |
| `legacy/` | Frozen Swift app, Swift server and their scripts (no new features) |

Packages never import from `apps/*` (lint rule); logic lives in `packages/*`, views stay thin.

## Develop

```bash
corepack enable && pnpm install
pnpm --filter @based/web dev                 # http://localhost:5173
pnpm --filter @based/desktop dev             # desktop app (Rust toolchain needed)
ci/typecheck/run-ts.sh --e2e                 # the gate: typecheck, lint, unit tests, Playwright
```

Before an E2E run: `pnpm --filter @based/web exec playwright install --with-deps chromium webkit`.

## License

MIT. Clean-room implementation from public Notion help docs; no Notion code or assets were used.
