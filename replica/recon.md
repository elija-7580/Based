# Recon — Based (native Notion-style notes for macOS + iPhone)

Status: 2026-11-05 · Method: replica-skill (recon → architect → build), clean-room.

## Goal

A native macOS and iPhone app with the note-taking scope of Notion: pages, the
block editor, databases, search, and sync between your own devices. The goal is
the same features. The name, code, design assets and copy are our own.

## Sources used (public only)

- Notion Help Center: keyboard shortcuts, Markdown shortcuts, block types, math
  equations (KaTeX), comments, deleting/restoring, mobile page options.
  - https://www.notion.so/help/keyboard-shortcuts
  - https://www.notion.so/help/writing-and-editing-basics
  - https://www.notion.so/help/customize-and-style-your-content
  - https://www.notion.so/help/math-equations
  - https://www.notion.so/help/comments-mentions-and-reminders
  - https://www.notion.so/help/duplicate-delete-and-restore-content
  - https://www.notion.so/help/workspaces-on-mobile
- Notion public API reference (documents the block, rich-text and property
  model): https://developers.notion.com/reference/block,
  https://developers.notion.com/reference/property-object
- Notion's export format (Markdown & CSV), for the importer (data portability).

## Boundaries (clean-room)

- No Notion code, logo, icons, illustrations, fonts or UI copy. No private APIs.
- **No binary or app reverse engineering of Notion.** Notion's Master
  Subscription Agreement §2.1 forbids reverse engineering (4) and *"access the
  Services for the purpose of building a competitive product or service or
  copying its features or user interface"* (8). Following replica-skill's rule
  ("if your account's terms forbid using it to build a competitor, it says so
  and sticks to public sources"), recon uses public documentation only.
- REA (morluto/rea) was evaluated: it is an MCP for reverse engineering
  binaries, Electron apps and websites. Pointing it at Notion's desktop app would
  break MSA §2.1(4). It stays available for our own builds (for example, to
  inspect Based's app bundle and SQLite store during QA).
- Importing a user's own Notion export is allowed (it's your data).

## Anytype as a base — evaluated, not forked

| Question | Finding | Consequence |
| --- | --- | --- |
| License | anytype-heart / anytype-swift: *Any Source Available License 1.0*. Use only for non-commercial use or "Commercial Use in Allowed Networks"; forks must stay under ASAL. any-sync is MIT. | A fork could never be MIT or sold as a lifetime purchase. |
| Native Mac | anytype-swift is iOS only; Anytype desktop is Electron (anytype-ts). | No native macOS client to start from. |
| Parity gaps | Own audits (Notion → Anytype import, 2026-09-24): views, sorts and filters largely missing. No formulas, no rollups. API can't create views or filters. | Many Notion features would need building in Go *and* Swift anyway. |
| Build | 25k commits, prebuilt Go middleware (gomobile), Xcode-only. | Expensive to change and to run in CI. |

Decision: a new Swift codebase (MIT). We keep Anytype's ideas: local-first, an
object/block/relation model and pluggable sync. any-sync (MIT) stays an option
for a later self-hosted sync transport.

## Honest sizing

Notion's note-taking scope covers hundreds of features. One build pass can
deliver a solid core (editor, pages, databases, search, sync, import/export).
Full parity is a multi-month roadmap. `features.csv` tracks every item, and
`python3 replica-diff/parity.py replica/features.csv` (replica-skill) scores
it.

## Screens

1. Sidebar: workspace menu, Search, New page, Favorites, Private page tree
   (nested, expandable), Trash, Settings, Import.
2. Page: cover, icon, title, (database row properties), backlinks, block editor.
3. Slash menu, block action menu (⋮⋮), turn-into menu, color menu.
4. Inline formatting: bold/italic/underline/strike/code/link/color, mentions.
5. Database: table, board, list, gallery, calendar (timeline later), views,
   filters, sorts, group by, properties, row page (side peek).
6. Quick Find (⌘P / ⌘K), Trash, Settings (appearance, sync, import/export).
7. iPhone: navigation stack, keyboard toolbar (+, Aa, B/I/U/S, indent,
   outdent, undo, redo, dismiss), long-press block menu.

## Flows

- Create a page → type → `/` → pick a block → Markdown shortcuts → nest with Tab.
- Enter splits a block (lists continue), Backspace at the start merges or
  turns the block into text, arrows move between blocks.
- Subpages, links/mentions (`@`, `[[`), backlinks, favorites, trash/restore.
- Database: create (inline/full page) → add properties → add rows → views →
  filter/sort/group → open a row as a page.
- Sync: edit on Mac → appears on iPhone (CloudKit private database).
- Import a Notion export (Markdown & CSV) → export as Markdown.

## Inferred data model (from the public API docs)

- Block: id, type, parent (workspace | block | database), ordered children,
  rich text, type-specific props, created/edited time and user, trash state.
- Rich text: runs with bold, italic, underline, strikethrough, code, color,
  link, mention (page/date/user), inline equation.
- Database (data source): title, ordered property schema (24 types), rows =
  pages whose parent is the database.
- View: type (table/board/list/gallery/calendar/timeline/…), filter tree
  (and/or groups), sorts, group by, visible properties, calculations.
