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

## Pass 14 — Keychain launch hang, Notion-style block gutter and dragging

First pasted report (release build, stack sampling on): a **431 s hang at launch** in
`Secrets.get(String)` → `SecItemCopyMatching` → legacy Keychain decrypt (`SecKeychainItemCopyContent` …
`mach_msg`), called from `HappierModel.init` ← `BrainModel.init` ← `AppModel.init` on the main thread —
macOS showing its Keychain permission prompt because every local build has a new code signature. Second
request: the + / ⋮⋮ vanish before the pointer reaches them, blocks can't be dragged — "make blocks behave like
Notion".

- **`Secrets`** (new file `App/Shared/Brain/Secrets.swift`, old enum removed from `BrainModel.swift`): still
  the Keychain (service `com.based.app`), now behind a lock-protected in-memory cache. `startLoading()`
  (first thing in `AppModel.init`) runs on a serial background queue: attribute-only listing (nothing is
  decrypted, no prompt), then one read per account with `SecKeychainSetUserInteractionAllowed(false)`;
  failures become `pending`. `set` updates the cache at once and writes on the queue. `didLoad` (main
  thread) → `BrainModel` reloads providers, starts server sync if it wasn't running, `HappierModel` applies
  the session key and reconnects connections that now have a secret. `ensureSessionKey()` only generates a
  new session key once the load finished and `session.key` isn't pending (a replacement would cut the
  device off from sessions encrypted with the old key). `SecretsStatus` (observable) drives the Settings → AI
  "Keychain" section (*Allow Keychain access…* = interactive reads on the queue, *Not now*), refreshes empty
  key fields when values arrive, and the Diagnostics System tab / report fact "Keychain". iOS reads all items
  in one query. A file-based store was considered and rejected — it would have taken the keys out of the
  Keychain.
- **Gutter** (new file `App/Shared/Views/Blocks/BlockGutter.swift`): `BlockGutterState` per
  `EditorController` (`editor.gutter`). Each `BlockRow` registers the frame of its own line(s) in the
  `BlockCanvas.space` coordinate space (`onGeometryChange`, unobserved dictionary); the page's padded block
  container has one `onContinuousHover`, one overlay (`BlockGutterOverlay`) and the coordinate space — the
  old per-row `.onHover` + negative padding + `.contentShape` combination cut the gutter out of the hit area.
  `BlockGutterGeometry.hoverTarget` (BasedCore) picks the innermost block under the pointer; a gutter wins
  over a block it lies inside (callout / column children) but not over a neighbour column. 220 ms grace
  period, frozen while the menu is open or a drag runs, hidden while typing (`textDidChange`).
  macOS page padding is at least 56 pt (peek 52) so the gutter always fits.
- **+**: empty text line → "/" in place + slash menu; else new line below with "/" (⌥: above).
  **⋮⋮**: one `DragGesture(minimumDistance: 0)` — < 3 pt = click (select, keep a selection it belongs to,
  open `BlockMenuView` popover; ⇧-click toggles selection), more = drag. No `NSItemProvider` / `onDrop` on
  macOS any more (the NSTextViews took the text drops).
- **Drop**: `BlockGutterGeometry.dropTarget(at:blockLeft:rows:)` — rows = rendered blocks minus the dragged
  ones and their descendants (`dropRows`), nearest by vertical distance (gutter counts as inside), upper
  half → before, lower half → after; `blockLeft` = pointer − grab offset: ≥ ¾ indent right of a nestable
  block → first child (line indented), below a block whose children show → first child, left of a last
  child's level → after the parent (repeats up the chain); right edge (last 40 pt) / left edge (first
  12 pt, middle half) → columns (page level or inside a column). Moves via `moveBlocks` / `placeInColumn`,
  moved blocks stay selected, dragged rows dim to 35 %, ghost label (title or "N blocks"), blue 3-pt line,
  auto-scroll at 60 Hz within 48 pt of the scroll view's top / bottom edge (`EnclosingScrollViewReader`
  finds SwiftUI's NSScrollView), far outside the blocks = cancel. iOS keeps the focused-block handle with
  system drag & drop.
- Launch log: "Workspace opened … (store N ms, agent brain N ms)".
- Tests: BasedCore 67 (+5 `BlockGutterGeometryTests`: gutter hover, callout child vs. neighbour column,
  before / after / first child / nest, outdent, columns), BasedBrain 51 — all green; `bash
  ci/typecheck/run.sh` → typecheck OK (stubs: `onContinuousHover(coordinateSpace: some
  CoordinateSpaceProtocol)`, `SecKeychainSetUserInteractionAllowed`).

## Pass 15 — sidebar, page management, Trash, Library

Scope: sidebar, page tree, page CRUD, Trash, new Library view. Page rendering (cover, title, blocks) untouched.

- **Data model** (back-compatible, no migration): `Workspace.teamspaces: [Teamspace]?`, `BlockProps.teamspace`
  (top-level pages; nil = Private).
- **BasedCore `PageManagement.swift`**: `PageDestination`, `PageDropZone`, `SidebarSectionID`; teamspace CRUD
  (delete moves pages to Private), `createTopLevelPage(in:)`, `trashPages` (one undo step, nested ids skipped),
  `restorePages` (orphans → top level), `trashedDescendantPages`, `movePages` (one transaction, cycle-safe,
  section-aware), `dropPages`, `duplicatePages`, `renamePage`, `setFavorite`. `moveBlocks` now shares
  `planMove`. `topLevelPages()` de-duplicates by id.
- **BasedCore `LibraryOps.swift`**: `libraryItems`, `filterLibrary` (text, type, location, edited/created
  ranges, same-title, sort), `childIndexDuplicates`, `duplicateTitleReport` (cause per group).
- **App**: sidebar rebuilt (28-pt rows, 14-pt text, 16-pt icons, Favorites / Teamspaces / Private / Chats,
  section-scoped row ids, persisted expansion, inline rename, "…"/"+" on hover, drop on rows / Private header
  / teamspace rows, pinned footer Library · Trash · Settings, tooltip for look-alike titles); context menu
  (Favorites, Duplicate, Rename, Move to…, Copy link, Open in new tab, side peek, add inside, export, Delete;
  bulk variant); toast with Undo; new `TrashView` (search, Restore, Delete permanently + confirmation, Empty
  Trash, "N pages inside"); `MovePicker` (Private, teamspaces, pages, search); `LibraryView` with
  multi-select (click, ⇧/⌘-click, ⌘A, Esc, ⌫), action bar and bulk Move / Duplicate / Favorite / Export / Delete.
- Root cause of duplicate entries: `replica/sidebar-duplicates.md`.
- Also: `HappierRuntime.swift` line 178 used the local `brain` before its declaration (Swift 6.2 error) →
  `self.brain`; `ci/typecheck/run.sh` also searches `.build/debug/Modules` (Swift 6.2 layout).
- Tests: BasedCore `PageManagementTests` (Swift Testing, 12, green on Linux, Swift 6.2). The XCTest suites
  compile but cannot run on the Linux toolchain (main-actor test classes). `bash ci/typecheck/run.sh` →
  typecheck OK. `App/UITests/SidebarLibraryUITests.swift` (screenshots + delete/undo/restore/delete-forever,
  move one / several, drag-nest) — written, not run (needs a Mac).

## Pass 16 — chat engine, protected Agent Brain, Home, back/forward, ⌘K focus, HTML

Scope: feedback round ("chat answers nonsense", "Agent Brain page in Trash", back/forward everywhere, choose Home,
⌘K focus, HTML still missing).

- **Chat answered with echoes** ("Based: Page 42e9…: "Getting Started" - clear steps."): with no API key the
  app registered Apple Intelligence as the only provider, so `hasProvider` was true and Claude Code was never
  used. The on-device model then got the full tool-agent prompt (about, memories, skill list, 15 tool specs it
  can't call), the history as one "USER: … ASSISTANT: …" blob and the page **id** — it echoed the context.
  Fix: `ModelRegistry.byChatPreference` / `resolve("")` put on-device last; `BrainModel.resolvedEngine`
  (auto = API model → Claude Code → Apple Intelligence; or the engine picked under the composer, persisted as
  `ai.chatEngine`); `AgentRuntime.runOnDevice` (compact system prompt from `BrainStore.compactContext`, last 6
  turns, no tools); `AppleIntelligenceProvider.split` (history into instructions, only the latest message as
  prompt, capped for the ~4k window). Page context = title (+ id for tool engines, + 1 500 chars of text on
  device) instead of a bare id.
- **Agent Brain protected**: `WorkspaceStore.protectedIDs`; `trashPages`, `trash`, `deleteBlocks`,
  `deleteForever` skip protected ids and pages containing one (`containsProtected`, `protectedAmong`).
  `BrainStore.repair()` (init + dashboard `onAppear`) registers the ids, restores trashed parts (root first),
  moves the root out of a trashed parent, recreates missing databases (`makeMemoriesDB/SkillsDB/AgentsDB`).
  UI: no Delete in page / sidebar menus, no "Delete from Trash" in the banner, toast when blocked.
- **Home**: `Workspace.homePageID` (optional, synced), `setHomePage`, `homePageID` (nil when trashed).
  Home shows that page (`PageScreen`, no extra top bar) or `HomeChooser`; "Set as Home page" in the page ••• and
  sidebar menus, Home row context menu, Settings → My settings → Home. The old Home overview is `HomeOverview`
  at the top of Library (foldable, `library.overviewOpen`). `currentPageID` is the Home page while on Home.
- **Back / forward**: `NavigationInput` (macOS local event monitor) — mouse buttons 4/5, swipe, ⌘← / ⌘→ when no
  text view is first responder. `HistoryButtons` (title bar, iOS toolbar) with a history menu on right-click /
  long-press (`backEntries`, `forwardEntries`, `jumpHistory`). ⌘[ / ⌘] unchanged.
- **⌘K focus**: `OverlayFocus.grab` resigns the page's NSTextView, then focuses the field (now + 3 retries);
  used by search and the ⌘N palette. ⌘K only starts link editing when the page editor really is first responder
  (the selection flag could be stale).
- **HTML**: slash commands *HTML* and *Mermaid diagram* (`SlashAction.codeBlock(language:)`); `HTMLExporter`
  (BasedCore): standalone document, Notion-like CSS (light/dark), lists grouped, to-dos, toggles, callouts,
  columns, tables, inline databases as tables, HTML blocks live in `<iframe sandbox="allow-scripts" srcdoc>`,
  Mermaid, MathJax, page links → `Title.html`. File → Export Page as HTML… (⌥⇧⌘E), page / sidebar menus,
  Settings → Export all → HTML.
- Stubs: `NSEvent.buttonNumber`, `deltaX`, `.swipe`, `.otherMouseDown` mask.
- Tests (Swift Testing, run with `swift test --disable-xctest`): BasedCore `Pass16Tests` (5) + `PageManagementTests`
  (12), BasedBrain `Pass16BrainTests` (4) — green on Linux, Swift 6.2. `bash ci/typecheck/run.sh` → typecheck OK.
  The XCTest suites compile but the Linux 6.2 runner aborts while listing them (`Could not cast … @MainActor`
  test methods) — they need a Mac (`make test`).

## Pass 17 — file drops, one Settings, workspace name, cross-block selection, Notes / AI sidebar, tabs, AI glyph

- **Files from Finder** (`App/Shared/Editor/FileDrop.swift`): onto page text (`BasedNSTextView` drag overrides),
  onto the page canvas (`acceptsFileDrops`) and ⌘V of copied files → images / PDF / video / audio become media
  blocks after the block under the pointer, other files file blocks; Markdown, HTML, CSV, `.zip`, folders are
  imported as sub-pages (`AppModel.pendingImport` → RootView's import pipeline, now with a parent). Sidebar drop
  imports at the top level.
- **No floating Settings window**: the SwiftUI `Settings` scene is gone; ⌘, (`CommandGroup(replacing: .appSettings)`)
  and the workspace menu open Settings inside the main window (`AppModel.openSettings`).
- **Workspace name**: the sidebar header was a `Menu` — macOS renders only the label's first text, so it showed
  "M". Now a button + popover (`WorkspaceMenu`): rename in place, icon picker, settings, import, export, sync;
  `WorkspaceBadge` shows the icon or initial. Settings → Workspace saves the name while typing.
- **Selection across paragraphs**: `BasedNSTextView.mouseDown` runs its own tracking loop — text selection inside the
  paragraph, block selection (`EditorController.selectBlockRange(from:toWindowPoint:in:)`, nearest text block by
  window position, outermost blocks only) as soon as the pointer leaves it, with autoscroll. Links, mentions,
  equations, clicks inside a selection, double/triple and modifier clicks keep AppKit's handling.
- **Outline rail** (`PageOutline`): observes edits (was computed once → missing on pages that got headings later),
  shows from one heading, stronger bars.
- **Sidebar Notes | AI** (`SidebarModeSwitcher`, `SidebarMode`, `AppModel.sidebarMode`, `switchSidebar`,
  `lastItem`): Notes = Search, Home, Favorites, Teamspaces, Private; AI = New chat, Agents, Inbox, Agent Brain,
  Chats (40). Each mode remembers its last screen; navigating into the other world switches the sidebar; ⌥⌘\.
- **Tabs**: own `DragGesture` reordering (live, neighbours slide, works in both directions, selects the dragged tab)
  instead of `draggable`/`dropDestination`; `AppModel.moveTab(_:toIndex:)`.
- **AI glyph** (`AIGlyph`, `AISpark`, `SymbolImage`): custom-drawn mark replaces SF `sparkles` in the top bar,
  sidebar, iOS toolbar, chat empty state, search and Autofill.
- Stubs: `NSDraggingInfo`, `NSDragOperation`, drag methods and `autoscroll` on `NSView`, `NSWindow.nextEvent`,
  `ReadingOptionKey.urlReadingFileURLsOnly`. `bash ci/typecheck/run.sh` → typecheck OK.
- Research (two sub-agents): native Swift building blocks and web Claude-UI clones → Notion page
  "Chat-UI-Recherche (Claude-/Claude-Code-Stil)". Recommendation: Textual (or SwiftStreamingMarkdown) for message
  Markdown, HighlightSwift, SwiftMath, Speech framework; UI references opencode (MIT), Clarc (Apache-2.0),
  21st-dev/1code, LibreChat; ACP as the single internal event model.

## Pass 18 — Claude-style chat in Based's look, OpenCode on

- **Event model** (`BasedBrain/Agent/ChatStream.swift`): `ChatEvent` (started, thinking/text deltas, finished blocks,
  tool use / result, result with cost), `ChatPart` (thinking, text, tool, todos; running / done / failed; timing),
  `ChatTurnBuilder` (folds events; streamed blocks are replaced by the finished ones; TodoWrite and
  TaskCreate/TaskUpdate → one to-do list; tool argument summary), `ClaudeChatStream` (Claude Code `stream-json` lines
  → events, sub-agent lines skipped, chunked line splitting), transcript round trip (`transcriptSections`,
  `parts(from:)`).
- **Streaming Claude Code**: `ClaudePrint.stream` runs `claude -p --output-format stream-json --verbose
  --include-partial-messages`, reports events on the main actor, Stop terminates the process.
  `AgentRuntime.onEvent` reports tool calls / results / interim text for API models.
- **Chat UI** (`App/Shared/Brain/ChatParts.swift`): user bubbles with attachment chips; assistant replies as parts —
  "Thinking…" with shimmer → "Thought for N s" (collapsible), tool cards (icon + verb per tool, monospaced argument,
  spinner / check / cross, expandable output; consecutive calls grouped "Used N tools"; browser tools as "Used the
  browser"; Based MCP tools with the AI glyph), to-do card with progress bar and active form, Markdown via Based's
  Markdown importer (headings, lists, to-dos, quotes, code blocks with language + Copy, tables, dividers, links,
  page mentions), copy + "engine · seconds · cost" on hover.
- **Composer**: + attach (file picker) and drop files onto it (text files inline up to 60 KB, others by path),
  mic → macOS system dictation, Stop actually stops, engine picker as before.
- **Saved chats** reopen with thinking, tool cards and to-dos (grouped per assistant turn).
- **OpenCode** enabled by default as a coding agent (`opencode acp`); old untouched disabled entries are upgraded.
- Tests: `ChatStreamTests` (5: stream-json → parts, Task tools, transcript round trip, chunked lines, arguments).
  `bash ci/typecheck/run.sh` → typecheck OK.

## Pass 19 — artifacts panel, browser screenshots in tool cards

- **Artifacts** (`ChatArtifact` in BasedBrain): fenced ```html / ```svg / ```mermaid / ```jsx|tsx blocks of 5+ lines (or
  full documents) become artifacts with a title (`<title>`, `<h1>`, component name, diagram type) and a preview
  document (React 18 + Babel standalone + Tailwind CDN, `export default` component rendered, imports stripped;
  SVG centred). `ChatArtifact.extract` for whole answers.
- **UI** (`App/Shared/Brain/ArtifactViews.swift`): the reply shows an artifact card instead of the code block; click
  opens the panel — full-page chat: resizable panel on the right (`chat.artifactWidth`), opens automatically when a
  reply finishes with an artifact; docked chat: panel replaces the transcript (✕ back). Panel: Preview | Code,
  Copy code, Save as page (new page with a live HTML / Mermaid block), Export as HTML…, Reload.
  `HTMLPreview.document(source:language:)` is shared.
- **Prompting**: Claude Code chat and the API agent are told to answer visual / interactive requests with one
  complete html / svg / mermaid / jsx block.
- **Browser screenshots**: `ChatEvent.toolImage` from image items in Claude Code tool results (browser use,
  computer use, Playwright / Chrome MCP); tool rows keep the latest screenshot visible (`ToolImageStrip`, click to
  enlarge, count badge); at most 4 images per tool kept in memory, not saved to the transcript.
- Tests: `ChatArtifactTests` (extraction, titles, React document, screenshot → card). BasedBrain Swift Testing 11
  green; `bash ci/typecheck/run.sh` → typecheck OK.


## Pass 20 — Feel like Notion / Claude Code, multi-CLI chat, sync v2, faster open (autonomous night run)

Checked in the running app with a debug-only URL driver (`based://debug/...`, `App/Shared/Diagnostics/DebugDriver.swift`)
that renders the window offscreen — screenshots work with a locked screen.

**Editor / pages**
- Title and blocks share one left edge (header used 72 pt, blocks up to 96 pt → blocks sat 24 pt right).
- Cover spans the full page width (was clipped to the 708 pt column); hover shows Change cover · Remove.
- **One main window on macOS**: every `based://` URL opened another window through `WindowGroup`; both shared one
  AppModel but had their own editors, so the active editor, the / menu, focus and the gutter jumped between an
  invisible and the visible page. Now a single `Window` scene.
- ⋮⋮ grip was an SF Symbol that doesn't exist (`circle.grid.2x3.fill`) → nothing to grab. Drawn six dots now.
- / menu: stays open when opened programmatically (caret briefly at 0 closed it), opens below with 160 pt room,
  height fits the room.
- Page ••• → Notion-style panel (search, Ag font tiles, switches, actions). Block ⋮⋮ menu in Notion's order.
- Code blocks: syntax highlighting (`SyntaxHighlighter` in BasedCore, tested).
- Database tables: one-line 34 pt rows, pills clip at the cell edge, imported HTML shown as text.
- ⌘K / ⌘N spring in; sidebar sections fold with a spring.

**AI chat (Claude Code app feel)**
- Engine / model / effort / permission picker (Claude Code, Codex, Gemini CLI, OpenCode, API, on device).
- Codex `exec --json`, Gemini `-o stream-json`, OpenCode `run --format json` streamed into the same parts as
  Claude Code (thinking, text, tool cards, to-dos), sessions resume per engine.
- Inline permission prompts (Claude Code `--permission-prompt-tool` → approval card in the chat).
- Edit / Write diffs in tool cards (+N −M), "N files changed" summary, file names first.
- Animated parts, smooth auto-scroll, centred ↓ button, Claude-style send / stop button.
- Fixed: Inbox details showed the row's properties ("Kind: … Status: …").

**Architecture**
- Workspace open 866 → 487 ms (debug app; release core 800 → 320 ms): parallel JSON decoding, bulk child index.
- **Sync v2**: server-sequenced, paged, resumable; persistent change log (`changes` table) — fixes lost changes
  from devices that were offline and unpushed changes lost on quit. `docs/sync-protocol.md`, `docs/platforms.md`.

Tests: BasedCore + BasedBrain green (new: CLIChatTests, ToolDiffTests, InboxDetailTests, SyncV2Tests,
ChangeLogTests, BulkLoadTests, SyntaxHighlighterTests).

### Pass 20, continued
- **Inline AI** like Notion: space on an empty line → "Ask AI to write…" → preview → Insert / Try again / Discard
  (any engine; the page is context).
- **Formatting toolbar** over text selections: Ask AI · Turn into · B I U S code · link · colour; follows scrolling.
- **Working folder** for coding-agent CLIs in the chat (folder chip, recent folders); a chat keeps its folder.
- **Anthropic API**: Claude 5 models (opus-5-5, sonnet-5-5, haiku-5-5, fable-5-1), adaptive thinking with summaries
  shown as Thinking, thinking blocks replayed unchanged in the tool loop, refusal fallback, effort in the picker.
- **Memory** 302 → 164 MB (`Block.props` copy-on-write, shared when empty); **long pages** open ~4× faster
  (lazy top level from 60 blocks, focus scrolls into view).
- **Sync**: long poll (`/sync/v2/wait`) + debounced push → changes arrive within ~1 s.
- Drag: Notion-blue drop line; to-do checkbox Notion-blue; toggles animate; outline rail below the cover;
  settings navigation Notion-style; composer controls adapt to narrow widths. iOS target builds again.
- **Chat**: `@` mentions (pages, files of the working folder), `/` commands (new, model, folder, ask/edits/plan/bypass,
  effort), Codex reasoning summaries as Thinking.
- **Based archive** (`.based.jsonl`): lossless export/import of the whole workspace; real workspace (71,578 records)
  round-trips in 1.6 s with nothing skipped.
- **Web client v0** at `based-server /app`: page tree and pages over sync v2, live updates (long poll), editing of
  plain text blocks and titles. Verified in a browser against a local server.
- Sidebar Notes | AI switch slides; AI panel springs in.

## Pass 21 — Notion-style databases, ⌘-click tabs, interaction feedback (2026-11-07)
- **⌘-click opens in a new tab** everywhere pages are opened (sidebar, database rows, cards, links via `AppModel.open`);
  ⌘⇧-click opens and switches to it; multi-select in the sidebar moved to ⌘⌥-click (⇧ range unchanged).
- **Resizing**: one `ResizeHandle` for sidebar, side panel, columns and table columns — 12 pt hit area, resize cursor
  on hover, blue line while dragging, drag in global coordinates (no jitter). Table columns: the whole column
  (header, rows, calculation row) follows the drag live.
- **Databases in pages** look like Notion: pill view tabs, thin toolbar icons (filter / sort / search / open as
  full page / settings), blue "New ⌄" split button, lighter grid lines, row hover, select boxes only on hover,
  Notion-blue checkboxes, hover-lift cards. Row titles: click opens the page, hover shows "Open" and a rename
  pencil — rows whose titles filled the cell couldn't be opened before.
- **Outline rail** (right edge): thin rounded lines at low contrast that brighten on hover and morph into the
  heading list after a short delay (like the ChatGPT Mac app).
- **Hover feedback**: `QuietButtonStyle` (hover fill, press state, ≥ 24 pt hit target) for icon buttons across the app;
  favourite star yellow when set.
- **Performance**: `BlockList` observes its own node's `childRevision` instead of the global structure revision, so
  editing one block no longer re-renders every list on the page. Hang watchdog pings every 100 ms, reports from 250 ms.
- `make install` / `scripts/install-mac.sh`: Release build → /Applications, removes old Debug/Release builds.

## Pass 23 — Meeting notes and sharing (2026-11-08)
- **Meeting notes** (`/meet`, ⌘N): `.meeting` block with Summary · Notes · Transcript; transcript in 40-segment
  `.transcript` chunks (live updates rewrite one small record). Capture: microphone + Core Audio process tap
  (macOS 14.2+) as separate tracks (Me / Others live), microphone with background audio on iPhone, uploads.
  FluidAudio Parakeet TDT v3 for live (UtteranceChunker pseudo-streaming) and the full-file final pass; pyannote +
  VBx diarization; click-to-play lines and time-stamped notes; context pages / notes feed vocabulary and summary;
  AI summary with `[m:ss]` citations through the configured engine (API key or CLI). Voice profiles (opt-in):
  speaker embeddings matched by cosine similarity, stored only in the device's local meta table.
- **Sharing** (`based-server`): roles Full access / Can edit / Can comment / Can view, inherited down the page tree;
  access links, invites with device tokens, publish to web (server-rendered); secrets stored hashed; snapshot, pull
  and push filtered and checked per principal (pages moved out arrive as deletions with their content); web client
  shows only shared roots and is read-only where the role says so; Share panel in the app; Universal Links.
- Fix: `PageGraph` mention edges depended on dictionary order (a page's own owner was reused for its content).
- Tests: MeetingTests, VoiceProfileTests, ShareTests; end-to-end against a running server (links, roles, invite,
  revoke, publish, push rejection, move-out). Linux tests need Swift 6.4 (6.0–6.2 crash on `@MainActor` XCTest).

## Pass 24 — Nachtlauf 2026-11-08/09 (Schicht A + B)
- 55+ Commits BSD-14 … BSD-120 (siehe replica/backlog.md, Abschnitt „Nachtlauf 2026-11-08/09“, und Notion „Based Backlog“).
- Testnetz: alle XCTest-Suiten auf Swift Testing; `swift test` läuft unter Linux/Swift 6.2 ohne `--disable-xctest` (BasedCore 46 → 252, BasedBrain 32 → 330).
- Typecheck: 52 → 0 Fehler (`bash ci/typecheck/run.sh`).
- based.sqlite Format v3 (Schema-Version + Migrationsliste, Backup vor Migration).
- Server: Routen in `Packages/BasedBrain/Sources/BasedBrain/Server/` (Router mit Auth-Middleware, owner-only als Default).
- Nicht auf GitHub gepusht (Repo in der geplanten Sitzung nicht freigegeben); Patch-Serie im Notion-Abschnitt „Pass 24“.
- Nachtrag 09.11.: am Vormittag per Fast-Forward nach GitHub-main eingespielt (04dc255 → c65b2fe).

## Pass 25 — Lauf 2026-11-09 (Hauptlauf + Schicht A + B, tagsüber)
- 47 Commits c65b2fe → 5bbac62 (BSD-42 … BSD-144, siehe replica/backlog.md „Lauf 2026-11-09“ und Notion „Based Backlog“).
- P0 BSD-135 (Hänger beim Start auf dem Mac): App-body hing an @AppStorage (MenuBarExtra isInserted) und baute bei jeder Neuauswertung den ganzen Fensterinhalt neu → `MainWindowRoot`; HappierModel.refresh schrieb synchron im Store-Observer, `ensureColumn` verglich Namen exakt → endlose „Goal 2, 3 …“-Rekursion; beides behoben.
- Typecheck jetzt dreifach: macOS, `--ios` (UIKit-Stub, BSD-95), `run-watch.sh` (BSD-66); je 0 Fehler.
- Tests (sauberer Build): BasedCore 252 → 322, BasedBrain 330 → 408.
- Neue Xcode-Targets in project.yml (Watch-App + Complication, Share Extension, Widgets) und ein Post-Build-Skript für die `based`-CLI (BSD-118): unter Linux nur YAML geprüft, xcodegen/Xcode-Build am Mac offen.

## Pass 30 — Based Next: Parität mit der Swift-App im Design „Based Default“ (10.11.2026)
- Astryx (PR #5) war schon in main; Gate auf 2b51665 grün (38 E2E).
- Paritäts-Audit: Spalte `ts` in `replica/features.csv` für alle 221 Zeilen; 28 neue Backlog-Einträge (BSD-201 … 228), 16 Einträge der Phasen 2–4 von „Blockiert“ auf „Bereit“.
- Welle 1 (sechs Agents, Worktrees `run/*`): Astryx-Theme „Based Default“ aus den Tokens + Einstellungen aus Astryx (17 Seiten, Registry) + Bold-Schriften lokal; Datumsfilter-Zeitraum, Side/Center Peek, Form-View, Map-View offline; Markdown einfügen, @/[[-Erwähnungen, Backlinks, Outline, Synced Blocks; Library, Teamspaces, HTML/PDF-Export, Anhänge beim Import, Graph auf echten Daten; BSD-179, BSD-78 (Dateien über Sync); BSD-159/77/74 (`packages/brain`, Chat-UI).
- Welle 2 (`run2/*`): BSD-195/196/160 (Aufträge, Plan per Schema, Runs/Projekte/Rechte/Budget), BSD-198/199/163 (Skill-Router, Redact-Regeln, Agent Brain), BSD-161 (Sandbox, CLI `based`) + Teilen/Publish to web, Meeting Notes (`/meet` ohne Transkription), Startseite nach Mockup v10 (BSD-162/197/133).
- Beim Zusammenführen: zwei Asset-Speicher (Import: IndexedDB/Record-ID, Sync: OPFS/SHA-256) laufen über den Store-Worker; IndexedDB-Schreiben wartet jetzt auf das Transaktionsende (importierte Bilder fehlten gelegentlich).
- Tests am Ende: core 1479, brain 309, web 91, server 63, cli 10 u. a.; E2E 138 in Chromium + WebKit.
