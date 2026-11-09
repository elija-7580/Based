# Based website

Source of the marketing site. The live build sits on the `gh-pages` branch.

- `src/` page bodies, scripts and styles. `python3 build.py` assembles them into `canvas/*.dc.html` (the Claude Design canvas files).
- `src/roadmap.json` is the export of the Notion view "Website-Roadmap" (Based Backlog, properties Roadmap, Roadmap-Titel, Website-Bereich). `python3 sync_roadmap.py` writes it into `roadmap.js`.
- `export/export.py` turns the canvas files into static pages (`dist/`) with `dc-lite.js` (template runtime plus morphdom, MIT). Build `dc-lite.js` by prepending `node_modules/morphdom/dist/morphdom-umd.min.js` to `dc-lite.src.js`.
