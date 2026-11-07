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

**New (Pass 20):** chat engine/model/effort/permission picker for Claude Code, Codex, Gemini CLI, OpenCode and API
models, with live thinking, tool cards, inline diffs, approval prompts, a working folder, `@` mentions and `/` commands;
inline AI ("space" on an empty line) and a floating formatting toolbar in the editor; syntax-highlighted code; Notion-
style menus, drag handle and drop line; **Sync v2** (server-sequenced, paged, resumable, long poll; see
[`docs/sync-protocol.md`](docs/sync-protocol.md)); faster open (−50 %) and less memory (−45 %); a lossless
workspace archive; and a first **web client** at `based-server /app` ([`docs/platforms.md`](docs/platforms.md)).

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
  slow-operation timing (`Log.measure`), **Copy logs** (one click: a compact
  report with app / system / workspace facts, the previous run, every hang
  with the main thread's **sampled call stack**, breadcrumbs and the latest
  log lines — also in Help → Copy Diagnostic Report and the crash notice)
  and *Export logs…* (report header + all log files) for bug reports.
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

The app builds and runs on the Mac (first user log: macOS 27.2, a 53,086-block Notion import).

**Pass 16** — chat that answers, a protected Agent Brain, your own Home page, back/forward everywhere, HTML:

- **Chat**: with no API key the in-app chat used the small on-device model with the full agent prompt and
  echoed it back. It now uses an API model if you have one, otherwise Claude Code, and the on-device model
  only as a last resort (with a short prompt). Pick the engine under the chat field.
- **Agent Brain** pages can't be deleted; anything of it found in the Trash is restored automatically.
- **Home** opens a page you choose (page ••• → *Set as Home page*, right-click in the sidebar, or Settings);
  the old Home overview is now at the top of **Library**.
- **Back / forward** with mouse buttons 4/5, trackpad swipe, ⌘[ / ⌘] and ⌘← / ⌘→ (outside text); right-click
  the arrows for the history.
- **⌘K** puts the cursor in the search field reliably.
- **HTML**: `/html` and `/mermaid` blocks with live preview; *Export Page as HTML…* (⌥⇧⌘E) and *Export all → HTML*.

**Pass 14** — the first pasted report found a 7-minute launch hang, and the block gutter works like Notion:

- **No Keychain hang at launch** — the report showed `Secrets.get` → `SecItemCopyMatching` waiting 431 s on
  the main thread for the macOS Keychain prompt (locally built copies get a new code signature with each
  build, so macOS asks again for every saved key). Keys stay in the Keychain, but Based now reads them on a
  background queue, without UI, into an in-memory cache; nothing on the main thread waits for the Keychain.
  Keys macOS won't hand out silently show up in Settings → AI as "N saved keys need Keychain permission" with
  *Allow Keychain access…* (one macOS prompt per key — choose "Always Allow") or *Not now*. Signing with
  your Apple development team (`DEVELOPMENT_TEAM` in `Config/Local.xcconfig`) keeps the signature stable,
  so the answer sticks across rebuilds. The session key is only generated once the load finished and no
  existing key is waiting for permission. Diagnostics / the report show the Keychain state.
- **Block gutter like Notion** — one hover region for the whole page instead of one per row: the + and ⋮⋮
  of the block under the pointer stay visible while you move onto them (also for blocks in columns,
  callouts and nested lists); a short grace period stops flicker between blocks; typing hides them.
  **+** on an empty line opens the slash menu there, otherwise adds a line below (⌥-click: above).
  **⋮⋮** click opens the block menu, drag moves the block (or the whole selection): a ghost follows the
  pointer, a blue line shows where it lands — between blocks, indented to nest (move right), outdented
  below a last child (move left), vertical on a block's side for columns; the page auto-scrolls near the
  edges; dropping outside the page cancels. The drag no longer goes through system drag & drop (text views
  swallowed those drops). The geometry is in BasedCore (`BlockGutterGeometry`, tested).
- Launch log splits the open time into store and agent-brain init.

**Pass 13** — diagnostics you can paste:

- **Copy logs** in Help → Diagnostics (menu: report · shown entries · full log files), Help → *Copy Diagnostic
  Report*, a *Copy report* button on the "quit unexpectedly" notice, *Copy line* on log rows and a copy button
  per hang. The report (`DiagnosticReport`) is plain text in sections: facts (version, debug/release, OS,
  CPU, memory, debugger, workspace size), previous run (why it ended, last actions, last log lines), hangs
  (newest first, "in: <first Based frame>", stack), breadcrumbs, log lines without redundant metadata.
- **Hang stacks** — while the main thread is blocked the watchdog suspends it for microseconds, walks its
  frame pointers (`MainThreadSampler`, Mach APIs, debugger-safe, no allocation while suspended) and
  symbolicates + demangles the frames afterwards. A freeze longer than 2 s is written to the log and the crash
  marker immediately, so after a force quit the next launch says "Based froze last time" with the stack.
- **No false crash alarms** — the marker records whether Xcode's debugger was attached; stopping the app
  from Xcode is logged as a notice instead of a "quit unexpectedly" alert.
- **Faster navigation on big workspaces** — the backlink index is built in the background right after the
  workspace opens (it used to scan all blocks on the first page open), Recents / Quick Find / link pickers
  reuse page lists per store revision instead of filtering and sorting every block on each render; the
  workspace open time is logged.

**Pass 12** adds agent orchestration and the Notion map view:

- **Sub-agents** — coding agents start other agents through Based's MCP tools (`spawn_agent`,
  `wait_for_agents`, `agent_sessions`, `read_agent_session`, `message_agent`, `stop_agent`). Sub-agents
  inherit the folder and project, their final answer is reported back to the parent; depth ≤ 3, ≤ 8 running
  per parent. Also from the UI ("New sub-agent…", `/spawn <task>`).
- **Agents screen: Sessions · Board · Canvas** — a Kanban board (group by status / project / agent, drag &
  drop, inline approvals, live activity) and a canvas with one swimlane per project, parent → sub-agent
  trees, animated edges for running agents, zoom / pan, time range, scheduled agents and an inspector.
- **Claude-Code-style console** — welcome box, `/` command popup (`/help`, `/status`, `/cost`, `/clear`,
  `/spawn`, `/agents`, `/board`, `/mode`, `/terminal`, `/stop`; others go to the agent), `@` file mentions
  from the working folder, edit diffs with file line numbers, status line (mode · agent · model · tokens),
  sub-agent chips and parent breadcrumb.
- **Map view** — MapKit pins for rows with a Place property (emoji monograms, selection card, "without a
  location" list, typed addresses geocoded in the background), place search editor, Notion API import of
  map views (`map_by`) and place values.

Pass 11 found that the app had not compiled since Pass 8/9; that is fixed and `bash ci/typecheck/run.sh`
type-checks all of `App/Shared` on Linux against signature stubs of SwiftUI, AppKit, MapKit, CoreLocation,
Charts, WebKit, … (`ci/typecheck/stubs`) plus the real BasedCore/BasedBrain modules — current result:
*typecheck OK*. The stubs can't prove the code builds with Apple's SDK, so expect a few fixes on the first
Xcode run.

**Automatic build (CI):** `ci/github-actions-ci.yml` builds the macOS + iOS apps on GitHub's Mac servers,
runs all tests and the type-check on every push, and publishes the results to the `ci-logs` branch. To turn
it on once: github.com → *Add file → Create new file* → name `.github/workflows/ci.yml` → paste the file →
*Commit* (the agent integration is not allowed to write workflow files).

Honest status of every requirement: [`replica/backlog.md`](replica/backlog.md).

Tests on Linux: `make test` → BasedCore 62, BasedBrain 51 (incl. diagnostic report rendering, Swift
demangling, previous-run log tail, page-list caches, background backlink index, sub-agents end-to-end against a fake
ACP agent, agent graph / board layout, line diffs, console completion, place values and map views, Notion
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
