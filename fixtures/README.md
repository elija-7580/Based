# Golden Fixtures (ADR 0011)

Eingabe→Ausgabe-Paare der Swift-Kernlogik. Der TypeScript-Kern (`packages/core`) spielt sie ab; ein Modul gilt
erst als portiert, wenn alle seine Fixtures grün sind. **Nicht von Hand ändern** – neu erzeugen:

```bash
cd Packages/BasedCore && swift run based-fixtures      # schreibt ../../fixtures/ (setzt selbst TZ=UTC)
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
| search | `search/search.json` | Quick-Find-Index (SearchCorpus): Titel/Inhalt/Zeilen, Faltung (Groß/klein, Umlaute), Filter, alle Sortierungen, Limit. Gleichstand: pageID aufsteigend; Inhalts-Snippet als Kandidatenliste |
| clipboard | `clipboard/clipboard.json`, `clipboard/export.utc.json` | Eingefügtes HTML (Notion, Google Docs, Listen, Farben, Links, Tabellen, Entities) → Blöcke; HTML-Export von Seiten und wieder einlesen |
| undo-remote | `undo-remote/undo-remote.json` | Undo/Redo gegen Remote-Änderungen und -Löschungen (kein Überschreiben, kein Wiederbeleben) |

Format: `{"module": "…", "cases": [{"name", "input", "output"}], …Metadaten}`. Fehler als `{"error": "…"}`,
berechnete Werte als `{"t": "<typ>", "v": …}`, Datum wie in Swift (Sekunden seit 2001-01-01).
`*.utc.json` hängt von der Zeitzone ab (Kalendertage, Datumsgruppen, relative Datumsfilter) und gilt für UTC;
die TS-Tests laufen dafür mit `TZ=UTC`.

Echte Daten prüfen (BSD-148): `swift run based-fixtures --records-from <based.sqlite> /tmp/records.jsonl`, dann
`BASED_RECORDS=/tmp/records.jsonl pnpm --filter @based/core test`.

Noch nicht exportiert: Notion-HTML-Import (ganzer Export-Ordner mit Dateien; kommt mit dem Import-Eintrag in Phase 2).

Hinweis Swift: Bei der Quick-Find-Suche hängt das Inhalts-Snippet und die Reihenfolge bei Gleichstand von der
Dictionary-Reihenfolge ab (nicht stabil). Die Fixtures halten deshalb die Kandidaten fest; der TS-Port nimmt den
ersten passenden Block in Dokumentreihenfolge und sortiert Gleichstände nach pageID.
