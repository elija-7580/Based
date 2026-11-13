# ADR 0016: Eigener Block-Editor nach dem Anytype-Prinzip (Clean-Room)

- **Status:** angenommen (Elija, 13.11.2026: „verwende die Architektur von Anytype und baue sie nach“)
- **Ersetzt:** den Editor-Teil von ADR 0011 (BlockNote + y-prosemirror). BlockNote bleibt hinter einem Schalter, bis
  der neue Editor Parität hat (Phase E8), danach wird es entfernt.
- **Bezug:** Plan 13.11. (Notion), ADR 0002 (Tombstones), 0008 (Kollaboration), 0014 (Properties als Records),
  BSD-258 (Blockauswahl), BSD-249 (Ziehen), BSD-220 (Echtzeit-Text)

## Kontext

Mac-Feedback vom 13.11.: Blöcke lassen sich nicht stabil verschieben, der Griff (⋮⋮ +) steht neben dem Text, ein
Klick darauf verschiebt die Seite, Auswahl von Blöcken ist unzuverlässig, Spalten mit Datenbanken „buggen herum“.
Ursache ist die Grundform: BlockNote/ProseMirror führt die Seite als **ein** großes Textdokument. Griff, Ablageziel
und Blockauswahl werden aus der Mausposition in diesem einen Dokument berechnet; jede Hover-Änderung kann Layout
verschieben (ResizeObserver-Schleifen im Absturzbericht). Unsere Block-Records (Kern) und das ProseMirror-Dokument
sind zwei Modelle, die laufend ineinander übersetzt werden (`mapping/bn.ts`).

Anytype und Notion bauen anders: **jeder Block ist eine eigene Einheit mit eigenem Textfeld**; Struktur, Griff,
Ziehen und Auswahl liegen in einer eigenen Schicht über den Blöcken.

## Lizenzlage

- **Anytype** (`anyproto/anytype-ts`): „Any Source Available License 1.0“ – Nutzung nur nichtkommerziell oder in
  Any-Netzen. Based ist MIT und soll eine bezahlte Cloud haben → **kein Code, keine Dateien, keine Strukturen
  kopieren.** Übernommen wird nur die Architektur (Ideen), wie unten beschrieben, in eigenen Worten und eigenem Code.
- **AppFlowy**: AGPL-3.0, Dart/Flutter (Web: React + Slate) – ebenfalls nur als Referenz.
- Clean-Room-Regel für alle Phasen: Wer an diesem Editor baut, liest nicht den Anytype-Quelltext, sondern dieses
  ADR und die Notion-Hilfe. Fragen zum Verhalten klärt die Notion-Hilfe oder Elija.

## Entscheidung: Architektur (Prinzip von Anytype, eigene Umsetzung)

1. **Ein Modell.** Die Seite ist der Baum der Block-Records im `WorkspaceStore` (id, Typ, Eltern, Sortierschlüssel,
   Props, RichText). Der Editor rendert diese Records direkt; es gibt kein zweites Dokumentmodell mehr.
2. **Befehle im Kern.** Jede Änderung ist ein reiner, getesteter Befehl in `packages/core` (`editor/commands`):
   Text setzen (Bereich + Marks), Block teilen (Enter), zusammenführen (⌫ am Anfang), einrücken/ausrücken, Typ
   ändern (Turn into, Markdown-Kürzel), verschieben (vor/nach/hinein/Spalte), löschen, duplizieren, einfügen
   (HTML/Markdown/Based-intern). Ein Befehl = eine Store-Transaktion = ein Undo-Schritt. Die Ansicht ruft nur Befehle
   auf, sie ändert nie selbst Records.
3. **Textblock = eigenes `contenteditable`.** Inhalt ist Text + Marks (Bereiche, wie `RichText`). Rendern: Marks →
   DOM. Eingabe über `beforeinput` (`insertText`, `deleteContentBackward`, `insertParagraph`, `formatBold` …) als
   Befehle; das DOM wird nicht zurückgelesen, außer bei IME-Komposition (`compositionend`) und Rechtschreib-
   korrektur. Ein Block, der nicht fokussiert ist, ist reines Anzeige-DOM.
4. **Fokus-Manager.** Ein globaler Zustand `{ blockId, range }`. Befehle geben den neuen Fokus zurück; nach dem
   Rendern setzt der Fokus-Manager Cursor/Auswahl im DOM. Pfeil hoch/runter an der ersten/letzten Zeile springt in
   den Nachbarblock und hält die x-Position.
5. **Auswahl-Schicht.** Zwei Arten, beide außerhalb der Textfelder: (a) **Textauswahl über Blöcke** (Anker = Block
   + Offset, Kopf = Block + Offset; Darstellung als Markierung pro Block; Kopieren, Löschen, Formatieren wirken über
   alle) – das hatte Anytype lange nicht, Notion schon, wir bauen es von Anfang an ein; (b) **Blockauswahl** als
   Menge von Block-IDs: Rechteck aus dem Seitenrand ab einer Schwelle, ⇧-Klick, ⌘A zweimal, Esc, Pfeile.
   Treffer gegen vermessene Block-Rechtecke, Neuberechnung höchstens einmal pro Frame.
6. **Griff und Ziehen.** Der Griff gehört zum Block und sitzt an dessen erster Zeile (aus der Zeilenhöhe des
   Blocktyps), in einer eigenen Ebene ohne Einfluss auf das Layout. Beim Start des Ziehens werden alle Ablageziele
   **einmal** vermessen (Dokumentkoordinaten), während des Ziehens wird nur gegen diesen Zwischenspeicher geprüft,
   einmal pro Frame; Zonen: oben/unten = davor/danach, eingerückt = hinein, linker/rechter Rand = Spalte; Auto-Scroll
   am Rand mit Neuvermessung. Ablegen = ein Befehl.
7. **Menüs** (Slash, @, Formatleiste, Blockmenü, Turn into, Farbe, Link) verankern sich am Block-Element und
   kommen aus `@based/ui` im Stil des Seitenmenüs (BSD-349).
8. **Eingebettete Blöcke** (Inline-Datenbank, Bild, Datei, PDF, Embed, Bookmark, Mermaid, Gleichung, Synced Block,
   Tabelle, Unterseite/Link, Meeting, Whiteboard) sind eigene Komponenten ohne Textfeld; sie bekommen Griff, Auswahl
   und Ziehen von der Schicht, nicht von sich selbst.
9. **Echtzeit.** Text eines Blocks als `Y.Text` (Marks als Attribute) in einem Y.Doc pro Seite, Struktur weiter über
   Records/Sync v2. Umstieg vom heutigen Seiten-Y.Doc (y-prosemirror, BSD-220) mit Migration und Test für alte
   Daten (Phase E7); bis dahin arbeitet der neue Editor nur auf Records (LWW, wie ADR 0008).
10. **Große Seiten.** Blöcke außerhalb des sichtbaren Bereichs werden als Platzhalter mit gemessener Höhe gerendert
    (Notion-Importe mit Tausenden Blöcken).

## Phasen

| Phase | Inhalt | Wer |
| --- | --- | --- |
| E0 | Gerüst `packages/editor/src/blocks/`, Schalter „New editor“ (Settings → Diagnostics → For developers, pro Gerät), Testseite als Fixture (Spalten mit Datenbanken, Callout, Zitat, Liste, lange Tabelle) | Nachtschicht |
| E1 | Befehle im Kern + Undo-Gruppen, Unit-Tests auf Records (beide Datenformate) | Fable |
| E2 | Textblock, Fokus-Manager, Tastatur (Enter, ⌫, Pfeile, Tab, Markdown-Kürzel), Marks, IME; Typen Text, H1–H3, Listen, To-do, Toggle, Zitat, Callout, Trenner, Code | Nachtschicht |
| E3 | Auswahl-Schicht: Textauswahl über Blöcke, Blockauswahl, Kopieren/Einfügen | Fable |
| E4 | Griff, Ziehen, Spalten | Nachtschicht |
| E5 | Menüs im Based-Stil (übernimmt BSD-349) | Nachtschicht |
| E6 | Eingebettete Blöcke portieren | Nachtschicht |
| E7 | Echtzeit: Y.Text pro Block, Migration vom Seiten-Y.Doc, Präsenz | Fable |
| E8 | Parität (`replica/features.csv`), alle Editor-E2E gegen den neuen Editor, Standard umschalten, BlockNote entfernen | Nachtschicht + Mac-Abnahme |

Jede Phase: Tests, die Elijas gemeldete Fehler nachstellen (Griff ≤ 2 px an der ersten Zeile, Klick auf ⋮⋮ ohne
Scroll, Ziehen in/aus Spalten, keine ResizeObserver-Fehler), Chromium und WebKit, Screenshots nach Checkliste.

## E7 umgesetzt (13.11.2026): Echtzeit-Text je Block

- **Dokument** `text:<seite>` auf `/collab` (Hocuspocus wie BSD-220), Y.Map `texts`: Block-ID → `Y.Text`. Marks sind
  Attribute (`b i u s c color link`, nicht gesetzte als `null`), Erwähnungen/Formeln sind ihr Text mit Attribut
  `mention`/`eq` und eigener `atom`-ID – gleiche Offsets wie `RichText` (UTF-16, `plainText`). Code:
  `packages/editor/src/yjs/text-session.ts` (`TextSession`, `writeRuns`, `richTextOf`).
- **Nur der Server füllt** (wie BSD-220): Er legt die Y.Texts aus den Records an, schreibt Y-Änderungen der Geräte als
  Records (Sync v2 → alle, auch Swift) und übernimmt Records von außen (MCP, Swift, Geräte ohne Echtzeit) per Diff.
  Records von Geräten, die gerade selbst am Dokument hängen (Awareness-Feld `node`), übernimmt er nicht in ein
  vorhandenes Y.Text, sondern leitet den Record wieder aus dem Y.Doc ab (ein Record kann älter sein und trotzdem
  den neueren Stempel tragen).
- **Gerät:** Für Blöcke mit Y.Text ist das Y.Doc die Quelle. Eigene Befehle bleiben Records (ein Undo-Schritt) und
  gehen per Diff ins Y.Text; Records von außen und Y-Änderungen anderer werden „derived“ abgeleitet (nicht gepusht).
  Ein neuer Block läuft über Records, bis der Server sein Y.Text anlegt; was man bis dahin tippt, geht beim ersten
  Binden ins Y.Text. Die eigene Schreibmarke wird mit dem Delta der anderen verschoben.
- **Präsenz:** Awareness `{ node, name, cursor: { block, from, to } }`; die anderen erscheinen als farbige
  Schreibmarke mit Namen (Farbe aus den Block-Farbtokens, je Gerät fest).
- **Migration vom Seiten-Y.Doc:** Das alte Dokument `page:<seite>` bleibt für den alten Editor. Beim Laden von
  `text:<seite>` schreibt der Server zuerst ausstehende Änderungen des alten Dokuments als Records; das neue wird aus
  den Records gefüllt. Beide Brücken laufen über die Records nebeneinander (Test: `apps/server/test/collab-text.test.ts`).
- **Grenzen:** Undo bleibt pro Gerät auf Records (stellt den Text des Blocks von vor dem eigenen Schritt her; eine
  gleichzeitige Änderung eines anderen im selben Block kann dabei zurückgenommen werden). Struktur (Enter, Ziehen,
  Typ) bleibt LWW über Records. Synced Blocks laufen im neuen Editor über Records.

## Konsequenzen

- Mehrere Wochen Arbeit; bis E8 laufen zwei Editoren nebeneinander (Schalter). Fehler im alten Editor werden nur
  noch behoben, wenn sie Daten gefährden.
- `mapping/bn.ts` und die BlockNote-Abhängigkeiten fallen am Ende weg; Golden Fixtures prüfen weiter die Records.
- Datenformat bleibt bis E7 unverändert (Records). E7 ist eine Format-Änderung mit Migration (ADR 0002/0008).
- Die Einträge „Blockschicht 1–3“ und der Spike vom 13.11. gehen in E3/E4 auf.
