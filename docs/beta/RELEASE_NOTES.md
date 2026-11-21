# Based Notes Beta – release notes

The build workflow puts the **top section** into the update dialog and the release. Keep it short: at most 8 lines,
one line per point (no wrapped lines), each at most 110 characters – a test checks this
(`apps/desktop/test/config.test.mjs`). Details go into the section below it. Newest first; written for testers.

## 0.2 – release candidate

- Based Beta is now called Based Notes Beta; your workspace, backups and settings stay as they are
- Meeting notes: type /meet to record, take timestamped notes and get a transcript made on your Mac
- Start from a template: Tasks, Notes, Journal or Wiki
- Video and audio blocks with their own controls
- Backups to a folder you choose, and a backup before every update
- Smoother typing on long pages; spelling suggestions on right-click
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
- Typing on long pages is smoother.
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
- Not in this beta: AI and agents, AI meeting summaries, graph, real-time editing across devices, iPhone and web

## 0.2.2 – first test build

The list under “In this beta” above.
