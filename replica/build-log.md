# Build log — Based

- 2026-11-05 · Recon and architecture written; Anytype evaluated (not
  forked, ASAL license + iOS-only client); REA not used against Notion
  (MSA §2.1). Core package scaffolded.
- Pass 2 · BasedCore complete: fractional index, HLC, rich text + marks +
  mentions, blocks, databases (schema, views, filters, sorts, groups,
  calculations), formula lexer/parser/evaluator, query engine, SQLite
  persistence, undo/redo transactions, Markdown/CSV/Notion import-export,
  search, CKSyncEngine transport. 27 tests green on Linux.
- Pass 3 · App layer: AppModel, Theme, EditorController (focus, caret,
  slash/inline menus, selection, keyboard), AttributedBridge, platform text
  views (NSTextView/UITextView, TextKit 1), block views for every block type,
  media blocks (WKWebView embeds, MathJax equations), block menus, pickers
  (icon/cover/page), simple table.
- Pass 4 · Databases UI: table (resize, calculations, groups), board (drag
  between groups), list, gallery, calendar (drag reschedule), timeline;
  filter/sort/group editors, view settings, property config incl. formula
  validation + preview, relation/rollup, cells & editors for all types,
  templates, side/center peek.
- Pass 5 · Shell: sidebar tree (drag & drop, context menus), Home, Quick Find,
  Trash, Settings (sync status, appearance), Notion-export importer with
  security-scoped folders, Markdown/CSV exporters, `based://` URL scheme,
  appearance system/light/dark (⇧⌘L).
- Verification: core `swift test` on Linux; App/Shared type-checked with a
  SwiftUI stub harness (`/data/stubcheck`, not in repo) — zero errors.
  RichTextView.swift reviewed by hand (AppKit/UIKit API signatures checked)
  but never compiled. **First real Xcode build is the next milestone.**
- Pass 6 · Back/forward history (⌘[ ⌘], Mac toolbar buttons).
- Parity: 108 yes / 24 partial / 15 no / 2 skip of 149 tracked features.
- Not done: open-source inspiration (AppFlowy AGPL, AFFiNE MIT, Anytype
  ASAL) was evaluated for architecture only; no code copied (license mix and
  Rust/TS → Swift gap).
- Pass 7 · **Agent Brain + server** (`Packages/BasedBrain`, 8 tests green on
  Linux): JSONValue, AI providers (Anthropic Messages, OpenAI Chat Completions
  incl. Ollama, Apple Intelligence via FoundationModels), AgentTools (15 tools
  over the store, shared by runtime + MCP), AgentRuntime (tool loop), Schedule
  parser (`every 15m`, `daily 07:00`, `weekdays`, `weekly mon`, `monthly`,
  cron) + AgentScheduler with daily token budgets, BrainStore (Agent Brain
  page with Memories/Skills/Agents databases + About page, stored as normal
  records so it syncs), MCPServer (initialize/tools/resources/prompts, stdio +
  Streamable HTTP), dependency-free HTTPServer, SyncServer/ServerSync (pull
  since cursor, push with stale detection, tombstones), NotionAPIImporter
  (pages, databases, brain 1:1), `based-server` executable. Smoke-tested live
  over curl (health, MCP create_page, auth, sync pull, stdio initialize).
- Pass 7 · App: BrainModel (Keychain secrets, providers, chat, local
  scheduler, server sync, Notion import), AIPanel (⌘J), AI settings sections,
  *Autofill with AI* in the property menu, Agent Brain in the sidebar, floating
  PageOutline rail (+ per-page toggle, `PageFormat.hideOutline`), ⌘⇧U parent,
  ⌘\ sidebar. Type-checked against the stub harness: zero errors.
- Deploy: Dockerfile (static release build), docker-compose + Caddy (auto TLS),
  systemd unit, Claude Desktop MCP config, deploy/README.
- Pass 8 · **Happier control room + visualisations + performance** (sandbox
  was reset mid-pass; repo restored from GitHub, SwiftUI stub harness lost):
  `ACP/JSONRPCPeer` (newline JSON-RPC, `ProcessTransport` for child agents),
  `ACP/ACPClient` (initialize → session/new|load → prompt, session/update
  stream, request_permission, fs read/write limited to allowed roots; agent
  catalogue Claude Code / Codex / Gemini / OpenCode / Pi / Cursor),
  `MCP/MCPClient` (stdio + Streamable HTTP, SSE fallback), `Crypto/ChaChaPoly`
  (pure Swift RFC 8439, RFC vector test), `Brain/HappierStore` (Sessions /
  Inbox / Connections databases inside the Agent Brain, encrypted transcript
  blocks), `Agent/HappierRuntime` (ConnectionManager publishes `<slug>__tool`
  specs to the brain + mcpServers to agents; permission → Inbox polling; agent
  switch with transcript hand-off), `based-server` endpoints `/acp/agents`,
  `/sessions…`, `/inbox…`, `/connections…`, flags `--cipher-key --machine
  --no-acp`. App: `HappierModel`, Sessions/Inbox views, New session sheet,
  Connections + Agents settings (catalogue one-click, Keychain secrets, E2E key
  pairing), ⌘J *Run with…*, sidebar Sessions/Inbox with badge.
- Pass 8 · Charts: `ChartConfig`/`ChartData` in core (tests), `ChartLayout`
  with Swift Charts + hover highlight, chart section in view settings. HTML /
  Mermaid preview (`HTMLPreview`, WKWebView sandbox, height auto-report, Code |
  Preview toggle); brain tools `create_chart`, `add_html`, `add_mermaid`.
- Pass 8 · Performance: new `FractionalIndex` (length-prefixed integer part,
  legacy keys still accepted) — the old midpoint keys grew one char every ~6
  appends and made 50k inserts take >7 min; now 1.7 s. In-place `childIndex`
  updates, `QueryCache` (store revision), `RowPager`, LazyVStack table with
  Load more / Load all. Benchmark test asserts <5 s query, <10 ms cached.
- Pass 8 · Notion-style Settings (Account / Workspace sidebar, 15 pages,
  `Prefs` keys; calendar honours “start week on Monday”), export all content
  (Markdown/CSV tree), workspace icon. XCUITest suite + `Based-*-UITests`
  targets in project.yml, accessibility identifiers on sidebar, title, slash
  menu, Quick Find, ⌘J, table header, settings pages, sessions/inbox.
- Tests: BasedCore 36 green, BasedBrain 19 green (Linux). App code parsed
  with `swiftc -parse`; needs the first Xcode build.
- Pass 9 · Feedback round (UI shifted/clipped on open, `+`/`⋮⋮` not
  clickable, stutter, broken zip import, agent UI). Shell rewritten:
  `RootView` (NavigationSplitView 220–400 pt sidebar + `DetailShell`), window
  min 640×420 with `contentMinSize` and default 1240×820 so the restored frame
  can't clip, unified toolbar with back/forward + ⌘J, `navigationTitle` /
  `navigationSubtitle` from the model instead of per-screen toolbars (those
  shifted the layout). New `Sidebar` (Notion order, recent chats, multi-select
  + bulk context menu), `TabStrip` (⌘T/⌘W/⌃Tab/⌘1–9, drag reorder),
  `SearchOverlay` (⌘K/⌘P, Pages/Chats, date buckets, Ask AI, ⌘↵ new tab),
  `CommandPalette` (⌘N), `FindBar` (⌘F/⌘G/⇧⌘G, scroll + select block),
  `ChatPanel` (right panel docked ≥ 680 pt, else floating; resizable;
  `ChatFullPage`), peek prev/next (⌃⇧↑/↓), database row multi-select with
  bulk bar. Block gutter: hover + hit area moved to the row header with a
  reserved 44-pt margin, handle buttons `allowsHitTesting` only when visible,
  size tracking via a reference box instead of `@State` (no re-render per
  layout pass → less stutter).
- Pass 9 · Core: Notion import accepts the downloaded `.zip` (pure-Swift
  `Zip` reader incl. deflate, nested `Part-N.zip`) and HTML exports
  (`HTMLImport` → blocks); `NotionImporter.prepare` runs off the main actor
  with progress. `WorkspaceStore` structure revision (sidebar/backlinks don't
  re-render on every keystroke), cached backlinks. `Log` (levels, categories,
  JSONL rotation 5 × 2 MB, listeners, breadcrumbs, `Log.measure`).
- Pass 9 · Agents: `ShellEnvironment` (login-shell PATH, `which`),
  `AgentDoctor` (probe claude/codex/node/npx, login check, test prompts),
  `ClaudeCodeDriver` (native `claude -p --output-format stream-json`
  sessions with permission modes), `CLISessionIndex` (Claude Code / Codex
  history), `TranscriptParser`, `LocalMCPHost` (Based as MCP server for
  local agents, approval for writes). App: `AgentsScreen`, `SessionConsole`
  (Claude-Code look, inline permission prompt, shift+tab modes, esc),
  `AgentTerminalView` (SwiftTerm, macOS), `CLISessionView` (resume),
  `AgentDoctorView`, `BrainDashboard`. Opt-in un-sandboxed build
  (`BASED_AGENTS_SUFFIX = -Agents`) with one-time data migration from the
  sandbox container.
- Pass 9 · Diagnostics: `AppDiagnostics` (log setup, report header),
  `HangWatchdog` (250 ms ping, > 0.5 s hang with breadcrumbs), `CrashReporter`
  (signal/exception marker → alert on next launch), `LayoutAuditor`
  (`.auditLayout(name)` walks the accessibility tree for overlapping /
  clipped controls), `DiagnosticsView` (log viewer with filters, hangs,
  layout issues, environment; ⌥⇧⌘D), Settings → Diagnostics.
- Pass 9 · Tests: BasedCore 46, BasedBrain 30 green on Linux (zip/HTML
  fixtures, log, stream-json parsing, CLI index, transcript, local MCP host).
  UI tests extended (search, palette, tabs, find, chat panel, gutter buttons,
  agents, brain dashboard, layout overlap/clipping check). App code:
  `swiftc -parse` clean, model/brain/store member references and type names
  cross-checked by script; first Xcode build may still need small fixes.
- Pass 10 · Feedback: "der Import aus Notion ist komplett shit" — should look
  1:1 like Notion incl. databases, ideally via link/API, and keep everything
  from the HTML. Rebuilt the import from scratch:
- Pass 10 · Core: `ImportBuilder` (collects blocks / databases / views with
  stable ids, sort keys, placeholder assets) + `WorkspaceStore.commitImport`
  (one undoable transaction, original created/edited times and authors kept,
  re-import updates records in place, stale children → trash, stale views
  removed). `NotionHTMLImporter` replaces the HTML→Markdown detour: page
  header (icon, cover + position, serif/mono, full width, small text),
  every block type (toggle headings, callout icon + color, columns with
  ratios, tables with header row/column, code language + wrap, equations,
  image width / caption, bookmarks with metadata, embeds, files, link to page
  vs. subpage, TOC, breadcrumb), rich text (marks, text and
  background colors, links, page / user / date mentions, inline equations);
  databases from the export tables with property types, select / status
  colors and groups, number formats, unique-ID prefix, relations resolved by
  row id, created / edited time and people as row metadata, hidden columns;
  anything without a native block stays as an HTML block with live preview.
- Pass 10 · Notion API (`BasedBrain/Import/NotionAPI`): `NotionClient`
  (API 2026-03-11, ~3 req/s, Retry-After / 5xx retries, pagination, signed
  file downloads), `NotionCrawler` (links, ids or everything shared via
  search; pages, block trees, databases → data sources → rows, views + view
  row order via view queries, truncated relation / people lists, related
  databases, users, files — batched with a TaskGroup), `NotionAPIMapper`
  (all block types, colors, mentions, databases with every property type,
  status groups, two-way relations, rollups, formulas translated from
  `{{notion:block_property:…}}` to `prop("…")` when Based supports every
  function, otherwise static values + original expression, unique IDs, files,
  views: table / board / list / gallery / calendar / timeline / chart with
  property order, visibility, widths, wrap, group by (+ hide empty, date
  grouping), card cover / size, nested and/or filters, sorts incl. created /
  edited time; multi-source databases, linked views, databases reachable only
  through relations), `NotionWorkspaceImport` (fetch → map → commit,
  progress, cancel, `verify(token:)`).
- Pass 10 · App: `NotionImportSheet` (File → Import from Notion… ⌥⌘I, sidebar
  Import menu, ⌘K, Settings → Import): integration secret with check (stored
  in the Keychain), sharing instructions, links or "everything shared",
  options (subpages, row content, related databases, copy files), progress,
  cancel, summary, open the result. File import now runs the HTML importer in
  the background and writes in one step; Markdown imports suggest the API /
  HTML route. Settings → AI page import uses the new importer.
- Pass 10 · Tests: BasedCore 50 (HTML export fidelity, re-import in place,
  generic HTML kept, ids), BasedBrain 35 (fake Notion API: full import incl.
  views / filters evaluated by the query engine, live formula + rollup
  values, files, 429 retry, re-import, search mode, link parsing, 401).

## Pass 11 — compile fixes, Notion chrome, dashboards, forms, import diagnostics

- **Compile errors since Pass 8/9 fixed** (duplicate `hasTextSelection` in `EditorCommands`, `SettingsPage`
  static/case clash, `BasedCommands` main-actor calls, `ChatComposer` expression too complex). New
  `ci/typecheck/` harness: preprocesses `App/Shared` (os(macOS) → true, @objc / #selector stripped) and
  type-checks it on Linux against stubs of SwiftUI / AppKit / Combine / Charts / WebKit / AVKit / PDFKit /
  SwiftTerm / MetricKit / Security / UTType and the real packages.
- **Notion window chrome (macOS)**: `.hiddenTitleBar`, `MacShell` replaces `NavigationSplitView` — full-width
  40 pt title bar (traffic lights re-centred, sidebar toggle with hover peek, back / forward, Notion-style
  tabs with a white active tab, "+"), drag / double-click-zoom area; custom `NotionSidebar` (workspace menu
  + new page, Search ⌘K, Home / Chat / Agents / Inbox badge / Agent Brain, foldable Favorites / Private /
  Chats sections, 30 pt rows, icon → chevron on hover, "•••" + "+" on hover, "No pages inside", drag to
  reorder (top / bottom edge) or nest (middle), ⌘ / ⇧-click multi-select, Delete, Esc, auto-reveal of the
  open page, Settings / Import / Trash), resizable 200–480 pt, ⌘\ collapses; `PageTopBar` (breadcrumb
  with icons, "Edited …", Share menu, AI, favourite, •••) and `ScreenTopBar` replace the window toolbar.
  Text column 708 pt with up to 96 pt padding (shrinks in narrow windows), headings semibold.
- **Dashboards**: `ViewType.dashboard`, `DashboardConfig` (rows of ≤ 4 widgets on 12 columns, row heights),
  widget views (`widgetOf`, may show another database, not listed as tabs), store ops (add with defaults,
  add / remove / resize / move widgets, cascade delete, undo), `DashboardLayout` UI (cards, "•••": rename,
  layout, chart type, data source, width, move, duplicate, remove; "+" per row; "Add widget" incl. other
  databases). Notion API: dashboards mapped with their widgets (missing widget views fetched, widget
  databases followed). Charts: `number` kind, caption, colour theme, height presets.
- **Form view**: questions from visible properties, submit adds a row; Notion forms import as forms.
- **Import diagnostics**: API errors name the failed request (`[GET /v1/… , code]`), "Copy diagnostic
  report" (version, options, requests, last failure, warnings — no token / content) and fix hints in the
  import sheet; per-view read failures become warnings.
- `replica/backlog.md`: every requirement with honest status.

## Pass 12 — sub-agents, agent board + canvas, Claude-Code console, map view

- **Sub-agents** (`HappierRuntime`): `spawn(agentID:prompt:title:cwd:project:parentID:)` inherits cwd /
  project, enforces depth (3) and running fan-out (8), posts "Started sub-agent … (session id)" and, when the
  child's turn ends, "Sub-agent … finished (session id): <answer>" into the parent. MCP host tools
  `spawn_agent` (optional `wait`), `wait_for_agents`, `agent_sessions` (children / all), `read_agent_session`,
  `message_agent`, `stop_agent`; session-scoped MCP calls inject `_caller_session`, so the caller is the
  default parent. Native Claude Code gets an orchestration system prompt, ACP agents get it as context.
  Sessions store `Task` and `Result`; `inFlight` tracks turns the runtime starts itself (`onTurn`).
  `based-server` POST /sessions with `parent` spawns. Tests run the whole flow against a python fake ACP agent.
- **Agent graph** (`AgentGraph`): project swimlanes (most recent first), tidy tree layout (subtree widths,
  parent centred), edges (active when the child runs), lane counts, only-active keeps ancestors, cycle-safe;
  board columns by status / project / agent.
- **App**: Agents screen with Sessions · Board · Canvas (`AgentBoard.swift`): board cards with task, parent,
  live activity, result, inline Allow / Deny, drag & drop between columns; canvas with pan / zoom / fit,
  range filter, legend, scheduled agents, animated dashed edges, lane "New session here", inspector with
  approvals, events, result, sub-agents and a message box. Session list shows sub-agents indented.
- **Console** (`SessionConsole`): Claude Code welcome box and tips, `/` command popup with ↑↓ / Tab / Return /
  Esc, local commands (`/help`, `/status`, `/cost`, `/clear`, `/spawn`, `/subagent`, `/agents`, `/board`,
  `/mode`, `/terminal`, `/stop`), `@` file mentions (`ConsoleCompletion.files/rank`), tool headers without
  the doubled name, `DiffBlock` ("Updated path with N additions and M removals", numbered red / green lines,
  collapsible), "Open sub-agent" links in notices, status line, sub-agent chips, parent breadcrumb.
  Diffs come from Claude Code Edit / MultiEdit / Write inputs and ACP `diff` content; `LineDiff` (LCS with
  prefix / suffix trim, unified hunks, real file line numbers via `firstLine(of:inFile:)`).
- **Map view**: `PlaceValue` (JSON or typed text or "lat, lon"), `DatabaseView.mapPropertyID / mapHeight`,
  adding a map view creates a Place property like Notion; `MapLayout` (MapKit markers, selection card, fit,
  "without a location" list, background geocoding saved to the row), `PlaceEditor` (MapKit search), settings
  section; Notion API maps (`map_by`, `height`) and place values import.
- **CI**: `ci/github-actions-ci.yml` gained a Linux job (BasedBrain tests + app type-check); app builds run on
  every push (public repo → free macOS runners). Still needs the one-time manual copy to `.github/workflows/`.
- Type-check stubs: MapKit + CoreLocation. Tests: BasedCore 55, BasedBrain 51 — all green; typecheck OK.

## Pass 13 — Copy logs, hang stacks, faster navigation on big workspaces

Trigger: the first log from the Mac (the app builds and runs: macOS 27.2, 53,086 blocks / 221 databases)
showed "Hang: main thread blocked 524 ms … navigate → Getting Started" and "Previous run ended
unexpectedly" — pasted from the Diagnostics view with a broken layout. Request: a copy-logs button.

- **`DiagnosticReport`** (BasedCore): facts, previous run (summary, crash text, frozen-thread stack, last
  actions, last log lines), hangs (newest first, culprit = first Based frame, ≤ 30 frames), breadcrumbs, log
  lines via `LogEntry.compactLine()` (time only, `breadcrumbs` / `stack` metadata dropped, multi-line
  messages indented). `Log.previousSessionTail` reads the end of `based.log` before this run appends.
- **`MainThreadSampler` / `StackSymbols`** (BasedCore): `prepare()` on the main thread records its Mach port
  and stack bounds; `sample()` (watchdog thread) does `thread_suspend` → `thread_get_state`
  (ARM_THREAD_STATE64 / x86_THREAD_STATE64) → frame-pointer walk into a preallocated buffer (PAC bits
  stripped, async-frame bit masked, bounds-checked) → `thread_resume`; symbolication with `dladdr` and
  `swift_demangle`, `simplify` drops `Swift.` and return types. The Darwin branches were type-checked on
  Linux against hand-written stand-ins for the Mach / dyld declarations (both arm64 and x86_64 paths).
  `DebuggerCheck.isAttached` (sysctl P_TRACED; Linux: TracerPid).
- **HangWatchdog**: 50 ms ticks, ping every 250 ms, samples at 0.3 s and then every second while blocked
  (≤ 5), hang records carry `frames`; log line gets `in=` and `stack=`; ongoing > 2 s logs the stack and
  writes it into the crash marker (`CrashReporter.noteOngoingHang`, cleared when the main thread is back).
- **CrashReporter**: marker records `debugger` and `hang`; `Info.summary` distinguishes crash / frozen then
  killed / stopped from Xcode / no clean shutdown; `pendingNotice` skips the alert for Xcode stops; the info
  stays available after dismissing (reports). iOS foreground re-arms the marker (`resumeMarker`).
- **UI**: Diagnostics top bar *Copy logs* menu (primary action = report; "shown entries" respects level /
  category / search; "full log files"), "Copied N KB" feedback; Hangs tab shows culprit, stack disclosure
  and a copy button; log rows *Copy line* / *Copy message*; System tab shows build type, debugger, sampling;
  Help → *Copy Diagnostic Report*; crash alert *Copy report* and "Based froze last time" title.
- **Performance**: `prepareLinkIndexInBackground()` after opening the workspace (snapshot → detached task →
  install on the main actor, changes made meanwhile re-indexed); synchronous fallback is measured
  (`Log.measure`, warns > 50 ms). `recentPages` / `allPages` cached per store revision; recents sort only
  page candidates and check trashed ancestors lazily. "Workspace opened … in N ms".
- Tests: BasedCore 62 (+7: report sections, empty report, demangle/simplify, sampler safety, previous-run
  tail, page-list cache invalidation, background backlink index with a concurrent change), BasedBrain 51 —
  all green; `bash ci/typecheck/run.sh` → typecheck OK.
