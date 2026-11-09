import Foundation

/// How Based works, written for AI agents (Notion's MCP does the same: its server instructions and
/// `notion://docs/...` resources teach agents the model before they act). Served as the MCP `instructions`,
/// as `based://docs/<topic>` resources and through the `based_guide` tool, and put into the in-app agent's prompt.
public enum BasedGuide {
    /// Short version: sent with `initialize`, so every connected agent knows the essentials up front.
    public static let instructions = """
    Based is the user's personal workspace, a Notion-like notes app on their Mac: pages made of blocks, \
    databases whose rows are pages with properties, plus the agent brain (memories, skills, about page).

    How to work in Based:
    1. Find before you write: `search` (titles + full text) or `list_pages`; then `read_page` to see current content \
    and, for database rows, their properties. Never guess ids.
    2. Edit surgically: `find_replace` for a passage, `append_markdown` to add, `update_page` for title / icon. \
    Use `replace_page_content` only when the user wants the whole page rewritten — it replaces every block.
    3. Databases: `list_databases` shows ids and property schemas; `query_database` lists rows; `add_row` / \
    `update_row` set properties BY NAME with plain strings (select options are created on demand; dates as \
    YYYY-MM-DD or YYYY-MM-DD/YYYY-MM-DD; relations as row ids). Change the schema with `update_database`, \
    views (filters, sorts, grouping) with `create_view` / `update_view`.
    4. Nothing is deleted for good: `trash_page` moves to Trash, `restore_page` brings it back.
    5. Link pages as [Title](based://page/<id>) — the app, its agents and other apps all open that link. Always \
    give the user links to pages you created or changed.
    6. Durable facts about the user go to `memory_save`; check `memory_search` / `about_user` before asking. \
    Load a skill with `load_skill` before following it; read its scripts and references with `read_skill_file`.

    7. Agents: `list_projects` / `get_project` show what the user works on, `list_runs` / `get_run` what agents \
    did, `inbox` what waits for the user (answer with `resolve_inbox` only when the user said what to answer), \
    `ask_main_agent` hands bigger work to the user's main agent. See `based_guide` topic "agents".

    Content is written as Markdown (see `based_guide` topic "markdown" for the supported blocks, including live \
    HTML / Mermaid blocks, tables, toggles and callouts). Read `based_guide` topic "overview" once if unsure.
    """

    public static let topics: [(name: String, title: String, body: String)] = [
        ("overview", "Based: concepts", """
        # Based — concepts

        - **Page**: a document. Its body is a list of **blocks** (paragraphs, headings, lists, to-dos, toggles, \
        callouts, quotes, code, tables, images, dividers, columns, embedded databases, buttons, sub-pages).
        - **Database**: a collection of rows. Every row is a page (it has a body too) with typed **properties**. \
        A database lives in a page (inline) or is a page itself (full page). Each database has **views** \
        (table, board, list, gallery, calendar, timeline, chart, map, form) with their own filters, sorts and grouping.
        - **Sidebar**: top-level pages (Private, Teamspaces, Favorites). Sub-pages nest under pages.
        - **Trash**: trashed pages stay restorable for 30 days.
        - **Agent brain**: the user's About page, Memories (durable facts) and Skills (reusable instructions).
        - **Ids** are UUIDs. A page link is `based://page/<id>`.

        Typical flows
        - Answer a question → `search` → `read_page` (a few candidates) → answer with links.
        - Add a task → `list_databases` (find the tasks database and its property names) → `add_row`.
        - Restructure a page → `read_page` → `find_replace` / `append_markdown` per section (keeps the rest intact).
        - New database → `create_database` (with properties) → `create_view` for board / calendar views.
        """),
        ("markdown", "Markdown in Based", """
        # Markdown accepted by create_page / append_markdown / replace_page_content / add_row

        - `# H1`, `## H2`, `### H3` headings; paragraphs; `---` divider
        - `- item` bullets, `1. item` numbers, `- [ ] todo` / `- [x] done`; indent two spaces to nest
        - `> quote`; callouts: `> [!NOTE] text` (also TIP, IMPORTANT, WARNING, CAUTION) or `<aside>💡 text</aside>`
        - toggles: `<details><summary>Title</summary>` … nested Markdown … `</details>`
        - tables: GitHub pipe tables (`| a | b |` + `|---|---|`) become simple tables (first row = header)
        - code: fenced blocks with a language. ```html and ```mermaid blocks can be shown live — use `add_html` / \
        `add_mermaid` to append them already in preview mode.
        - images: `![alt](https://…)`; links `[text](url)`; page links `[Title](based://page/<id>)`
        - inline: **bold**, *italic*, ~~strike~~, `code`, $math$; block equations with `$$ … $$`
        - The first `# Heading` of a new page's Markdown is NOT used as its title — pass `title` separately.
        """),
        ("databases", "Databases, properties and views", """
        # Databases

        Property types: title, text, number, select, multiSelect, status, date, person, files, checkbox, url, email, \
        phone, relation, place, formula, rollup, createdTime, createdBy, lastEditedTime, lastEditedBy, uniqueID, button.
        Writable through tools: text, number, select, multiSelect, status, date, checkbox, url, email, phone, relation \
        (formula, rollup and created/edited are computed).

        Values (always by property NAME, case-insensitive):
        - select / status: option name (`"Done"`); new select options are created, status options must exist
        - multiSelect: `["A", "B"]` or `"A, B"`
        - date: `2026-11-07`, `2026-11-07 14:30`, range `2026-11-07/2026-11-10`
        - checkbox: `true` / `false`; number: `42`; relation: array of row ids

        Views: `list_views` shows filters / sorts / grouping. `create_view` and `update_view` take
        - `filters`: `[{"property": "Status", "op": "equals", "value": "Done"}]` — ops: equals, notEquals, contains, \
        notContains, startsWith, endsWith, isEmpty, isNotEmpty, greater, less, greaterOrEqual, lessOrEqual, before, \
        after, onOrBefore, onOrAfter; date values may be relative: today, tomorrow, yesterday, pastWeek, nextWeek, \
        pastMonth, nextMonth
        - `filter_mode`: "and" (default) or "or"
        - `sorts`: `[{"property": "Due", "direction": "ascending"}]`
        - `group_by`: a property name ("" removes grouping)
        Charts: `create_chart` adds a chart view (bar, line, pie …).
        Buttons: `add_button` adds a Notion-style button that creates a row (with preset properties) or opens a page.
        """),
        ("agents", "Projects, runs, inbox and the main agent", """
        # Agents in Based

        - **Project**: one goal with its pages, chats, coding sessions and runs. Its overview page has Status, \
        Next steps and Latest updates. `list_projects` → `get_project` (id or name). `create_project` for a new goal \
        (check the list first), `update_project_status` to post a dated update or change Active / Paused / Done.
        - **Run**: one piece of agent work — a chat turn, a coding session (Claude Code, Codex …), a scheduled agent, \
        a sub-agent of the main agent. Status: Planned, Running, Waiting, Needs you, Done, Failed, Cancelled. \
        `list_runs` filters by status, kind, project and parent; `get_run` shows result, protocol and sub-runs.
        - **Inbox**: what waits for the user — permission requests from coding agents (options such as allow_once, \
        allow_always, reject_once), questions, failed runs. `inbox` lists pending items with their options. \
        `resolve_inbox` answers one; do it only when the user told you the answer. The first answer wins: an item \
        answered on another device stays as it is.
        - **Main agent**: the user's chief of staff. It answers small things itself and hands bigger work to \
        sub-agents on a model that fits the task. `ask_main_agent` gives it a task and returns the run id at once; \
        follow the run with `get_run`. Its result is posted to the project and to the main thread.
        - **Captures**: quick notes, voice-note transcripts and links (`capture`). The "Sort captures" agent files \
        them every night with `list_captures` and `file_capture` (project, new page, task, memory — or asks the user).

        Typical flows
        - "What needs me?" → `inbox` → summarise each item with its options.
        - "How is Publit going?" → `get_project` {"project": "Publit"} → latest updates + running runs.
        - "Have an agent research X for Publit" → `ask_main_agent` {"task": "…", "project": "Publit"} → tell the \
        user the run id; later `get_run`.
        - "Note that I want to try EPUB export" → `capture` {"text": "…"}; it is sorted tonight.

        Lists are paged: `limit` and `offset`; a last line "… N more (offset: K)" means call again with that offset.
        """),
        ("safety", "Working safely", """
        # Working safely in the user's workspace

        - Read before writing; prefer the smallest edit (`find_replace`, `append_markdown`, `update_row`).
        - Don't rewrite pages wholesale unless asked; `replace_page_content` drops embedded databases and comments.
        - Trash instead of deleting; tell the user what you trashed and that it can be restored.
        - Keep the user's language and structure. Don't duplicate content that already exists — link to it.
        - Report what you changed with links: "Added 3 tasks to [Tasks](based://page/…)".
        """),
    ]

    public static func doc(_ topic: String) -> String? {
        topics.first { $0.name == topic.lowercased() }?.body
    }
}
