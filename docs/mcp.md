# Based MCP server

Based speaks the Model Context Protocol, so Claude Desktop, ChatGPT, Cursor, Claude Code, Codex and any other MCP
client can do in the workspace what the user does in the app — and learn how Based works before they act.

- **Implementation**: `Packages/BasedBrain/Sources/BasedBrain/MCP/MCPServer.swift` (JSON-RPC 2.0, transport-agnostic),
  tools in `Agent/AgentTools.swift`, guide in `MCP/BasedGuide.swift`.
- **Transports**: `based-server --stdio --db …` (one JSON message per line; what desktop clients spawn) and
  Streamable HTTP `POST /mcp` on the server (JSON responses, `Authorization: Bearer <token>`).
  Coding sessions started by Based get `POST /mcp/session/<id>` (session-scoped; adds the `approval` tool).
- **Protocol versions**: 2025-06-18, 2025-03-26, 2024-11-05. `initialize` answers with the client's version when it
  is one of these, otherwise with the newest (2025-06-18); the client decides whether to continue.
- **Explanation for agents** (like Notion's MCP): the `instructions` in `initialize` (short how-to), the resources
  `based://docs/<topic>` and the tool `based_guide` (topics: overview, markdown, databases, agents, safety).
- **Answers are compact**: pages come back as Markdown, lists as one line per item; long lists are paged with
  `limit` / `offset` and end with `… N more (offset: K)`.

Test: in Claude Desktop add the server (`based-server --stdio --db ~/Library/…/based.sqlite`, or the HTTP URL with
token) and ask "Which projects are running and what needs me?".

## Tools

### Pages and content

| Tool | What it does |
|---|---|
| `based_guide` | How Based works, by topic (overview, markdown, databases, agents, safety) |
| `search` | Titles and full text of pages and rows; ids, links, snippets |
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

### Agent brain

| Tool | What it does |
|---|---|
| `about_user` | The user's About page |
| `memory_search` / `memory_save` | Durable memories |
| `list_skills` / `load_skill` / `read_skill_file` | Skills (reusable instructions); also offered as MCP prompts. `load_skill` lists the skill's files, `read_skill_file {skill, path}` returns one exactly |
| `list_connections` | Connected external MCP servers and their tools |

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

## Resources

| URI | Content |
|---|---|
| `brain://about` | About the user |
| `brain://memories` | All memories |
| `based://docs/<topic>` | Guide topics (overview, markdown, databases, agents, safety) |
| `based://page/<id>` | A page as Markdown (template `based://page/{id}`; the first 500 pages are listed) |

## Prompts

Every enabled skill is a prompt (name, description, optional argument `input`).

## Not yet

- Comments and mentions as tools.
- `ask_main_agent` in the app's local MCP host (only the server offers it).
- Server-sent notifications (`listChanged`, resource subscriptions).
