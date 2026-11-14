# Parität alter Editor (BlockNote) ↔ neuer Block-Editor (ADR 0016, E8)

Stand 13.11.2026. Grundlage: `replica/features.csv`, Bereiche `blocks` und `editor`. „ja“ = im neuen Editor gebaut
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
| Code mit Sprache und Hervorhebung | must | ja | Sprachwahl mit Suche, Hervorhebung über CSS Highlight API; kein Kopierknopf, kein Umbruch-Schalter |
| Block-Gleichung | should | ja | |
| Inline-Gleichung | should | teils | Anlegen („/Inline equation“), Bearbeiten per Klick, leer entfernt (14.11.); Anzeige noch als TeX statt KaTeX |
| Bild (Upload, Link, Unterschrift) | must | ja | Upload, Einfügen, Ablegen, Breite, Unterschrift; Bild per Link seit 14.11. |
| Video, Audio, Datei, PDF | should | ja | Hochladen und Anzeige; PDF mit Vorschau seit 14.11. |
| Web-Bookmark mit Vorschau | should | ja | Link-Feld und Karte; „Fetch preview“ (`fetchLinkPreview`, nur auf Klick) seit 14.11. |
| Embed | could | ja | bekannte Anbieter (YouTube, Vimeo, Loom, Figma, …) als iframe, sonst Karte (14.11.) |
| Inhaltsverzeichnis | should | ja | |
| Breadcrumb-Block | could | nein | |
| Spalten 2–5 | should | ja | Slash „2–5 columns“, Ziehen, Breite ziehen |
| Einfache Tabelle | should | teils | Zellen (Klartext), Zeile/Spalte anfügen und löschen (14.11.); Formatierung in Zellen fehlt |
| Synced Block | could | teils | Original und Kopie zeigen und bearbeiten (über Records); „Copy and sync“ fehlt |
| Button-Block | could | nein | wird angezeigt, Aktionen fehlen |
| Unterseite im Inhalt | must | ja | |
| HTML-/Mermaid-Vorschau | should | teils | Mermaid ja, HTML-Vorschau fehlt |
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
| Blockmenü (Löschen, Duplizieren, Verschieben, Farbe, Link) | must | ja | Suchfeld, „Move to“ (⌘⇧P) in andere Seite seit 14.11. (BSD-407) |
| Griff ziehen, Verschachteln, Spalten | must | ja | |
| Blockauswahl (Esc, ⇧↑/↓, Rechteck) | should | ja | |
| ⌘⇧↑/↓, ⌘D | should | ja | |
| Alle Toggles auf/zu (⌘⌥T) | could | ja | |
| Undo/Redo | must | ja | ein Schritt je Befehl, Tippen zusammengefasst |
| Einfügen (Markdown, HTML, Notion, Based-intern) | must | ja | |
| URL einfügen als Bookmark/Erwähnung | could | ja | URL über Auswahl → Link; nackte URL in leerer Zeile → Bookmark (14.11.) |
| Blöcke als Markdown kopieren | should | ja | ⌘C bei Blockauswahl und Blockmenü „Copy as Markdown“ (14.11.) |
| Suchen in der Seite (⌘F) | could | ja | FindBar arbeitet auf dem DOM |
| @-Erwähnung (Seite, Datum) | must | ja | Personen fehlen (ein Nutzer) |
| `[[`-Seitenlink | should | ja | `[[` öffnet die Seitensuche (nur Seiten), 14.11. |
| Titel ↔ erste Zeile | must | ja | |
| Platzhalter je Blocktyp | should | ja | |
| Ask AI in der Formatleiste | — | nein | AI ist hinter dem Schalter, Standard aus |
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
| 2c | Inline-Gleichung anlegen/bearbeiten, `[[`-Seitenlink, nackte URL → Bookmark | `[[`, URL und Inline-Gleichung anlegen/bearbeiten erledigt 14.11.; KaTeX-Anzeige im Text offen |
| 2d | Bild per Link, Bookmark-Vorschau (`fetchLinkPreview`), Embed als iframe, PDF-Vorschau | erledigt 14.11. |
| 2e | Tabelle vollständig (Formatierung in Zellen, Zeile/Spalte löschen), HTML-Vorschau | Zeile/Spalte löschen erledigt 14.11.; Formatierung in Zellen, HTML-Vorschau offen |
| 2f | Meeting-Block, Whiteboard, Button-Aktionen, „Copy and sync“ (Synced Block anlegen) | offen |
| 2g | Menüs und Formatleiste aus `@based/ui/astryx` statt eigener `.bx2-menu`-Knöpfe (BSD-349 geht darin auf) | offen |
| 3 | `based.newEditor` standardmäßig an; 50 Specs mit `.bn-*` auf `getByTestId("block-editor")`/`.bx2-*` umstellen | offen |
| 4 | BlockNote-Code (`ui/PageEditor.tsx`, `schema/`, `mapping/bn.ts`, y-prosemirror) und `@blocknote/*` löschen; Rundreise-Test Notion-Import | offen |

BSD-364 (PageEditor.tsx aufteilen) wird mit Teil 4 hinfällig: die Datei wird gelöscht.
