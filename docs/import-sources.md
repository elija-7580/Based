# Import aus anderen Apps

Stand 18. 11. 2026 · BSD-563. Einstieg: `prepareImport` in `packages/core/src/interop/notion-import.ts`.
Tests mit Exporten, wie die Apps sie schreiben: `packages/core/test/import-sources.test.ts`,
im Browser: `apps/web/e2e/interop.spec.ts`. Für den großen Notion-Import über die API siehe `notion-import.md`.

## Was gelesen wird

| Quelle | Datei | Wird zu |
|---|---|---|
| Notion, HTML | .zip (auch alle Teile `…-Part-N.zip`), Ordner | Seiten, Datenbanken mit Typen, Farben, Zeilenseiten |
| Notion, Markdown & CSV | .zip, Ordner | Seiten, Datenbanken (Typen aus den Werten geraten), Relationen |
| Obsidian | Vault als Ordner oder .zip | Ordner und Notizen als Seiten, `[[Links]]` als Erwähnungen |
| Logseq | Graph als Ordner oder .zip | wie Obsidian; Journale, Namensräume, Aufgaben-Marken |
| Bear | Markdown, TextBundle, .bear2bk, .textpack | Seiten |
| Evernote | .enex | Datenbank je Notizbuch (Tags, Daten, Quelle) |
| Joplin | .jex (tar) oder RAW-Ordner | Notizbücher und Notizen als Seiten, Dateien, Links zwischen Notizen |
| Roam Research | JSON-Export | Seiten mit Blöcken, Links als Erwähnungen |
| Google Keep | Takeout-.zip | Datenbank (Labels, Daten, angepinnt, archiviert) |
| Simplenote, Standard Notes | Export-.zip bzw. entschlüsselte Sicherung | Datenbank (Tags, Daten) |
| ChatGPT, Claude | Datenexport-.zip (`conversations.json`) | Datenbank, eine Zeile je Unterhaltung; Claude-Projektdokumente als Seiten |
| Markdown, Text | Dateien, Ordner, .zip | Seiten; Ordner werden Seiten |
| Word, OPML, CSV, JSON | .docx, .opml, .csv, .json, .jsonl | Seite, Gliederung, Datenbank |

Nicht lesbar, mit Hinweis im Bericht: OneNote (.one, .onepkg), Pages, Obsidian Canvas, Excalidraw-Zeichnungen,
verschlüsselte Standard-Notes-Sicherungen.

## Wie andere Apps eingebunden sind

`interop/foreign/` erkennt einen Export am Inhalt (nicht am Namen des Archivs) und übersetzt ihn in einen Dateibaum,
den die vorhandenen Importer lesen:

- Liste von Notizen mit Angaben → CSV und je Zeile eine Markdown-Seite (`foreign/table.ts`). Der CSV-Kopf trägt
  dabei den Typ je Spalte und den Pfad der Seite; so wird nichts geraten.
- Verlinkte Notizen in Ordnern → Markdown mit `[[Wikilinks]]` für den Vault-Import (Joplin, Roam).

Eine neue Quelle ist damit eine Datei in `foreign/` plus eine Zeile in `foreign/index.ts` und ein Test mit einem
echten Export.

## Regeln

- Notions Teil-Archive sind ein Export: sie kommen in einen Baum, egal ob in einem äußeren ZIP oder einzeln gewählt.
- Liegt im Notion-HTML-Export neben einer Datenbank ihre CSV, zählt das HTML; die CSV wird nicht noch einmal gelesen.
- In einem Notion-Export sind .txt-Dateien Anhänge. In gewöhnlichen Ordnern sind sie Notizen.
- Ein Ordner ohne eigene Seite wird eine Seite mit seinem Namen. Ordner um Notion-Inhalt herum bleiben durchsichtig.
- Reiner Text (Keep, Simplenote ohne Markdown) wird nicht als Markdown gedeutet.
- Was fehlt oder übersprungen wird, steht im Bericht; nichts fällt still weg.
