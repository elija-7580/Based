# Based Beta – release notes

The build workflow puts the top section into the release and the update dialog. Newest first; keep it short and
written for testers.

## 0.2 – release candidate

New since the first test build (0.2.2):

- Start from a template on the welcome screen: Tasks, Notes, Journal or Wiki. **⌘N** offers them later, too.
- **Home** opens “Welcome to Based” (or your first page) instead of an empty page called Home.
- Video and audio blocks with their own play, pause, seek and mute controls (space, ←/→, M, F).
- Typing on long pages is smoother.
- Backups can go to a folder you choose, for example an external drive. If it isn't connected, Based says so and
  makes no backups until it's back.
- Before every update, Based Beta saves a copy of your whole workspace and keeps the last three. If the copy can't
  be saved, the update isn't installed.
- Based Beta installs next to Based Next and keeps its own data, backups and local server.
- The local server (backups, command line) now also runs on Intel Macs.
- Right-click a misspelled word for suggestions.
- Settings only show what works in this beta; Share is hidden until sharing exists.

Known issues:

- Export to Markdown leaves out the text inside database rows (their properties are in the .csv). For a complete
  copy, use **Export workspace… → Based archive**.
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
- Not in this beta: AI and agents, meeting notes, graph, real-time editing across devices, iPhone and web

## 0.2.2 – first test build

The list under “In this beta” above.
