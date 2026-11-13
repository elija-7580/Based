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
| Inline-Gleichung | should | teils | wird angezeigt, Anlegen/Bearbeiten fehlt |
| Bild (Upload, Link, Unterschrift) | must | teils | Upload, Einfügen, Ablegen, Breite, Unterschrift; Bild per Link fehlt |
| Video, Audio, Datei, PDF | should | teils | Hochladen und Anzeige; PDF ohne Vorschau |
| Web-Bookmark mit Vorschau | should | teils | Link-Feld und Karte; Vorschau holen (`fetchLinkPreview`) fehlt |
| Embed | could | teils | wird wie ein Bookmark gezeigt, kein iframe |
| Inhaltsverzeichnis | should | ja | |
| Breadcrumb-Block | could | nein | |
| Spalten 2–5 | should | ja | Slash „2–5 columns“, Ziehen, Breite ziehen |
| Einfache Tabelle | should | teils | Zellen (Klartext), Zeile/Spalte anfügen; Formatierung in Zellen, Löschen von Zeilen fehlt |
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
| Turn into page (⌘⌥9) | should | nein | |
| Blockmenü (Löschen, Duplizieren, Verschieben, Farbe, Link) | must | ja | Suchfeld im Blockmenü fehlt |
| Griff ziehen, Verschachteln, Spalten | must | ja | |
| Blockauswahl (Esc, ⇧↑/↓, Rechteck) | should | ja | |
| ⌘⇧↑/↓, ⌘D | should | ja | |
| Alle Toggles auf/zu (⌘⌥T) | could | ja | |
| Undo/Redo | must | ja | ein Schritt je Befehl, Tippen zusammengefasst |
| Einfügen (Markdown, HTML, Notion, Based-intern) | must | ja | |
| URL einfügen als Bookmark/Erwähnung | could | teils | URL über Auswahl → Link; nackte URL → Bookmark fehlt |
| Blöcke als Markdown kopieren | should | teils | ⌘C bei Blockauswahl schreibt Markdown; Menüeintrag fehlt |
| Suchen in der Seite (⌘F) | could | ja | FindBar arbeitet auf dem DOM |
| @-Erwähnung (Seite, Datum) | must | ja | Personen fehlen (ein Nutzer) |
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
