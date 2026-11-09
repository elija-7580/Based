# Golden Fixtures (ADR 0011)

Eingabe→Ausgabe-Paare der Swift-Kernlogik. Der TypeScript-Kern (`packages/core`) spielt sie ab; ein Modul gilt
erst als portiert, wenn alle seine Fixtures grün sind. **Nicht von Hand ändern** – neu erzeugen:

```bash
cd Packages/BasedCore && swift run based-fixtures      # schreibt ../../fixtures/ (setzt selbst TZ=UTC)
pnpm --filter @based/core test                         # Bericht: "<modul>: x/y grün" bzw. "nicht portiert"
```

Zweimal erzeugen ergibt identische Dateien. Der Swift-Test `FixtureExportTests.committedFixturesAreCurrent`
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

Format: `{"module": "…", "cases": [{"name", "input", "output"}], …Metadaten}`. Fehler als `{"error": "…"}`,
berechnete Werte als `{"t": "<typ>", "v": …}`, Datum wie in Swift (Sekunden seit 2001-01-01).
`*.utc.json` hängt von der Zeitzone ab (Kalendertage, Datumsgruppen, relative Datumsfilter) und gilt für UTC;
die TS-Tests laufen dafür mit `TZ=UTC`.

Echte Daten prüfen (BSD-148): `swift run based-fixtures --records-from <based.sqlite> /tmp/records.jsonl`, dann
`BASED_RECORDS=/tmp/records.jsonl pnpm --filter @based/core test`.

Noch nicht exportiert (eigener Backlog-Eintrag): Property-Umwandlung, Suchindex (SearchEngine), Notion-HTML-Import,
Clipboard-HTML, Undo gegen Remote.
