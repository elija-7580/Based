# Based MCP server

Based speaks the Model Context Protocol, so Claude Desktop, ChatGPT, Cursor, Claude Code, Codex and any other MCP
client can do in the workspace what the user does in the app — and learn how Based works before they act.

- **Implementation**: `legacy/Swift/BasedBrain/Sources/BasedBrain/MCP/MCPServer.swift` (JSON-RPC 2.0, transport-agnostic),
  tools in `Agent/AgentTools.swift`, guide in `MCP/BasedGuide.swift`.
- **TypeScript server** (`apps/server`, BSD-158): official MCP SDK, stdio and `POST /mcp`; so far the page tools
  (`search`, `read_page`, `list_pages`, `create_page`, `append_markdown`, `replace_page_content`, `update_page`,
  `trash_page`, `restore_page`, `list_trash`, `based_guide`) and the page/guide resources. See `docs/server.md`.
- **Transports**: `based-server --stdio --db …` (one JSON message per line; what desktop clients spawn) and
  Streamable HTTP `POST /mcp` on the server (JSON responses, `Authorization: Bearer <token>`).
  Coding sessions started by Based get `POST /mcp/session/<id>` (session-scoped; adds the `approval` tool).
- **Protocol versions**: 2025-06-18, 2025-03-26, 2024-11-05. `initialize` answers with the client's version when it
  is one of these, otherwise with the newest (2025-06-18); the client decides whether to continue.
- **Explanation for agents** (like Notion's MCP): the `instructions` in `initialize` (short how-to), the resources
  `based://docs/<topic>` and the tool `based_guide` (TypeScript server: overview, markdown, brain, safety).
- **Answers are compact**: pages come back as Markdown, lists as one line per item; long lists are paged with
  `limit` / `offset` and end with `… N more (offset: K)`.

**Connect an app (BSD-581):** Settings → System → „Connect AI apps“ shows one dialog with two targets, the same MCP
on both. *This Mac*: the client starts `based mcp` (stdio; the CLI finds the Mac app's local server and its token
itself, so no token lands in the client's config) – Claude Code `claude mcp add --scope user based -- <path>/based mcp`,
Claude Desktop / Cursor `{"mcpServers": {"based": {"command": "<path>/based", "args": ["mcp"]}}}`. *Server* (Based
Cloud or your own based-server): each client gets its own revokable token (`bdo_…`, same list as paired devices),
shown once in the copied setup – Claude Code and Cursor over Streamable HTTP with an `Authorization` header, Claude
Desktop via `based mcp` with `BASED_URL` / `BASED_TOKEN` in `env`. Not yet: read-only tokens (BSD-538), OAuth.

Test: in Claude Desktop add the server (`based-server --stdio --db ~/Library/…/based.sqlite`, or the HTTP URL with
token) and ask "Which projects are running and what needs me?".

## Tools

### Pages and content

| Tool | What it does |
|---|---|
| `based_guide` | How Based works, by topic (overview, markdown, databases, agents, safety) |
| `search` | Titles and full text of pages and rows; ids, links, snippets. With a semantic index (app: on-device; server: `--embeddings`) also by meaning (keyword + vector, Reciprocal Rank Fusion) |
| `read_page` | A page as Markdown, with its properties when it is a database row |
| `list_pages` | Top-level pages or the sub-pages of a page |
| `create_page` | New page from Markdown under a parent (or at the root) |
| `append_markdown` | Append Markdown blocks to a page |
| `replace_page_content` | Replace the whole body (only when the user wants a rewrite) |
| `find_replace` | Replace a passage inside a page's blocks |
| `update_page` | Title, emoji icon, remove cover |
| `move_page` | Move under another page or to the root |
| `duplicate_page` | Copy a page with its content |
| `trash_page` / `restore_page` / `list_trash` | Trash (restorable) |
| `backlinks` | Pages that link to or mention a page |
| `set_favorite` | Add to / remove from Favorites |
| `add_html` | Live HTML block (sandboxed web view) |
| `add_mermaid` | Mermaid diagram block |
| `add_button` | Notion-style button (add a row / open a page) |

### Databases

| Tool | What it does |
|---|---|
| `list_databases` | Databases with ids and property schemas |
| `query_database` | Rows with property values as text |
| `add_row` / `update_row` | Set properties by name with plain strings |
| `create_database` / `update_database` | Create; rename, add / rename / retype / delete properties |
| `list_views` / `create_view` / `update_view` / `delete_view` | Views with filters, sorts, grouping |
| `create_chart` | Chart view (bar, line, pie …) |

### Agent brain (BSD-541)

One call for context, a few tools to keep it. Everything lives in ordinary pages: "About me", the database
"Memories" (one row per fact, with Type and Status) and "Skills".

| Tool | What it does |
|---|---|
| `recall` | Use first. `{query, about?, limit?}` → memories, matching pages and rows with a passage and block id, each hit's neighbours by kind of link, and pages that connect several hits. Whole questions and typos work. `about` (a page id) stays around one page; with an empty query it lists the surroundings |
| `related` | A page's neighbours with ids: database relations (column name, both directions), mentions and backlinks, parent, sub-pages |
| `about_me` | The user's profile ("About me") and their Profile / Preference memories |
| `remember` | `{fact, type?, about?, source?, replaces?, detail?}` – one durable fact per call. `about` links the pages it concerns (they become mentions, so the fact shows up around those pages). The same fact is never stored twice; `replaces` sets the old memory to Superseded; health, money and similar private facts are stored as "To review" and only count once the user sets them to Active |
| `list_skills` / `load_skill` | Skills (reusable instructions) and one skill's full text; also offered as MCP prompts |

How `recall` finds things (`packages/brain/src/recall/`):

1. **Words** – the Quick Find index (typos, word forms, row values), once for the whole query and once per content
   word, so a full sentence still matches. A page counts more the more of the words it contains.
2. **Meaning** – only when the user switched the local embedding model on (`POST /local/brain/model`, see
   `docs/server.md`): the query is embedded and compared with every section of the workspace. Works across languages
   and without a shared word. Without the model the answer ends with "search by meaning is off".
3. **Neighbours** – one step along the links of the best hits. Pages reached from two or more hits are listed under
   "Connected" even when they don't contain the words.

The lists are merged with Reciprocal Rank Fusion. Superseded and "To review" memories never appear, neither as hits
nor as neighbours. Skills are never returned by `recall` (they are instructions, not knowledge).

Not ported from the Swift server: `read_skill_file`, `list_connections`, the resources `brain://about` and
`brain://memories` (use `about_me` and `recall`).

### Projects, runs, inbox, main agent (BSD-58)

| Tool | What it does |
|---|---|
| `list_projects` | Projects with status, goal, folder, counts; filter `status`, paged |
| `get_project` | Goal, status, overview page (Status / Next steps / Latest updates), pages, chats, recent runs |
| `create_project` | New project with overview page; refuses a duplicate name |
| `update_project_status` | Dated entry in "Latest updates", optional status change |
| `list_runs` | Runs (chat, session, schedule, sub-agent, main) by status / kind / project / parent, paged |
| `get_run` | One run: fields, result, protocol, sub-runs |
| `inbox` | What waits for the user, with answer options; `all` includes answered items; paged |
| `resolve_inbox` | Answer an item: an option id for permission requests, free text for questions. First answer wins. Refused on session-scoped endpoints (a coding agent can't approve itself); in-app agents always need an explicit allow rule |
| `ask_main_agent` | Hand a task to the main agent; returns the sub-agent run id at once (server and the app's local `/mcp`, never on session endpoints) |

### Captures (BSD-63)

Quick notes, voice-note transcripts and links land in the Brain database **Captures** (Source, Status New / Transcribed / Filed / Discarded, Captured, Link, Audio, Filed to, Note). The shipped agent **Sort captures** (`daily 23:00`) files them with these tools.

| Tool | What it does |
|---|---|
| `capture` | Keep a thought or link for the user (`text`, `url`, `source`); lands in Captures |
| `list_captures` | Captures waiting to be sorted, oldest first (`all` includes filed / discarded); paged |
| `file_capture` | File one capture: `project` (Latest updates), `new_page` (inside a project), `page` (append to a project page), `task` (the user's Tasks / To-dos / Aufgaben database), `memory`, `ask` (Inbox question with a suggestion), `discard`. Only project pages, the task database and Memories are edited; anything else becomes a question |

### Host tools (server with coding agents)

| Tool | What it does |
|---|---|
| `spawn_agent` / `wait_for_agents` | Start coding sub-agents and wait for them |
| `agent_sessions` / `read_agent_session` / `message_agent` / `stop_agent` | List, read, message and stop coding sessions |
| `approval` | Claude Code permission prompt (only on `/mcp/session/<id>`) |

External tools of connected MCP servers appear as `<connection>__<tool>`.

## Permission rules

Every writing tool (all tools without `readOnlyHint`) checks the main agent's permission rules first (Settings →
Agents & AI, BSD-98), the same way the chat does: tool name `based.<tool>`, the main argument, and the page paths for
`path:` rules. `deny` refuses with the reason; `ask` refuses as well, because an MCP client can't ask the user — the
answer says so. Without rules nothing changes. Reading tools are never affected. (TypeScript server: BSD-221 Teil 3e.)

## Resources

| URI | Content |
|---|---|
| `based://docs/<topic>` | Guide topics (overview, markdown, databases, agents, safety) |
| `based://page/<id>` | A page as Markdown (template `based://page/{id}`; the first 500 pages are listed) |

## Prompts

Every enabled skill is a prompt (name, description, optional argument `input`).

## Not yet

- Comments and mentions as tools.
- `ask_main_agent` in the app's local MCP host (only the server offers it).
- Server-sent notifications (`listChanged`, resource subscriptions).

## Whiteboards (BSD-508)

Agents draw as text – few tokens, no browser. Based lays the objects out and writes them as records, so an open board
updates at once and sync, history and search apply as for any edit. Since 18.11.2026 an agent can do on a board what
a person can (Elija: „alles, was der Mensch kann – extrem effizient und verlässlich“): colours, exact position and
size, rotation, pinning, layers, freehand ink, images and files, background.

- `read_board { id }` – one line per object: handle, kind, text, `@x,y WxH`, `{style}`; ink strokes one per line
  (up to 80, then a count); connectors as `a -> b: label {style} [handle]`; `background …` when not dots.
- `draw_board { id?, script, title?, parent? }` – without `id` a new board is created. One statement per line:

```
note a: text          box a: text (also oval, diamond)     text a: text
page a: <page id>     image a: <file ref>                  file a: <file ref>
ink a: <SVG path d | x,y x,y …>
a -> b: optional label               frame f: Title { a b }
set <handle>: text    set <handle> {attrs}    del <handle>    background dots|lines|grid|plain
copy <handle> [<handle> …] as c {at=x,y from=<board id>}
```

Attributes go last in braces on create, `set`, `->` and `frame` lines: `{color=green fill=blue at=120,40 size=200x100
rot=15 pin=true z=front}`; `shape=` on shapes, `line=curved|straight|elbow` on connectors, `full=true` on page cards,
`tool=pen|highlighter width=thin|medium|thick|<px>` on ink, `page=N` on PDFs. Colours are the board's names (no
yellow – yellow marks agents). Ink path coordinates are relative to `at=` (`at=0,0` → board coordinates); every `M`
starts a new stroke; M L H V C S Q T A Z. `copy` works like ⌘D (16 px offset) or to `at=`; a frame takes what is
inside with it, connectors between copied objects come along, `from=` copies from another board. Moving a frame with
`set f {at=…}` moves what is inside, as by hand. A wrong line is skipped with its reason, the rest is applied.

- `list_files { query?, limit?, offset? }` – files already in the workspace (page images and attachments, board
  files) with their ref, name, image size or PDF page count.
- `upload_file { name?, data | url | path, mime?, board?, at? }` – stores the bytes (content-addressed, like any
  upload) and returns the ref; with `board` it places the file right away (a PDF becomes one object per page).
  `url`: http or https; up to five redirects are followed, each checked; never into the private network (the
  connection goes to the checked address, so DNS tricks do not help). `path`: only over stdio (the client runs on the
  same computer). Size limit as for uploads (`--max-asset-mb`). PDFs are measured with pdf.js (every page with its
  own size and rotation, at most 200 pages), like dropping a PDF in the app.

Text in notes, shapes and text objects is Markdown (`# heading`, `**bold**`, `*italic*`, `` `code` ``, `- list`,
`- [ ] task`, `> quote`, code fences); write line breaks in a statement as `\n`.

Everything an agent adds carries the marker bar; its connectors are dashed in the marker colour.
