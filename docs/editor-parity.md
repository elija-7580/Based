# Parität alter Editor (BlockNote) ↔ neuer Block-Editor (ADR 0016, E8)

Stand 14.11.2026 (BSD-407 Teil 6). Grundlage: `replica/features.csv`, Bereiche `blocks` und `editor`. „ja“ = im neuen Editor gebaut
und mit E2E (Chromium + WebKit) geprüft, „teils“ = Grundfunktion da, Lücke in der Notiz, „nein“ = fehlt.
E8 (Standard umschalten, BlockNote entfernen) erst, wenn alle `must`/`should` hier „ja“ sind **und** Elija den
neuen Editor auf dem Mac abgenommen hat.

## Blöcke

| Funktion | Prio | Neu | Notiz |
| --- | --- | --- | --- |
| Text, H1–H3, H4 | must | ja | H4 über `#### ` |
| Listen (• / 1. a. i.), To-do, Toggle, Zitat | must | ja | |
| Toggle-Überschriften | should | ja | Slash „Toggle heading 1–3“, Enter am Ende legt das erste Kind an |
| Callout mit Icon und Farbe | must | ja | Icon über Emoji-Picker, Farbe über Blockmenü |
| Trenner | must | ja | |
| Code mit Sprache und Hervorhebung | must | ja | Sprachwahl mit Suche, Hervorhebung über CSS Highlight API; Leiste mit „Wrap code“ (Standard ohne Umbruch wie Notion, BSD-340; `wrap: true` im Record) und „Copy code“ seit Teil 6.2 |
| Block-Gleichung | should | ja | |
| Inline-Gleichung | should | ja | Anlegen („/Inline equation“), Bearbeiten per Klick, leer entfernt, Anzeige mit KaTeX (14.11.) |
| Bild (Upload, Link, Unterschrift) | must | ja | Upload, Einfügen, Ablegen, Breite, Unterschrift; Bild per Link seit 14.11.; Ausrichtung links/Mitte/rechts (`props.align`), Bildleiste (Caption, Ersetzen, Herunterladen, Vollbild), Breite an beiden Rändern seit Teil 6.3 |
| Video, Audio, Datei, PDF | should | ja | Hochladen und Anzeige; PDF mit Vorschau seit 14.11. |
| Web-Bookmark mit Vorschau | should | ja | Link-Feld und Karte; „Fetch preview“ (`fetchLinkPreview`, nur auf Klick) seit 14.11. |
| Embed | could | ja | bekannte Anbieter (YouTube, Vimeo, Loom, Figma, …) als iframe, sonst Karte (14.11.) |
| Inhaltsverzeichnis | should | ja | |
| Breadcrumb-Block | could | nein | |
| Spalten 2–5 | should | ja | Slash „2–5 columns“, Ziehen, Breite ziehen |
| Einfache Tabelle | should | teils | Zellen (Klartext), Zeile/Spalte anfügen und löschen (14.11.); Formatierung in Zellen fehlt |
| Synced Block | could | ja | Original und Kopie zeigen und bearbeiten; „Copy and sync“ im Blockmenü und Einfügen von `based-sync:` (14.11.) |
| Button-Block | could | ja | Teil 6.5: Klick führt die Schritte aus (Insert blocks, Add page to, Open page, Open added page, Open link, Show confirmation; `runButton` im Kern), „Edit“ mit Schritten und Vorlage, Slash „Button“ |
| Unterseite im Inhalt | must | ja | |
| HTML-/Mermaid-Vorschau | should | ja | Mermaid; HTML-Vorschau im abgeschotteten Rahmen seit 14.11. |
| Inline-Datenbank | must | ja | über `renderDatabase` |
| Meeting-Block, Whiteboard | — | nein | Platzhalter „in the new editor soon“ |

## Bearbeiten

| Funktion | Prio | Neu | Notiz |
| --- | --- | --- | --- |
| Slash-Menü mit Suche | must | ja | |
| Markdown-Kürzel, Inline-Markdown | must | ja | |
| Enter, ⌫, Tab/⇧Tab, Pfeile, ⇧Enter | must | ja | |
| Fett, kursiv, unterstrichen, durchgestrichen, Code, Links ⌘K | must | ja | |
| Text- und Hintergrundfarbe im Text | must | ja | Formatleiste „A“ |
| Blockfarbe | should | ja | Blockmenü „Color“ |
| Turn into | must | ja | Blockmenü, ⌘⌥0–8 |
| Turn into page (⌘⌥9) | should | ja | Blockmenü „Page“ und ⌘⌥9, gleiche ID (14.11.) |
| Blockmenü (Löschen, Duplizieren, Verschieben, Farbe, Link) | must | ja | Suchfeld, „Move to“ (⌘⇧P) in andere Seite seit 14.11. (BSD-407); Icons, Kopf (Blocktyp), Fuß (Wortzahl), Untermenüs „Turn into“/„Color“ und Glas wie das Seitenmenü seit Teil 6.1 |
| Griff ziehen, Verschachteln, Spalten | must | ja | |
| Blockauswahl (Esc, ⇧↑/↓, Rechteck) | should | ja | |
| ⌘⇧↑/↓, ⌘D | should | ja | |
| Alle Toggles auf/zu (⌘⌥T) | could | ja | |
| Undo/Redo | must | ja | ein Schritt je Befehl, Tippen zusammengefasst |
| Einfügen (Markdown, HTML, Notion, Based-intern) | must | ja | |
| URL einfügen als Bookmark/Erwähnung | could | ja | URL über Auswahl → Link; nackte URL in leerer Zeile → Bookmark (14.11.) |
| Blöcke als Markdown kopieren | should | ja | ⌘C bei Blockauswahl und Blockmenü „Copy as Markdown“ (14.11.) |
| Suchen in der Seite (⌘F) | could | ja | FindBar arbeitet auf dem DOM |
| @-Erwähnung (Seite, Datum) | must | ja | Personen fehlen (ein Nutzer); seit Teil 6.4: „New page“ (Unterseite, erwähnt), Datum aus dem Wert, Wochentage, getippte Daten, „remind …“, Wähler an der Erwähnung (Ende, Uhrzeit, Remind me) |
| `[[`-Seitenlink | should | ja | `[[` öffnet die Seitensuche (nur Seiten), 14.11. |
| Titel ↔ erste Zeile | must | ja | |
| Platzhalter je Blocktyp | should | ja | |
| Ask AI in der Formatleiste | — | ja | Teil 6.6: Leertaste auf leerer Zeile (mit Modell), Slash „Ask AI“, Formatleiste „Ask AI“ (Improve, Fix, Shorter, Summarize); Insert/Replace je ein Undo-Schritt; nur mit AI-Schalter an |
| Echtzeit-Text, Präsenz | — | ja | E7, Dokument `text:<seite>` |

## Nächste Schritte bis E8

1. Lücken oben mit Prio `must`/`should` schließen: Bild per Link, Bookmark-Vorschau, Inline-Gleichung bearbeiten,
   Turn into page, Tabelle vollständig, HTML-Vorschau, Blockmenü-Suche, Copy as Markdown.
2. Meeting- und Whiteboard-Block portieren (Swift-/BlockNote-Komponenten als Vorlage, eigene Komponenten).
3. Die Editor-E2E des alten Editors (`editor-*.spec.ts`, `native-free`, `block-link`, …) gegen den neuen Editor
   umschreiben (Selektoren `.bx2-*` statt `.bn-*`).
4. Mac-Abnahme durch Elija → Schalter-Standard auf „neu“ → BlockNote, `mapping/bn.ts`, y-prosemirror und das
   Seiten-Dokument `page:` entfernen (Server-DocSession bleibt, bis keine alten Clients mehr schreiben).

## Lückenliste BSD-407 (BlockNote entfernen), Stand 14.11.2026

Entscheidung Elija 14.11.: BlockNote wird gelöscht, gebaut wird nur noch der Block-Editor. Damit fällt die
Mac-Abnahme vor E8 weg; Bedingung bleibt „must/should = ja“ und alle Editor-E2E grün gegen den neuen Editor.
Teile (jeder Teil für sich grün, eigener Commit „BSD-407 Teil n“):

| Teil | Inhalt | Stand |
| --- | --- | --- |
| 1 | Diese Liste | erledigt 14.11. |
| 2a | Blockmenü: Suchfeld, „Copy as Markdown“ | erledigt 14.11. |
| 2b | Blockmenü „Move to“ (MovePicker wiederverwenden), Turn into page (⌘⌥9) | erledigt 14.11. |
| 2c | Inline-Gleichung anlegen/bearbeiten, `[[`-Seitenlink, nackte URL → Bookmark | erledigt 14.11. |
| 2d | Bild per Link, Bookmark-Vorschau (`fetchLinkPreview`), Embed als iframe, PDF-Vorschau | erledigt 14.11. |
| 2e | Tabelle vollständig (Formatierung in Zellen, Zeile/Spalte löschen), HTML-Vorschau | Zeile/Spalte löschen und HTML-Vorschau erledigt 14.11.; Formatierung in Zellen offen |
| 2f | Meeting-Block, Whiteboard, Button-Aktionen, „Copy and sync“ (Synced Block anlegen) | „Copy and sync“ erledigt 14.11.; Button erledigt (Teil 6.5); Meeting, Whiteboard offen |
| 2g | Menüs und Formatleiste aus `@based/ui/astryx` statt eigener `.bx2-menu`-Knöpfe (BSD-349 geht darin auf) | Blockmenü erledigt (Teil 6.1: Icons aus dem Satz der App, Glas, Fläche/Zeilen wie `.menu`; alle `.bx2-menu` haben jetzt diese Fläche); Formatleiste offen |
| 3 | Block-Editor ist Standard (neuer Schlüssel `based.legacyEditor`, alter Schalter `based.newEditor` wird einmalig entfernt); Specs auf `getByTestId("block-editor")`/`.bx2-*` umgestellt, Rest gepinnt (unten) | erledigt 14.11. |
| 4 | BlockNote-Code (`ui/PageEditor.tsx`, `schema/`, `mapping/bn.ts`, y-prosemirror) und `@blocknote/*` löschen; Rundreise-Test Notion-Import | offen |

BSD-364 (PageEditor.tsx aufteilen) wird mit Teil 4 hinfällig: die Datei wird gelöscht.

## Teil 3 (14.11.2026): Block-Editor ist Standard

- **Schalter:** `legacyEditorPref` (`based.legacyEditor`, Standard aus) in `apps/web/src/shell/storage.ts`; der frühere
  Schlüssel `based.newEditor` (Standard „aus“) gilt nicht mehr und wird beim Start einmalig gelöscht
  (`migrateEditorPref`, aufgerufen in `connectEditor`). Damit bekommen auch Geräte, auf denen „New editor“ bewusst
  oder unbewusst aus war, den Block-Editor – Web und Desktop gleich (Tauri lädt denselben Web-Client).
  Notausgang: Settings → Diagnostics → For developers → „Old editor (BlockNote)“ (wirkt beim Öffnen einer Seite).
  Test: `apps/web/e2e/editor-default.spec.ts`.
- **Vor dem Umschalten geschlossen** (sonst Alltag kaputt oder Daten unsichtbar): Klick auf eine Seiten-Erwähnung
  öffnet die Seite; Erwähnungen zeigen Icon, Titel live und „in Trash“/„deleted“; `[[Titel]]` fertig getippt wird
  zur Erwähnung (vorhandene oder neue Seite); „Linked view of database“, „Mermaid diagram“ und „HTML“ im Slash-Menü;
  ⇧⌘V fügt Klartext ein; Doppelklick zeigt ein Bild groß; Bild mit Datei, die (noch) nicht auf dem Gerät ist, zeigt
  den Platzhalter der Hülle statt „Add an image“; schwebende Gliederung; Überschriften haben die Rolle `heading`;
  Rechtschreibprüfung folgt der Einstellung; Formel-Block zeigt beim Tippen die Vorschau; farbiger Callout füllt
  seinen Kasten; Klick in eine Einbettung beendet die Blockauswahl; Zitat-Sprung (Agent) und F6 finden den Block-Editor.
- **Einfache Tabelle im gemeinsamen Format:** Der Block-Editor schrieb bis Teil 2 die Zellen flach in
  `table.props.cells` und zeigte importierte Tabellen (Zeilen-Records `tableRow` mit `cells`, wie Swift, alter Editor,
  Markdown-/Notion-/Word-Import) leer an. Jetzt liest und schreibt er nur noch Zeilen-Records (Kern
  `editor/commands/table.ts`); alte flache Tabellen werden gelesen und beim ersten Bearbeiten überführt.
- **Seiten mit Meeting-Block** öffnen bis Teil 2f im alten Editor (`pageHasMeeting`, entschieden beim Öffnen) –
  sonst wären Aufnahme, Notizen und „⌘N → Meeting notes“ tot.
- **Nichts geht verloren:** Blöcke ohne Bearbeitung im Block-Editor (Meeting mit Abschnitten und Transkript,
  Button mit Aktionen, Breadcrumb) werden angezeigt und nie umgeschrieben; Tabellenzellen werden als Klartext
  bearbeitet, Formatierung, Links, Erwähnungen außerhalb der geänderten Stelle bleiben (`setTableCell`,
  `editPlainText` im Kern). Nach Undo/Redo bleibt der Fokus im Editor (vorher ging ⌘⇧Z nach einem
  zurückgenommenen Einfügen ins Leere). Tests: `apps/web/e2e/editor-passthrough.spec.ts` (auch Notion-Import-Rundreise: Öffnen und
  Klicken ändert keine Records), `packages/core/test/editor-table-cell.test.ts`.

### Lücken des Block-Editors (bleiben im alten Editor, Notausgang)

| Funktion | Stand im Block-Editor |
| --- | --- |
| Meeting-Block (Aufnahme, Notizen, Zusammenfassung) | Seiten mit Meeting öffnen im alten Editor; kommt ein Meeting während der Bearbeitung dazu: Platzhalter, Inhalt darunter bearbeitbar |
| Synced Block: Unsync, Hinweis bei Original im Papierkorb | nicht geprüft (Copy and sync geht) |
| Aufzeichnung für „Report a problem“ (ProseMirror-Schritte, Wiedergabe) | nur alter Editor; Hänger-Schritte (BSD-418) für Slash-Befehle („slash <Eintrag>“) und Blockmenü-Aktionen („block menu <Aktion>“) seit Teil 6.7 |
| Formatierung in Tabellenzellen | Klartext-Bearbeitung, vorhandene Formatierung bleibt erhalten |

### noch BlockNote (gepinnte Specs, Liste für Teil 4)

Gepinnt über `apps/web/e2e/legacy-editor.ts` (`useLegacyEditor`, `pinLegacyEditor`) bzw. `legacyTest` aus
`e2e/replay/fixture.ts`. Teil 4 schreibt sie auf den Block-Editor um oder löscht sie mit der Funktion.

| Spec | Was gepinnt ist |
| --- | --- |
| `collab.spec.ts` | ganz – Echtzeit über `page:` (y-prosemirror); Block-Editor: `block-editor-collab.spec.ts` |
| `meeting.spec.ts` | ganz – Meeting-Block |
| `editor-drag.spec.ts` | ganz – Ziehen am BlockNote-Griff; Block-Editor: `block-editor.spec.ts` |
| `editor-select.spec.ts` | ganz – Maus-Auswahl in ProseMirror; Block-Editor: `block-editor.spec.ts` |
| `editor-callout-select.spec.ts` | ganz – nachgestellter BlockNote-Fehler (BSD-318) |
| `replay/replay.spec.ts`, `replay/record-sample.spec.ts` | ganz – Wiedergabe von ProseMirror-Schritten |
| `report.spec.ts` | 4 von 5 Tests – Aufzeichnung „tr“/„yjs“, Blockbaum, Entwickler-Ereignisse |
| `editor-parity.spec.ts` | 15 von 19 Tests (Erwähnungs-Menü, Gliederung, Synced Block, Blockmenü-Abläufe, Spalten, Uploads, Seiten-Optionen …) |
| `editor-notion.spec.ts` | 1 von 14 Tests (Formatleiste) |
