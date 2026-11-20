# Import aus anderen Apps

Stand 18. 11. 2026 · BSD-563. Einstieg: `prepareImport` in `packages/core/src/interop/notion-import.ts`.
Tests mit Exporten, wie die Apps sie schreiben: `packages/core/test/import-sources.test.ts`,
im Browser: `apps/web/e2e/interop.spec.ts`. Für den großen Notion-Import über die API siehe `notion-import.md`.

## Was gelesen wird

| Quelle | Datei | Wird zu |
|---|---|---|
| Notion, HTML | .zip (auch alle Teile `…-Part-N.zip`), Ordner | Seiten, Datenbanken mit Typen, Farben, Zeilenseiten |
| Notion, Markdown & CSV | .zip, Ordner | Seiten, Datenbanken (Typen aus den Werten geraten), Relationen |
| Obsidian | Vault als Ordner oder .zip | Ordner und Notizen als Seiten, `[[Links]]` als Erwähnungen; Canvas (.canvas) und Excalidraw-Zeichnungen (`….excalidraw.md`, .excalidraw) als Boards (BSD-566) |
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

Nicht lesbar, mit Hinweis im Bericht: OneNote (.one, .onepkg), Pages, verschlüsselte Standard-Notes-Sicherungen.

## Derselbe Notion-Export ein zweites Mal (BSD-32, BSD-611)

Beide Notion-Formate aktualisieren beim zweiten Import an Ort und Stelle statt doppelt anzulegen („Updated N existing
blocks from an earlier import“); in Based geänderte oder hinzugefügte Blöcke bleiben, unverändert Verschwundenes geht
weg (Seiten und Zeilen in den Papierkorb). Grundlage sind stabile IDs aus der Notion-ID im Dateinamen:

- Seite `Titel <32 hex>.html|.md` → die Notion-ID; Datenbank `Titel <32 hex>(_all).csv` bzw. die Tabelle im HTML →
  Container = Notion-ID, Datenbank `derivedID(Container, "database")`, Ansicht `derivedID(Container, "view")`,
  Eigenschaften `derivedID(Datenbank, "property", Name)`, Optionen `derivedID(Datenbank, Name, Wert)`, Zeilen ohne
  eigene Datei `derivedID(Datenbank, "row", Index)` (`importids.ts`, beide Wege gleich).
- Inhaltsblöcke einer Markdown-Seite: `derivedID(Seite, "md-block", Zähler)`; der HTML-Weg nimmt Notions Block-IDs.
- Markdown & CSV: eine Quelle mit mindestens einer solchen Datei geht als Ganzes über `commitImport` (auch ihre Seiten
  ohne Notion-ID, die dann bei jedem Import neu entstehen und die alte, unveränderte Fassung in den Papierkorb legen).
  Gewöhnliche Markdown-Ordner ohne Notion-IDs bleiben wie bisher: jeder Import legt neue Seiten an.
- Erst HTML, dann Markdown & CSV desselben Exports (oder umgekehrt): Seiten, Datenbanken und Zeilen sind dieselben
  Records und werden aktualisiert; die Inhaltsblöcke der Seiten werden ersetzt (andere Block-IDs je Format), lokal
  Geändertes bleibt daneben stehen. Inline-Datenbanken treffen sich nur, wenn Notion im HTML dieselbe ID an die
  Tabelle schreibt wie an die CSV (so in den bisher gesehenen Exporten).
- Ein Markdown-Import von vor BSD-611 (zufällige IDs) wird beim ersten neuen Import noch einmal angelegt; ab dann
  aktualisiert er.

Canvas und Excalidraw im Vault (`interop/board-import.ts`): Textkarten werden Formen mit Markdown, Notiz-Karten
Seitenkarten (echte Links), Bilder und Dateien Datei-Objekte, Gruppen und Excalidraw-Rahmen Rahmen, Kanten und an
zwei Formen gebundene Pfeile Verbindungen, Freihand und lose Linien Tinte. Farben nach dem Farbton auf die Board-Palette
(Gelb → Orange). Einbettungen, Webseiten und Unbekanntes fallen mit Hinweis weg; eine unlesbare Zeichnung wird ein
leeres Board mit Hinweis.

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
