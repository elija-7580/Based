# Based MCP server

Based speaks the Model Context Protocol, so Claude Desktop, ChatGPT, Cursor, Claude Code, Codex and any other MCP
client can do in the workspace what the user does in the app — and learn how Based works before they act.

- **One tool layer** (docs/agent-parity.md): every tool is built once, in `packages/brain/src/tools/` (`WorkspaceTools`).
  The server (`apps/server/src/mcp.ts`, official MCP SDK) only registers them with name, description and JSON schema
  and passes calls through; Based's own agents (chat in the app, runs on the server) use the same layer. Only
  `upload_file` is built by the server (network, files) and plugged into the same layer. Pure logic lives in
  `packages/core` (`editor/agent.ts`, `whiteboard/agent.ts`). The Swift server in `legacy/` is frozen.
- **Rules that hold for every tool**: arguments are checked against the schema before anything runs, and the answer
  says what would be right; every writing call is one transaction (one undo step, all or nothing, one sync change);
  what an agent writes carries its origin (BSD-522); `undo_last` takes back the caller's last writing call.
- **Transports**: `based-server --stdio --db …` (one JSON message per line; what desktop clients spawn) and
  Streamable HTTP `POST /mcp` on the server (JSON responses, `Authorization: Bearer <token>`).
  Coding sessions started by Based get `POST /mcp/session/<id>` (session-scoped; adds the `approval` tool).
- **Protocol versions**: 2025-06-18, 2025-03-26, 2024-11-05. `initialize` answers with the client's version when it
  is one of these, otherwise with the newest (2025-06-18); the client decides whether to continue.
- **Explanation for agents** (like Notion's MCP): the `instructions` in `initialize` (short how-to), the resources
  `based://docs/<topic>` and the tool `based_guide` (TypeScript server: overview, markdown, brain, safety).
- **Answers are compact**: pages come back as Markdown, lists as one line per item; long lists are paged with
  `limit` / `offset` and end with `… N more (offset: K)`.

Test: in Claude Desktop add the server (`based-server --stdio --db ~/Library/…/based.sqlite`, or the HTTP URL with
token) and ask "Which projects are running and what needs me?".

## Tools

### Pages and content

| Tool | What it does |
|---|---|
| `based_guide` | How Based works, by topic (overview, markdown, brain, safety) |
| `search` | Titles, full text and row values; typos allowed; `within` a page or database, `title_only` |
| `read_page` | A page as Markdown, with its properties when it is a database row |
| `list_pages` | Top-level pages or the sub-pages of `parent` |
| `create_page` | New page from Markdown under `parent` (or at the root) |
| `append_markdown` | Append Markdown blocks to a page |
| `replace_page_content` | Replace the whole body (only when the user wants a rewrite) |
| `find_replace` | Replace a passage inside a page's blocks; an error when the text is not found |
| `update_page` | Title, emoji icon, remove cover |
| `move_page` | Move under another page or to the root |
| `duplicate_page` | Copy a page with its content |
| `trash_page` / `restore_page` / `list_trash` | Trash (restorable); works for database rows too |
| `backlinks` | Pages that link to or mention a page |
| `set_favorite` | Add to / remove from Favorites |
| `undo_last` | Take back your last writing call (exactly that step; what was edited since stays) |

### Blocks (page editor)

What a person does with the handle, the block menu and the slash menu, as text.

- `read_blocks { id, limit?, offset? }` – one line per block: short handle, kind, text, `{style}`; indentation shows
  nesting (list items, toggles, columns). A normal page stays under 2 000 characters.

```
1a2b h2 "Plan"
3c4d text "First paragraph with **bold**."
5e6f cols 2
  7a8b col {ratio=0.6}
    9c0d image "beach.jpg" based-asset:… {width=400 caption="Day one"}
  1e2f col
    3a4b todo [x] "pack"
```

- `edit_blocks { id, script }` – one statement per line, the whole script is one transaction and one undo step. A
  wrong line is skipped with its reason, the others are applied.

```
<kind>: text            <kind> name: text         md: <Markdown, any number of blocks>
set h: new text         set h {attrs}             move h [h…] {after=|before=|in=|left=|right=|page=<id>}
indent h…   outdent h…  dup h…   del h…           check h…   uncheck h…   uncols h
cell h 2,1: text        row h add | del 3         col h add | del 2
```

Kinds: text h1 h2 h3 h4 bullet number todo toggle quote callout code divider equation image video audio file pdf
bookmark embed toc table cols page database board meeting. Place with `{after=h}`, `{before=h}`, `{in=h}`,
`{left=h}`, `{right=h}` (a column beside `h`); without a place a new block follows the previous one. Attributes:
`{color=blue}` / `{bg=blue}`, `{type=h2}` (turn into; also `page`, `equation`), `{toggle}`, `{open=false}`, `{checked}`,
`{icon=💡}`, `{lang=js wrap}`, `{show=code|both|result}` (HTML and Mermaid), `{width=400 align=center caption="…"}`,
`{ratio=0.6}` on a column (`h.1` = first column), `{header=false}` on tables. Media take a file ref (`list_files`,
`upload_file`) or an https URL. The answer lists the handles of named blocks, and the page or database id of new
sub-pages and databases.

### Databases

| Tool | What it does |
|---|---|
| `list_databases` / `database_schema` | Databases with ids, row counts and property schemas; one schema with allowed values |
| `query_database` | Rows with property values as text (dates as YYYY-MM-DD); `search`, `sort`, paged |
| `add_row` / `update_row` | Title and properties by name with plain strings; a new select option is created |
| `create_database` / `update_database` | Create; rename, add / rename / retype / delete properties, add options |
| `list_views` / `create_view` / `update_view` / `delete_view` | Views with filters, sorts, grouping |

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
| `list_projects` / `get_project` | Projects with status, goal and run count (filter `status`); one project by id or name with recent runs |
| `create_project` | New project with overview page; refuses a duplicate name |
| `update_project_status` | Dated entry on the project page, optional status change |
| `list_runs` / `get_run` | Runs newest first (filter `status`); one run with usage, result and sub-runs |
| `inbox` | Runs that wait for the user |
| `resolve_inbox` | Allow or deny the tool call a run asked for; only with the rule `allow based.resolve_inbox` |
| `ask_main_agent` | Hand a task to the main agent; it appears on Home and its run shows up in `list_runs` |

The app's own chat gets the groups pages, blocks, boards, files and databases from the same layer; memories, skills,
runs and approvals it handles through its own hosts (`WorkspaceToolsOptions.groups`).

## Permission rules

Every writing tool (`write` in its definition; MCP shows it as `readOnlyHint: false`, and `destructiveHint` for the
ones that can discard something) checks the main agent's permission rules first (Settings →
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

What a person can do in the app and an agent can't yet is listed in `docs/agent-parity-matrix.md`.

- Only in the frozen Swift server, not in the TypeScript one: `add_button`, `create_chart`, `read_skill_file`,
  `list_connections`, captures (`capture`, `list_captures`, `file_capture`) and the host tools for coding sessions
  (`spawn_agent`, `wait_for_agents`, `agent_sessions`, `read_agent_session`, `message_agent`, `stop_agent`, `approval`).
  HTML and Mermaid blocks are written as code blocks (`code: … {lang=html show=result}`).
- Comments (come with multi-user).
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
