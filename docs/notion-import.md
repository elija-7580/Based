# Notion-Import für große Workspaces (Hybrid: ZIP + API)

Stand 11. 11. 2026 · BSD-317. Code: `packages/core/src/interop/notion-hybrid/`, Tests:
`packages/core/test/notion-hybrid.test.ts`, Benchmark: `packages/core/test/notion-hybrid-bench.test.ts`,
Oberfläche: `apps/web/src/components/NotionHybrid.tsx`, E2E: `apps/web/e2e/notion-hybrid.spec.ts`.

## Warum

Der reine API-Import braucht je Seite mindestens eine Anfrage `blocks/{id}/children` (und eine je verschachteltem
Block). Bei ~3 Anfragen/s sind 20.000 Seiten 3–8 Stunden. Der HTML-Export von Notion enthält denselben Inhalt als
Dateien – ohne Ratenlimit. Was dem Export fehlt, hat die API: Hierarchie, Eigenschaftstypen, Relationen, Ansichten
(Filter, Sortierung, Reihenfolge), Nutzer.

## Ablauf

1. **Struktur (API, Minuten).** Suche über alles Geteilte, je Datenbank Schema, Ansichten und Zeilen. Kein
   `blocks/children`. Die Hierarchie kommt aus dem `parent` jedes Objekts; liegt eine Seite in einem Block
   (Toggle, Spalte), sagt der Ordner im Export, zu welcher Seite sie gehört. Geschrieben wird in einem Schritt:
   Seitenleiste, Datenbanken, Ansichten, Zeilenwerte. Jede Seite merkt sich an sich selbst:
   `importPending` (`zip` | `api`), `notionEdited`, `notionParent`.
2. **Inhalt (ZIP, im Hintergrund).** Zuletzt bearbeitete Seiten zuerst; eine geöffnete Seite wird vorgezogen.
   Die Datei einer Seite wird über die Notion-ID im Dateinamen gefunden, flach gelesen (Unterseiten und
   Datenbanken sind nur Platzhalter an ihrer Stelle) und eingesetzt. Bis dahin ist die Seite gesperrt.
3. **Nachholen (API, gezielt).** Seiten, die im Export fehlen oder um den Export herum in Notion geändert wurden,
   kommen einzeln über `blocks/children` – jede steht im Bericht.

Fortsetzen: die Warteschlange ist die Menge der Seiten mit `importPending`. Nach einem Neustart ist sie wieder da;
ein kleiner lokaler Stand (`HybridImportState`) hält nur Phase, Zeitmarke und Bericht. Das ZIP muss dafür neu
gewählt werden (der Browser behält keine Dateirechte). Ein abgebrochener Struktur-Lauf beginnt neu, weil er erst
am Ende schreibt.

Delta: „Update from Notion“ sucht absteigend nach `last_edited_time` bis zur Zeitmarke des letzten Laufs, liest
für betroffene Datenbanken Schema und Ansichten neu und nur die geänderten Zeilen, und holt den Inhalt geänderter
Seiten über die API.

## Regeln

- Was in Based geändert wurde, gewinnt. Eine in beiden geänderte Seite bleibt unangetastet und steht als Konflikt
  im Bericht.
- Nichts wird gelöscht, weil es in Notion fehlt; ein voller Lauf meldet es. In Based Gelöschtes bleibt gelöscht.
- Abweichungen zwischen ZIP, API und Based werden nie still verworfen: `missingInZip`, `editedAfterExport`,
  `onlyInZip`, `titleDiffers`, `conflict`, `unmatchedDatabase`, `danglingRelation`, `deletedInNotion`,
  `unreadable`. Der Dialog zeigt je Art eine Zeile, „Copy report“ alle einzeln (ohne Token, ohne Inhalt).
- Nur der HTML-Export. „Markdown & CSV“ wird mit Erklärung abgelehnt (dafür bleibt der gewöhnliche ZIP-Import).
- Netz- und Serverfehler brechen einen Lauf ab, statt ein lückenhaftes Ergebnis zu schreiben; „Continue“ macht
  weiter. „Nicht gefunden / nicht geteilt“ ist eine Warnung.
- ZIP-Zeiten tragen keine Zeitzone. Als „nach dem Export geändert“ gilt deshalb alles, was später als 14 h vor
  der jüngsten Datei im ZIP bearbeitet wurde – lieber eine Seite zu viel über die API als ein veralteter Stand.
- Der reine API-Import (ohne ZIP) ist unverändert der Rückfall.

## Laufzeit

Benchmark mit 20.000 simulierten Seiten (16.000 Zeilen in 40 Datenbanken, 4.000 Seiten im Baum):
722 Anfragen für die Struktur, das sind rund 4 Minuten bei 3 Anfragen/s; der Inhalt aus dem ZIP braucht Sekunden
Rechenzeit und keine Anfrage. Der reine API-Import bräuchte dafür mindestens ~24.700 Anfragen (über 2 Stunden).
Die Attrappe hat kleine Seiten ohne Dateien; ein echter Export ist größer, und Seiten, die nach dem Export
geändert wurden, kosten je mindestens eine Anfrage. `BASED_HYBRID_BENCH_PAGES` stellt die Größe ein.

## Bekannte Grenzen

- Die Reihenfolge von Unterseiten ist bis zum Laden des Elterninhalts vorläufig (nach Erstellzeit).
- Die Reihenfolge der obersten Seiten kennt weder die API noch der Dateiname; sie kommen in Suchreihenfolge.
- In Notion Gelöschtes erkennt nur ein voller Lauf, nicht der Delta-Abgleich.
- Dateien aus Datei-Eigenschaften, Icons und Covers lädt der Struktur-Lauf über die API (signierte URLs laufen
  nach einer Stunde ab). Bei sehr vielen solchen Dateien verlängert das den ersten Schritt.
