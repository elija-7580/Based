# Golden Fixtures (ADR 0011)

Eingabe→Ausgabe-Paare der Swift-Kernlogik. Der TypeScript-Kern (`packages/core`) spielt sie ab; ein Modul gilt
erst als portiert, wenn alle seine Fixtures grün sind. **Nicht von Hand ändern** – neu erzeugen:

```bash
cd legacy/Swift/BasedCore && swift run based-fixtures      # schreibt ../../../fixtures/ (setzt selbst TZ=UTC)
pnpm --filter @based/core test                         # Bericht: "<modul>: x/y grün" bzw. "nicht portiert"
```

Zweimal erzeugen ergibt identische Dateien. Erzeugt wird unter Linux; Fälle, deren Ergebnis von der libm der Plattform abhängt (z. B. `cbrt(27)` = 3.0000000000000004 unter Linux), werden gerundet, damit sie dem Verhalten auf dem Mac entsprechen. Der Swift-Test `FixtureExportTests.committedFixturesAreCurrent`
schlägt fehl, wenn die eingecheckten Dateien nicht mehr zum Swift-Code passen.

| Modul | Datei | Inhalt |
|---|---|---|
| records | `records/corpus.jsonl`, `records/schema.json` | Records jedes Typs inkl. Zukunftsfälle (byte-gleicher Roundtrip); bekannte Schlüssel und Enum-Werte (Drift-Check, BSD-148) |
| hlc | `hlc/hlc.json` | Stamp-Ordnung, Textform/Parsen, StampClock-Folgen (`now`/`observe` mit fester Wanduhr, Drift-Grenze, Zähler-Überlauf) |
| sortkeys | `sortkeys/sortkeys.json` | `FractionalIndex.between`/`keys`/`isValid`, Altbestand-Schlüssel, 300 Zufallseinfügungen (Seed) |
| formulas | `formulas/formulas.json`, `formulas.utc.json` | ~140 Formeln (Operatoren, Text, Zahlen, Listen, let, Datum, Fehlermeldungen) mit festen Properties und `now` |
| queries | `queries/queries.utc.json` | Filter (alle Operatoren, verschachtelt, unbekannt), Sortierung je Property, Gruppen (inkl. Datumsgruppen, versteckt/Reihenfolge), Suche in Ansichten |
| values | `queries/values.utc.json` | Berechnete Werte jeder Zeile (Formeln, Relationen, Rollups) und alle Spalten-Berechnungen |
| merge | `merge/merge.json` | Last-Writer-Wins, Tombstones mit/ohne Stempel, kein Wiederbeleben, Batches |
| conversion | `conversion/conversion.utc.json` | Property-Typwechsel jeder Aufgaben-Property in jeden Zieltyp (Schema, Werte, verlorene Zellen); neue IDs als `new:<Name>` / `group:<Name>` |
| search | `search/search.json`, `search/fulltext.json` | Quick-Find-Index (SearchCorpus): Titel/Inhalt/Zeilen, Faltung (Groß/klein, Umlaute), Filter, alle Sortierungen, Limit. Gleichstand: pageID aufsteigend; Inhalts-Snippet als Kandidatenliste, Zeilen-Snippet über Werte nach Property-ID. `fulltext`: Volltext-Fälle aus SearchCorpusTests (Erwähnungen, Toggle, Zellen, Unterschrift, Transkript, Papierkorb, Vorlagen, Datenbanken) × Filter × Sortierung und inkrementelle Schritte (Remote-Records, danach suchen; der TS-Index folgt über `store.observe`) |
| clipboard | `clipboard/clipboard.json`, `clipboard/export.utc.json` | Eingefügtes HTML (Notion, Google Docs, Listen, Farben, Links, Tabellen, Entities) → Blöcke; HTML-Export von Seiten und wieder einlesen |
| import | `import/notion-html.utc.json`, `import/markdown.utc.json` | Notion-HTML-Export aus NotionHTMLImportTests (Ordner, einzelne Seite, ZIP mit Teil-Archiv, Reimport mit lokalen Änderungen) plus Sonderfälle, allgemeines HTML; Markdown-Parser, Inline-Markdown, CSV, Notion-Markdown/CSV-Export (kanonische IDs); ImportIDs. Ergebnis: Records ohne Stempel, Zeiten ab Laufbeginn = `now`, Asset-IDs = `ImportIDs.derived("asset", name, base64)` |
| notion-api | `import/notion-api.utc.json` | Notion-API-Import (BSD-217) aus NotionAPIImportTests: Routen-Tabelle der Fake-API (inkl. 429, Dateien) → Bericht + Records (voller Import, Dashboard, Karte/Orte, Suche, ungültiges Token, Reimport). Erzeugt in `legacy/Swift/BasedBrain`: `BASED_WRITE_FIXTURES=1 swift test --filter NotionAPIFixtureExport`; ohne die Variable vergleicht derselbe Test die eingecheckte Datei |
| reimport | `import/reimport.json` | Reimport-Schutz (BSD-32) aus ReimportProtectionTests, Inhalts-Fingerabdrücke des Record-Korpus |
| export | `export/export.utc.json` | Markdown-/CSV-/HTML-Export, Workspace-Export (eindeutige Namen, relative Links, Dateien in `assets/`) |
| archive | `archive/archive.json` | Workspace-Archiv v1/v2 schreiben und lesen, Asset-Einträge, ZIP-Pfade, Import mit Herkunft `import` (BSD-26) |
| undo-remote | `undo-remote/undo-remote.json` | Undo/Redo gegen Remote-Änderungen und -Löschungen (kein Überschreiben, kein Wiederbeleben) |
| history | `history/history.json` | Versionsverlauf (BSD-73): Block-Kodierung (`/` maskiert) und 128-Bit-Hash byte-genau, Manifeste/Dedup beim Aufzeichnen, `versionBlocks`, Ausdünnen und Aufräumen, Wiederherstellen samt Undo (nur Fälle, in denen TS bewusst wie Swift bleibt; TS verschiebt zusätzlich statt zu löschen) |
| brain-routing | `brain/routing.json` | Modellwahl (BSD-242/BSD-328, API-Hälfte von `ModelRouter`): Regel-Routen, Modell-Stufen, Low/Auto/High-Wahl, nächste Stufe, Anbieter des Standardmodells, Budget → Low. **Ausnahme:** von Hand aus `ModelRouterTests.swift` übertragen (jeder Fall nennt seine Swift-Zeile), bis BasedBrain einen Fixture-Export hat; abgespielt von `packages/brain/test/fixtures-routing.test.ts`, nicht vom Kern-Runner |

Bewusste Abweichungen (Swift-Fehler, die TS absichtlich nicht nachbildet, z. B. BSD-183) stehen nicht in den
Fixtures, sondern in `packages/core/test/fixtures/deviations.ts` – mit Backlog-Verweis und erwartetem TS-Ergebnis.

Format: `{"module": "…", "cases": [{"name", "input", "output"}], …Metadaten}`. Fehler als `{"error": "…"}`,
berechnete Werte als `{"t": "<typ>", "v": …}`, Datum wie in Swift (Sekunden seit 2001-01-01).
`*.utc.json` hängt von der Zeitzone ab (Kalendertage, Datumsgruppen, relative Datumsfilter) und gilt für UTC;
die TS-Tests laufen dafür mit `TZ=UTC`.

Echte Daten prüfen (BSD-148): `swift run based-fixtures --records-from <based.sqlite> /tmp/records.jsonl`, dann
`BASED_RECORDS=/tmp/records.jsonl pnpm --filter @based/core test`.

Import-Eingaben (`files`) liegen als `{path, text|base64}` im Fixture; der Port legt sie unter `in/` in einen
`ImportFiles`-Baum (der Swift-Generator schreibt sie in einen temporären Ordner `…/in`).

Hinweis Swift: Bei der Quick-Find-Suche hängt das Inhalts-Snippet und die Reihenfolge bei Gleichstand von der
Dictionary-Reihenfolge ab (nicht stabil). Die Fixtures halten deshalb die Kandidaten fest; der TS-Port nimmt den
ersten passenden Block in Dokumentreihenfolge und sortiert Gleichstände nach pageID.
