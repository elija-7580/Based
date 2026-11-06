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
