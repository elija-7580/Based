# Based

Native, local-first notes for **macOS and iPhone** (iPad runs; watchOS planned):
pages, a block editor, databases and an **Agent Brain** — memories, skills and
scheduled agents that every connected AI (in-app, Claude, ChatGPT, Cursor via
MCP) shares. Synced through your own iCloud and/or your own server. Modeled on
Notion's features and built clean-room from public documentation.

> Prototype. 117 of 158 tracked features are implemented, 24 partially;
> see [`replica/features.csv`](replica/features.csv) for the parity matrix and
> [`replica/build-log.md`](replica/build-log.md) for progress.
> The core package is unit-tested on Linux. The SwiftUI app has been
> type-checked against API stubs only — the first Xcode build may still need
> small fixes (see *Status* below).

## What works

- **Pages**: tree in sidebar, drag & drop, icons (emoji/image), covers, fonts,
  small text, full width, lock, duplicate, move, favorites, trash with restore,
  backlinks, deep links (`based://page/<id>`), Quick Find (⌘P), Home.
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
- **Import / export**: Notion export (Markdown + CSV, with relations and
  nested pages), Markdown files; export page as Markdown, database as CSV.
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
- **Notion API import**: Settings → AI → *Import from Notion*: Memories,
  Skills and About page come over 1:1; any page tree or database by ID.
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
- **UI tests**: `App/UITests` (XCUITest, macOS + iOS) walk sidebar, new page,
  slash menu, Quick Find, ⌘J, Sessions/Inbox, every Settings page and the
  database table; `make uitest`.

Not implemented: comments, sharing/publishing, page history, real-time
multi-user, form/feed/map views, sub-items, HTML/PDF export, find in page,
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

### Importing from Notion

Settings → Workspace → Export → *Markdown & CSV*, include subpages, unzip the
archive, then **File → Import…** (⌘⇧I) in Based and pick the unzipped folder.

## Status

The app has not yet been compiled with Apple's toolchain in this repository
(the agent sandbox is Linux). `App/Shared` type-checks against SwiftUI API
stubs; `App/Shared/Editor/RichTextView.swift` (AppKit/UIKit text views) was
reviewed but not compiled. Expect a handful of fixes on the first Xcode run.
Copy `ci/github-actions-ci.yml` to `.github/workflows/ci.yml` to get macOS +
iOS simulator builds on every push; failures are written to the `ci-logs`
branch so they can be fixed iteratively. Pass 8 (control room, charts, HTML
preview, settings, UI tests) was written without the stub harness (lost in a
sandbox reset) — syntax-checked with `swiftc -parse` and reviewed by hand.

Tests on Linux: `make test` → BasedCore 36, BasedBrain 19 (incl. RFC 8439
ChaCha20-Poly1305 vector, JSON-RPC framing, Happier store CRUD, chart
aggregation, query cache, fractional index, 50k-row benchmark).

## License

MIT. Clean-room implementation from public Notion help docs; no Notion code or
assets were used.
