# Based

Native, local-first notes for **macOS and iPhone** (iPad runs; watchOS planned):
pages, a block editor, databases and an **Agent Brain** — memories, skills and
scheduled agents that every connected AI (in-app, Claude, ChatGPT, Cursor via
MCP) shares. Synced through your own iCloud and/or your own server. Modeled on
Notion's features and built clean-room from public documentation.

> Prototype. 142 of 179 tracked features are implemented, 22 partially;
> see [`replica/features.csv`](replica/features.csv) for the parity matrix and
> [`replica/build-log.md`](replica/build-log.md) for progress.
> The core package is unit-tested on Linux. The SwiftUI app has been
> type-checked against API stubs only — the first Xcode build may still need
> small fixes (see *Status* below).

## What works

- **Pages**: tree in sidebar, drag & drop, icons (emoji/image), covers, fonts,
  small text, full width, lock, duplicate, move, favorites, trash with restore,
  backlinks, deep links (`based://page/<id>`), search (⌘K / ⌘P), Home.
- **Block editor**: every Notion block type except tabs — text, headings 1–4,
  lists, to-dos, toggles & toggle headings, quote, callout, divider, code,
  equation, image/video/audio/file/PDF, bookmark, embed, TOC, breadcrumb,
  columns, simple table, synced block, button, link to page, child page.
  Slash menu, Markdown shortcuts, inline Markdown, @-mentions (pages, dates),
  ⌘K links, colours, turn into, drag handle, block menu, multi-select,
  ⌘⇧↑↓, ⌘D, ⌘⌥0–9, undo/redo, paste Markdown/URLs, copy as Markdown,
  emoji picker, word count.
- **Databases**: inline, full-page and linked views; table, board, list,
  gallery, calendar, timeline; filters (and/or groups), multi-sort, group by,
  hidden groups, calculations, per-view property visibility/order, templates,
  side peek / center peek / full page. All property types incl. status, date
  ranges, relation (two-way), rollup, formula (Formula 2.0 subset), unique ID,
  files, number formats, type conversion.
- **Sync**: CloudKit `CKSyncEngine` (private DB), offline-first, HLC
  last-writer-wins per record, fractional-index ordering, assets as CKAssets.
- **Import / export**: **1:1 import from Notion** — through the Notion API
  (paste page / database links or import everything shared with an
  integration: formatting, colors, toggles, callouts, columns, tables, synced
  blocks, files, databases with every property type, views with filters,
  sorts, groups, cover and column widths, rows with content, two-way
  relations, rollups, formulas) or from a Notion **HTML export** `.zip`
  (lossless: markup without a native block is kept as an HTML block with
  preview). Importing the same pages again updates them in place. Also the
  Markdown + CSV export, unzipped folders, Markdown files; export page as
  Markdown, database as CSV.
- **App**: light/dark/system (⇧⌘L), settings, iPhone keyboard toolbar and
  long-press menus, iPad runs (layout not tuned).

- **Agent Brain** (`Packages/BasedBrain`): an *Agent Brain* page in the
  workspace holds **Memories** (Title + Type, like Notion AI), **Skills**
  (reusable instructions, exposed as MCP prompts) and **Agents** (instructions
  page + `Schedule` + `Model` + token budget). Chat with the workspace agent
  (⌘J); it reads/writes pages and databases through tools and saves memories.
  Providers: Anthropic and OpenAI API keys, any OpenAI-compatible server
  (Ollama), Apple Intelligence on device for *Autofill with AI* on properties.
- **MCP server**: `based-server --stdio` or `POST /mcp` — same tools, pages as
  resources, skills as prompts, for Claude Desktop, ChatGPT, Cursor, ….
- **Server sync**: `based-server` on a VPS keeps the workspace online, runs
  agents on schedule and syncs with the apps (HLC last-writer-wins, same as
  iCloud). See [`deploy/`](deploy/README.md).
- **Notion API import**: File → *Import from Notion…* (⌥⌘I) for pages and
  databases; Settings → AI → *Import from Notion* additionally brings over
  Memories, Skills and the About page of a Notion Agent setup.
- **Page outline**: floating heading rail on the right (hover to expand,
  click to jump); per-page toggle. Shortcuts added: ⌘J Ask AI, ⌘⇧U parent
  page, ⌘\ sidebar.
- **Control room for coding agents** (Happier-style, built in): **Sessions**
  run Claude Code, Codex, Gemini CLI, OpenCode, Pi or any ACP agent in a folder
  — from the Mac directly or through the `based-server` daemon for iPhone —
  with live transcript, tool-call feed, plan, token counter and *switch agent
  mid-session* (the transcript is handed over). **Inbox** collects every
  `session/request_permission` and question; approve/reject on any device.
  Transcripts are end-to-end encrypted (ChaCha20-Poly1305, key in Keychain,
  pairing by pasting the key). ⌘J → *Run with Claude Code* hands a prompt over.
- **Connections** (MCP client): add GitHub, Slack, Google Drive/Gmail/Calendar,
  Linear, Notion, Filesystem, Brave Search, Fetch, Apple Notes/Reminders or any
  stdio/HTTP MCP server once; the Agent Brain gets their tools (`github__…`)
  and every coding-agent session receives them as `mcpServers`. Based itself
  is handed to the agents as an MCP server, so they can read/write your pages.
- **Visualisations**: **Chart** view for databases (bar, horizontal bar, line,
  area, pie, donut; count/sum/avg/min/max/median; date buckets day→year; option
  colours; legend, values, limit + “Other”) and **HTML / Mermaid blocks** —
  code blocks with language `html` or `mermaid` get a *Code | Preview* toggle
  and render sandboxed (D3, Chart.js, any HTML). The brain can create both
  (`create_chart`, `add_html`, `add_mermaid`).
- **Large databases**: length-prefixed fractional index keys (50k appends stay
  ≤5 chars), in-place child index, memoised `QueryCache` keyed by store
  revision, lazy table rows with *Load 50 more / Load all*. Benchmark in
  `ChartAndCacheTests`: 50k rows insert 1.7 s, sorted query 0.5 s, cached hit
  ~10 µs (debug build, Linux).
- **Settings like Notion**: Account (My account, My settings, My notifications,
  My connections, Language & region) and Workspace (Settings, People,
  Teamspaces, Security, Agents & AI, Connections, Import, Sync & server,
  Billing, About) with start page, cursor on open, spell-check, week start,
  timezone, date format, export all content, reset workspace, …
- **Workspace shell like Notion** (Pass 9): Notion-style sidebar
  (workspace menu, search, home, inbox, agents, favorites, private pages,
  multi-select with ⌘/⇧-click + bulk open in tabs / favorite / duplicate /
  move / delete), **tabs** (⌘T,
  ⌘W, ⌃Tab, ⌘1–9, drag to reorder), **search overlay** (⌘K, Pages / Chats
  scopes, date-grouped results, *Ask AI*, ⌘↵ opens in new tab), **command
  palette** (⌘N: page, AI chat, meeting notes, database, agent session,
  import), **find in page** (⌘F, ⌘G / ⇧⌘G), the **AI chat as right-side
  panel** (⌘J, resizable, floats over narrow windows, *open as full page*),
  side peek with ⌃⇧↑/↓ to step through rows, database row multi-select with
  bulk actions. The block gutter (`+` / `⋮⋮`) sits in a reserved 44-pt
  margin, so it is always visible on hover and clickable.
- **Coding agents, Claude Code style**: *Agents* lists sessions grouped by
  project plus your existing Claude Code / Codex CLI history
  (`~/.claude/projects`, `~/.codex/sessions`). A session opens as a console —
  transcript with tool calls, inline permission prompts (press 1/2/3),
  `shift+tab` cycles the permission mode, `esc` interrupts — or as a **real
  terminal** (SwiftTerm) running `claude` / `codex` in the project folder.
  *Agent setup* (Settings → Agents & AI) finds the CLIs through your login
  shell, checks the Claude login and runs a test prompt per agent. The Agent
  Brain opens as a dashboard (About, Memories, Skills, Scheduled agents,
  Connections).
- **Diagnostics & logs** (Help → Diagnostics & Logs, ⌥⇧⌘D): rotating JSONL
  log (`~/Library/Application Support/Based/Logs`, level in Settings →
  Diagnostics), main-thread **hang watchdog** (pings every 250 ms, records
  stalls > 0.5 s with the last breadcrumbs), crash reporter (alert on next
  launch), **layout audit** that flags overlapping and clipped controls,
  slow-operation timing (`Log.measure`)
  and *Export logs…* (report header + log) for bug reports.
- **UI tests**: `App/UITests` (XCUITest, macOS + iOS) walk sidebar, new page,
  slash menu, search, command palette, tabs, find, chat panel, block gutter,
  Agents/Inbox, Agent Brain dashboard, every Settings page, the database
  table and a layout check for overlapping/clipped elements; `make uitest`.

Not implemented: comments, sharing/publishing, page history, real-time
multi-user, form/feed/map views, sub-items, HTML/PDF export,
share extension, widgets, watchOS target.

## Repository layout

- `Packages/BasedCore` — model, store, editing, databases, formulas,
  import/export, search, sync core (Swift package; Foundation only, tested on
  Linux and macOS)
- `Packages/BasedBrain` — AI providers, agent tools/runtime/scheduler, MCP
  server, HTTP server, server sync, Notion API import, and the `based-server`
  executable (Foundation only, tested on Linux)
- `deploy/` — Dockerfile, docker-compose + Caddy, systemd unit, MCP client config
- `App/Shared` — SwiftUI app shared by macOS and iOS; `App/macOS`, `App/iOS`
  — Info.plist and entitlements
- `project.yml` — XcodeGen project; `Config/` — build settings
- `ci/github-actions-ci.yml` — CI template (copy to `.github/workflows/ci.yml`)
- `replica/` — recon, architecture, parity matrix, build log

## Build

Core (any platform with Swift 5.9+/6):

```bash
make test        # = swift test for BasedCore and BasedBrain
swift build -c release --package-path Packages/BasedBrain   # → based-server
```

Apps (macOS 14+ / iOS 17+, Xcode 16+, `brew install xcodegen`):

```bash
make project     # generates Based.xcodeproj (and app icons via Pillow)
make mac         # or: open Based.xcodeproj and run the Based-macOS / Based-iOS scheme
make ios
```

### iCloud sync

Without an Apple Developer team the app runs local-only. To enable sync:

1. `cp Config/Local.xcconfig.example Config/Local.xcconfig` and fill in
   `DEVELOPMENT_TEAM`, `BASED_BUNDLE_ID`, `BASED_CLOUDKIT_CONTAINER`
   (`iCloud.<bundle id>`), keep `BASED_CLOUD_SYNC = YES` and
   `BASED_ENTITLEMENTS_SUFFIX = -iCloud`.
2. Create the iCloud container in the Developer portal; the schema is created
   on first sync in the development environment (deploy to production before
   shipping).
3. `make project`, run on both devices with the same Apple ID.

### Running local coding agents (Claude Code, Codex, …)

The default macOS build is App-Sandboxed, and a sandboxed app cannot start
`claude`, `codex` or `node` from your home folder. Either run sessions
through `based-server` (see `deploy/`), or build without the sandbox:

```
# Config/Local.xcconfig
BASED_AGENTS_SUFFIX = -Agents
```

then `make project`. This picks `Based-Agents.entitlements` (or
`Based-iCloud-Agents.entitlements` with iCloud). The un-sandboxed build stores
its data in `~/Library/Application Support/Based` instead of the sandbox
container; on first launch it copies the workspace and preferences over from
the old container once (API keys in the Keychain may need to be re-entered).
Settings → Agents & AI → *Agent setup* shows what is found and tests it.

### Importing from Notion

**Through the API (most faithful, includes views and formulas)**

1. Create an internal integration at
   [notion.so/profile/integrations](https://www.notion.so/profile/integrations)
   (capabilities: *Read content*, *Read user information*) and copy its secret.
2. In Notion open each top-level page or database → **••• → Connections** →
   add the integration (subpages and inline databases are included).
3. In Based: **File → Import from Notion…** (⌥⌘I, also in the sidebar's
   *Import* menu, ⌘K and Settings → Import), paste the secret and the page
   links (*Share → Copy link*), or choose *Everything shared*.

Pages, blocks and rows keep their Notion ids, so importing again updates the
existing pages instead of duplicating them (content deleted in Notion moves
to the trash). Files hosted by Notion are copied into Based (their links
expire after an hour). Formulas are translated to Based formulas when every
function is supported, otherwise their values are imported and the original
expression is kept in the property description.

**From an export file (no integration needed)**

Settings → Workspace → Export → **HTML**, include subpages, then
**File → Import File…** (⌘⇧I) in Based and pick the downloaded `.zip` — no
need to unzip. The HTML export keeps colors, toggles, columns, callouts and
database property types; it has no views (one table view is created) and no
formula expressions. *Markdown & CSV* exports work too but lose formatting.

### Keyboard shortcuts (macOS)

| Shortcut | Action |
|---|---|
| ⌘N / ⌥⌘N / ⇧⌘N | New… palette / new page / new AI chat |
| ⌘K, ⌘P | Search (⌘K adds a link when text is selected) |
| ⌘F, ⌘G, ⇧⌘G | Find in page (database: focus search) |
| ⌘J | AI chat panel |
| ⌘T, ⌘W, ⌃Tab, ⌘1–9 | Tabs |
| ⌘[ ⌘], ⇧⌘U, ⌘\ | Back / forward, parent page, sidebar |
| ⇧⌘1 / ⇧⌘2 / ⇧⌘3 | Agents / Inbox / Agent Brain |
| ⇧⌘L | Dark mode |
| ⌥⇧⌘D | Diagnostics & logs |

## Status

**Pass 11 found that the app had not compiled since Pass 8/9** (duplicate
`hasTextSelection`, a `SettingsPage.workspace` redeclaration, main-actor
`Commands` calls). These are fixed, and `ci/typecheck/run.sh` now
type-checks all of `App/Shared` on Linux against signature stubs of SwiftUI,
AppKit, Combine, Charts, WebKit, … (`ci/typecheck/stubs`) plus the real
BasedCore/BasedBrain modules — current result: *typecheck OK*. The stubs
can't prove the code builds with Apple's SDK, so expect a few fixes on the
first Xcode run. Copy `ci/github-actions-ci.yml` to
`.github/workflows/ci.yml` to get macOS + iOS simulator builds on every push.

Honest status of every requirement: [`replica/backlog.md`](replica/backlog.md).

Tests on Linux: `make test` → BasedCore 53, BasedBrain 36 (incl. Notion
API import against a fake API — blocks, databases, views, dashboards with
widgets from other databases, filters, relations, formulas, files, rate
limiting, re-import — HTML export fidelity fixtures, zip import, dashboard
layout ops, number charts, log rotation, Claude Code stream parsing, CLI
session index, transcript parser, local MCP host, RFC 8439
ChaCha20-Poly1305 vector, JSON-RPC framing, Happier store CRUD, chart
aggregation, query cache, fractional index, 50k-row benchmark).

## License

MIT. Clean-room implementation from public Notion help docs; no Notion code or
assets were used.
