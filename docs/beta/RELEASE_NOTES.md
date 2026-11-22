# Based Notes Beta – release notes

The build workflow puts the **top section** into the update dialog and the release. Keep it short: at most 8 lines,
one line per point (no wrapped lines), each at most 110 characters – a test checks this
(`apps/desktop/test/config.test.mjs`). Details go into the section below it. Newest first; written for testers.

## 0.2.14 – tidier settings

- Settings list is shorter: pages that had nothing to set yet are gone until they do
- View settings of a database open as a short overview; Layout, Properties and Group have their own page
- The view settings no longer grow taller than the window
- Full notes: github.com/elija-7580/Based/blob/beta/docs/beta/RELEASE_NOTES.md
- Like Based? It runs on donations, $3 a month helps: github.com/sponsors/elija-7580

## 0.2.13 – a calmer look

- Databases look like on basednotes.app: quiet tables, tidier board, timeline, calendar, list and gallery
- Page header is calmer: Export and Move to Trash now live in the ••• menu
- Sidebar: no empty Teamspaces section; “New teamspace…” is in the menu next to Private
- HTML blocks use the fonts of your page, and the white strip at their right edge is gone
- Updates: Based now also looks for a new version every few hours while it is open
- Full notes: github.com/elija-7580/Based/blob/beta/docs/beta/RELEASE_NOTES.md
- Like Based? It runs on donations, $3 a month helps: github.com/sponsors/elija-7580

## 0.2.12 – first beta

- Quick Find (⌘K): Enter right after typing opens the match you typed, and Esc always closes it
- Menus stay inside the window, also in small windows, and scroll when they are long
- Restoring a damaged backup now warns first and says how much of it can be read
- Move to Trash shows “Moved to Trash · Undo”, and ⌘Z brings the page back
- New databases start with the cursor in the title; filter row and date picker are tidier
- Also in 0.2: meeting notes, more imports, Connect AI apps, a backup before every update
- Full notes: github.com/elija-7580/Based/blob/beta/docs/beta/RELEASE_NOTES.md
- Like Based? It runs on donations, $3 a month helps: github.com/sponsors/elija-7580

## 0.2 – release candidate

- Based Beta is now called Based Notes Beta; your workspace, backups and settings stay as they are
- Meeting notes: type /meet to record, take timestamped notes and get a transcript made on your Mac
- More imports: Joplin, Roam, Google Keep, Simplenote, ChatGPT and Claude exports, Obsidian canvases
- Connect Claude Code, Claude Desktop or Cursor: Settings → System → Connect AI apps
- Templates, video and audio blocks, a short tour on first start, and a search field in Settings
- Backups to a folder you choose, and a backup before every update
- Full notes: github.com/elija-7580/Based/blob/beta/docs/beta/RELEASE_NOTES.md
- Like Based? It runs on donations, $3 a month helps: github.com/sponsors/elija-7580

## 0.2 – release candidate, in detail

New since the first test build (0.2.2):

- The app is now called **Based Notes Beta** (Based Notes is the official name). Bundle, data folder, backups
  (`Based Beta Backups`), iCloud folder (`Based Beta`) and the `based-beta` command keep their names.
- Meeting notes: type `/meet` to record a meeting, take notes with timestamps and get a transcript made on your Mac.
  Turn it on from the welcome screen or in Settings → Meeting notes (downloads a speech model once, 488 MB).
- Start from a template on the welcome screen: Tasks, Notes, Journal or Wiki. **⌘N** offers them later, too.
- **Home** opens “Welcome to Based” (or your first page) instead of an empty page called Home.
- Video and audio blocks with their own play, pause, seek and mute controls (space, ←/→, M, F).
- Typing on long pages is smoother: a key press redraws only its own block, not the whole page.
- Large workspaces open about twice as fast.
- Export workspace as Markdown now includes the text inside database rows (one .md per row, like Notion), and
  imports back with databases in their place.
- Backups can go to a folder you choose, for example an external drive. If it isn't connected, Based says so and
  makes no backups until it's back.
- Before every update, Based Beta saves a copy of your whole workspace and keeps the last three. If the copy can't
  be saved, the update isn't installed.
- Based Beta installs next to Based Next and keeps its own data, backups and local server.
- The local server (backups, command line) now also runs on Intel Macs.
- Right-click a misspelled word for suggestions.
- Settings only show what works in this beta; Share is hidden until sharing exists.
- Settings are sorted into App, Workspace and System, with a search field above the list. It finds single settings
  (try “dark” or “spell”) and forgives a typo; ↑/↓ and Enter jump to the setting.
- **Font** (System or Based) is now its own setting in Settings → Appearance. **Style → Bold** only makes titles
  larger and headings heavier and no longer changes the font. If you had Bold on, you keep its font.
- After switching the font back, HTML blocks and Mermaid diagrams no longer keep the other font until a restart.
- First start: a short tour in a few steps (**Help → Show Welcome Tour** brings it back), and a guide page
  **Everything in Based** that lists what this beta can do. Based now follows your Mac's light or dark appearance.
- More imports in Settings → Import & export: Joplin, Roam Research, Google Keep, Simplenote, Standard Notes, and
  ChatGPT or Claude data exports (one database row per conversation). Obsidian canvases and Excalidraw drawings
  become boards. The import dialog lists every source with how to export from it.
- Notion: a workspace exported in several parts (`…-Part-1.zip`, `…-Part-2.zip`) can be picked together; relation
  columns in a Notion CSV export come in as relations; percent columns show 25 % instead of 0.25 %.
- Importing the same Notion export (Markdown & CSV) a second time updates the pages already there instead of
  adding a copy of each. HTML files attached to a Notion page come in as HTML blocks, not as empty subpages.
- A date without a time keeps its day, whatever time zone your Mac is in.
- Connect AI apps (Settings → System): copy a ready setup for Claude Code, Claude Desktop or Cursor; they work on
  your pages through Based's local server on your Mac. They can't delete for good or empty the Trash – that stays
  with you in Based.
- Meeting notes: when a call starts (Zoom, Teams, Meet, FaceTime, Slack …), a small window offers to start notes.
  You can turn this off in Settings → Meeting notes. The meeting block always shows whether it is transcribing.
- Restoring a backup brings back the files of that backup and names any that are missing.

Known issues:

- An HTML export brings databases back as tables on pages when you import it again.

In this beta:

- Pages and subpages with icons and covers, the block editor with `/` menu, drag and drop, columns, toggles,
  callouts, code with highlighting, equations, Mermaid diagrams, tables, images, files, bookmarks and embeds
- Databases with table, board, list, gallery, calendar, timeline, chart and form views; filters, sorts, groups,
  formulas, relations, rollups and templates; tested with 100,000 rows
- Quick Find (⌘K), tabs, back and forward, favorites, Library, Trash, page history
- Import from Notion (direct or export .zip), Markdown, HTML, CSV, Obsidian, Logseq, Evernote, Bear, Word, OPML;
  export to Markdown, HTML, PDF and Word
- Report a problem (⇧⌘B) and opt-in crash reports, without page content
- Not in this beta: AI and agents inside Based, graph, real-time editing across devices, iPhone and web

## 0.2.2 – first test build

The list under “In this beta” above.
