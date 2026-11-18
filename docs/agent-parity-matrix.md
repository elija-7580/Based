# Agent-Parität: Bestandsaufnahme (Schritt 1)

Stand 18.11.2026, gelesen auf `main` (f07b0bf) plus `feat/board-markdown` (f27f9b9, dort liegt der Auftrag
`docs/agent-parity.md`). Keine Code-Änderung. Diese Matrix wird in Schritt 4 je Eintrag fortgeschrieben
(Lücke → „erledigt“ mit Commit).

Aufwand: **S** = dünne Hülle um Logik, die es in `packages/core` schon gibt · **M** = neues Werkzeug mit eigener
Logik oder Leseformat · **L** = braucht neue Kernlogik, einen Host-Weg (Dateien, Netz, Gerät) oder eine offene
Produktentscheidung.

## Was vor der Matrix zu wissen ist

1. **Es gibt heute zwei Werkzeug-Schichten, Regel 1 gilt noch nicht.** `WorkspaceTools`
   (`packages/brain/src/tools.ts`) kennt 15 Werkzeuge. Der MCP-Server (`apps/server/src/mcp.ts`) registriert 46;
   davon laufen nur `read_board`, `draw_board` und `list_files` durch `WorkspaceTools`. Der Rest ist im Server
   selbst gebaut (`pages.ts`, `databases.ts`, Projekte/Runs, Agent Brain). Folgen:
   - 12 Werkzeuge gibt es doppelt, mit verschiedenen Argumentnamen (`page_id` in `WorkspaceTools`, `id` im
     Server): `search`, `read_page`, `list_pages`, `create_page`, `append_markdown`, `replace_page_content`,
     `find_replace`, `update_page`, `list_databases`, `query_database`, `add_row`, `update_row`.
   - Baseds eigene Agenten (`worker/chat.ts`, `agent-engine.ts`) können nicht, was nur der Server hat:
     `move_page`, `duplicate_page`, `trash_page`/`restore_page`/`list_trash`, `backlinks`, `set_favorite`,
     `database_schema`, `create_database`, `update_database`, alle View-Werkzeuge, Projekte, `upload_file`.
   - Jedes neue Werkzeug würde heute an zwei Stellen landen. Das Zusammenlegen ist deshalb der erste Eintrag
     (Zeile G1), nicht ein Nebenprodukt.
2. **`docs/mcp.md` beschreibt teils die alte Swift-App.** Im TypeScript-Server fehlen: `add_html`, `add_mermaid`,
   `add_button`, `create_chart`, `list_connections`, `read_skill_file`, `capture`/`list_captures`/`file_capture`
   und die Host-Werkzeuge (`spawn_agent`, `wait_for_agents`, `agent_sessions`, `read_agent_session`,
   `message_agent`, `stop_agent`, `approval`). `memory_search`/`memory_save`/`about_user` heißen jetzt
   `recall`/`remember`/`about_me`.
3. **Im Seiten-Editor kann ein Agent keinen einzelnen Block ansprechen.** `read_page` gibt Markdown ohne
   Kennungen zurück; schreiben geht nur als „anhängen“, „alles ersetzen“ oder „Textstelle ersetzen“. Alles, was
   der Mensch am Griff oder im Blockmenü macht, fehlt deshalb in einem Stück. Die Kernlogik dafür ist fertig und
   getestet (`packages/core/src/editor/commands`: `moveBlocks`, `moveBlocksToPage`, `turnInto`, `insertColumns`,
   `setBlockProps`, `duplicateBlocks`, `deleteBlocks`, `indentBlocks`, Tabellenbefehle).
4. **Nicht jedes schreibende Werkzeug ist richtig eingeordnet.** `trash_page` und `replace_page_content` tragen
   `destructiveHint`; `delete_view` und `update_database` mit `delete_properties` oder `change_types` (kann Werte
   verwerfen) nicht. `list_views` ist lesend, hat aber kein `readOnlyHint` und läuft damit durch die Schreib-Regeln.

## Vorgeschlagene Werkzeuge (auf die sich die Spalte „Vorschlag“ bezieht)

| Werkzeug | Idee |
| --- | --- |
| `read_blocks { id, from?, limit? }` | Eine Zeile je Block: Kurzkennung, Art, Einrückung, Text, `{color=… checked … }`. Wie `read_board`. |
| `edit_blocks { id, script }` | Ein Skript wie `draw_board`, eine Transaktion: `add <art> after a: Text`, `set a: Text`, `set a {type=… color=…}`, `move a b after c` / `into c`, `cols a \| b c`, `indent`/`outdent`, `dup`, `del`, `check`, `image after a: <ref>`, `row`/`col` für einfache Tabellen. |
| `update_page` (erweitert) | Icon (Emoji, `phosphor:…`, Bild-Ref), Cover (Farbe, Verlauf, Bild-Ref, Link, Höhe, Position), Schrift, Small text, Full width, Lock, Board-Hintergrund. |
| `move_page` (erweitert) | Position (`before`/`after`), Bereich (Private, Teamspace), mehrere Seiten. |
| `update_database` / `update_view` (erweitert) | Formel, Relation, Rollup, Formate, Optionen; sichtbare Properties, Layout-Optionen, Berechnungen. |
| `workspace { script }` oder Einzelwerkzeuge | Teamspaces, Workspace-Name und -Icon. Selten gebraucht. |
| `page_history`, `restore_version` | Versionsverlauf lesen, eine Version zurückholen. |
| `export_page`, `import_files` | Export als Datei-Ref oder Text; Import aus Datei-Refs. |
| `list_meetings`, `read_meeting` | Meetings finden; Notizen, Zusammenfassung, Transkript getrennt und seitenweise lesen. |
| `share_page`, `list_shares`, `revoke_share` | Erst nach den Entscheidungen zu Teilen und Rollen. |

## Matrix

### G · Grundlage

| Bereich | Aktion | Wo in der Oberfläche | Werkzeug heute | Lücke | Vorschlag | Aufwand |
| --- | --- | --- | --- | --- | --- | --- |
| Grundlage | G1 Eine Werkzeug-Schicht | – | zwei Schichten (siehe oben) | Regel 1 verletzt, 12 Doppelte, eigene Agenten können weniger | Server-Werkzeuge nach `WorkspaceTools` ziehen, `mcp.ts` reicht nur durch; ein Argumentname (`id` oder `page_id`) | L |
| Grundlage | G2 Einordnung der Schreib-Werkzeuge | – | `readOnlyHint`/`destructiveHint` von Hand | drei falsch eingeordnet (Punkt 4) | Einordnung an der Werkzeug-Definition (`write`, `destructive`), Test prüft die Liste | S |
| Grundlage | G3 `docs/mcp.md` stimmt | – | beschreibt Swift-Stand mit | 14 Werkzeuge stehen drin, die es im TS-Server nicht gibt | Doku auf TS-Stand; Fehlendes als Zeilen dieser Matrix | S |
| Grundlage | G4 Undo je Aufruf | ⌘Z | – | nicht einheitlich geprüft, ob jeder Schreib-Aufruf genau eine `store.transact` ist (`update_database` schreibt in mehreren Schritten) | bei G1 mitziehen, Test je Werkzeug | M |

### E · Seiten-Editor

| Bereich | Aktion | Wo in der Oberfläche | Werkzeug heute | Lücke | Vorschlag | Aufwand |
| --- | --- | --- | --- | --- | --- | --- |
| Editor | E1 Seite lesen | Seite | `read_page` (Markdown) | keine Blockkennungen, keine Farben, Spalten und Synced Blocks fallen flach | `read_blocks` | M |
| Editor | E2 Text ans Ende schreiben | Tippen | `append_markdown` | – | bleibt | – |
| Editor | E3 Block an einer Stelle einfügen | Enter, Slash, „+“ | – | nur ans Ende | `edit_blocks`: `add … after/before/into` | M |
| Editor | E4 Text eines Blocks ändern | Tippen | `find_replace` (Textstelle) | kein gezieltes Ersetzen eines Blocks | `edit_blocks`: `set a: Text` | S |
| Editor | E5 Fett, kursiv, Code, Link, Textfarbe | Format-Popup, ⌘B … | Markdown beim Schreiben | Textfarbe und Hintergrund im Text nicht ausdrückbar | Markdown bleibt; Farbe als `==`-artige Schreibweise erst bei Bedarf | M |
| Editor | E6 Block löschen | ⌫, Blockmenü „Delete“ | `replace_page_content` (alles) | kein einzelner Block | `edit_blocks`: `del` | S |
| Editor | E7 Block duplizieren | ⌘D, Blockmenü | – | fehlt | `edit_blocks`: `dup` | S |
| Editor | E8 Block verschieben (in der Seite) | Griff ziehen, ⌘⇧↑/↓ | – | fehlt | `edit_blocks`: `move` | S |
| Editor | E9 Einrücken, ausrücken, verschachteln | Tab, ⇧Tab, Ziehen | Markdown-Einrückung beim Schreiben | nachträglich nicht | `edit_blocks`: `indent`/`outdent`/`move … into` | S |
| Editor | E10 Spalten 2–5, Breiten | Slash, Ziehen an den Rand | – | fehlt | `edit_blocks`: `cols a \| b {ratio=…}`, `uncols` | M |
| Editor | E11 Turn into (inkl. Toggle-Überschrift, Section, Gleichung) | Blockmenü, ⌘⌥0–8 | – | fehlt | `edit_blocks`: `set a {type=…}` | S |
| Editor | E12 Turn into page | Blockmenü, ⌘⌥9 | – | fehlt | `set a {type=page}` | S |
| Editor | E13 Block in andere Seite verschieben | Blockmenü „Move to“, ⌘⇧P | – | fehlt | `move a to <page id>` | S |
| Editor | E14 Blockfarbe | Blockmenü „Color“ | Callout-Farbe über `> [!NOTE]` | sonst fehlt | `set a {color=… bg=…}` mit den Namen aus core | S |
| Editor | E15 To-do abhaken, Toggle auf/zu | Klick, ⌘Enter | `find_replace` trifft `[ ]` nicht | fehlt | `check a` / `uncheck a`; `open`/`close` | S |
| Editor | E16 Callout-Icon | Emoji-Picker | Markdown-Callout (festes Icon) | freies Icon fehlt | `set a {icon=…}` | S |
| Editor | E17 Code: Sprache, Umbruch | Leiste am Block | Sprache über Code-Zaun | `wrap` fehlt | `set a {lang=… wrap=true}` | S |
| Editor | E18 Bild einfügen (Upload, Link), Breite, Ausrichtung, Unterschrift | Slash, Ablegen, Bildleiste | Bild per Link im Markdown; `upload_file` legt nur aufs Board | hochgeladene Datei kommt nicht in eine Seite; Breite, Ausrichtung, Unterschrift fehlen | `edit_blocks`: `image after a: <ref> {width= align= caption=}`; `upload_file { page }` | M |
| Editor | E19 Video, Audio, Datei, PDF einfügen | Slash, Ablegen | – | fehlt | `file after a: <ref>` (Art aus der Datei) | S |
| Editor | E20 Web-Bookmark, Embed | Slash, URL einfügen | – | fehlt; Vorschau holt Netz | `bookmark after a: <url>`; Vorschau nur über die Schutzregeln aus `board-files.ts` | M |
| Editor | E21 Einfache Tabelle: Zellen, Zeile/Spalte | Tabelle | Markdown-Tabelle beim Anlegen | nachträglich nicht | `edit_blocks`: `cell a 2,3: Text`, `row`/`col` add/del | M |
| Editor | E22 Gleichung (Block, inline) | Slash | `$$…$$`, `$…$` im Markdown | – | bleibt; in `based_guide` nennen | S |
| Editor | E23 Mermaid, HTML-Block (Code/Ergebnis zeigen) | Slash, Blockleiste | Code-Zaun `mermaid`/`html`; `add_html`/`add_mermaid` nur Swift | Anzeige „result only“ nicht setzbar | `set a {show=result\|code\|both}` | S |
| Editor | E24 Unterseite, Inline-Datenbank, Whiteboard im Inhalt | Slash „Page“, „Database“, „Whiteboard“ | `create_page {parent}`, `create_database {inline}`, `draw_board {parent}` | Stelle in der Seite nicht wählbar (immer ans Ende) | Argument `after` (Blockkennung) an allen dreien | S |
| Editor | E25 Linked view of database | Slash | – | fehlt | `add linked after a: <database id>` | M |
| Editor | E26 Synced Block (Copy and sync, Unsync) | Blockmenü | – | fehlt | `sync a to <page id>` / `unsync a` | M |
| Editor | E27 Button-Block mit Schritten | Slash „Button“, „Edit“ | `add_button` nur Swift | fehlt | `button after a: Label {steps…}` oder eigenes Werkzeug | M |
| Editor | E28 Inhaltsverzeichnis, Trenner | Slash | Trenner `---` | TOC fehlt | `add toc after a` | S |
| Editor | E29 Erwähnung (Seite, Datum, Erinnerung) | `@`, `[[` | Seite über `[Titel](based://page/<id>)` | Datum und „Remind me“ fehlen | `@date(2026-11-20 14:00 remind=1d)` im Markdown | M |
| Editor | E30 Unverlinkte Erwähnung verlinken | Backlinks „Link“ | – | fehlt | `link_mention` oder Teil von `edit_blocks` | S |
| Editor | E31 Link auf einen Block kopieren | Blockmenü | – | Kennung fehlt | `read_blocks` gibt `based://page/<id>#<block>` | S |
| Editor | E32 Als Markdown kopieren | ⌘C, Blockmenü | `read_page` | – | erledigt | – |
| Editor | E33 Meeting-Block anlegen | Slash „Meeting notes“, ⌘N | – | fehlt | siehe M1 | – |
| Editor | E34 Ask AI im Text | Leertaste, Slash, Formatleiste | – | bewusst nicht | Der Agent ist selbst das Modell; er schreibt über `edit_blocks`. | – |
| Editor | E35 Undo/Redo | ⌘Z | – | offen (Frage 4) | `undo_last` nur für den eigenen letzten Aufruf | M |
| Editor | E36 Blockauswahl, Schreibmarke, Suchen in der Seite, Gliederung ein/aus | Esc, ⌘F, Seitenmenü | – | bewusst nicht | Rein visuell; `search` und `read_blocks` decken das Finden ab. | – |
| Editor | E37 Echtzeit-Präsenz | Cursor anderer | – | bewusst nicht | Kein Dateninhalt. | – |

### D · Datenbanken

| Bereich | Aktion | Wo in der Oberfläche | Werkzeug heute | Lücke | Vorschlag | Aufwand |
| --- | --- | --- | --- | --- | --- | --- |
| Datenbank | D1 Datenbanken und Schema lesen | – | `list_databases`, `database_schema` | – | erledigt (nur MCP, siehe G1) | – |
| Datenbank | D2 Zeilen lesen | Ansicht | `query_database { search, sort }` | kein Filter, keine Ansicht als Quelle, keine Spaltenauswahl | `query_database { view?, filters?, properties? }` mit denselben Filtern wie `update_view` | M |
| Datenbank | D3 Zeile anlegen, Werte setzen | „New“, Zelle | `add_row`, `update_row` | Relation („read-only here“), Person, Dateien, Ort nicht setzbar | Relation über Zeilen-ID oder Titel; Dateien über Ref; Ort über Text | M |
| Datenbank | D4 Viele Zeilen auf einmal | Einfügen, Autofill, Mehrfachauswahl | – | ein Aufruf je Zeile | `add_rows { id, rows[] }` / CSV; `update_rows` | M |
| Datenbank | D5 Zeile löschen, duplizieren, verschieben | Zeilenmenü | `trash_page`, `duplicate_page` (Zeile ist Seite) | nicht dokumentiert, nicht getestet für Zeilen | Test + Hinweis in der Beschreibung | S |
| Datenbank | D6 Zeile als Seite schreiben | Zeile öffnen | `append_markdown`, `read_page` | – | erledigt | – |
| Datenbank | D7 Datenbank anlegen, umbenennen | Slash, ⌘N | `create_database`, `update_database` | – | erledigt (nur MCP) | – |
| Datenbank | D8 Property anlegen, umbenennen, Typ, löschen | Property-Menü | `update_database` | Löschen und Typwechsel ohne `destructiveHint` | G2 | S |
| Datenbank | D9 Formel | Property-Menü „Formula“ | Typ anlegbar | Ausdruck nicht setzbar | `update_database { formulas: {name: expr} }`, Fehler nennt die Stelle | M |
| Datenbank | D10 Relation und Rollup einrichten | Property-Menü | Typ anlegbar | Zieldatenbank, Rollup-Relation, -Property, -Funktion nicht setzbar | `update_database { relations, rollups }` | M |
| Datenbank | D11 Zahlen- und Datumsformat, ID-Präfix, Beschreibung | Property-Menü | – | fehlt | `update_database { formats }` | S |
| Datenbank | D12 Optionen: Farbe, umbenennen, löschen, Reihenfolge, Status-Gruppen | Property-Menü | `add_options` | nur anfügen | `update_database { options }` mit den Farbnamen aus core | M |
| Datenbank | D13 Ansicht anlegen, umbenennen, löschen | Reiter, „Add view“ | `create_view`, `update_view`, `delete_view`, `list_views` | `list_views` nicht als lesend markiert | G2 | S |
| Datenbank | D14 Filter, Sortierung, Gruppierung | Filter, Sort, Group | `update_view` | verschachtelte Filtergruppen, Untergruppen, „Hide empty groups“, Datums-Gruppierung prüfen | Filter-Liste aus core, Rest als `options` | M |
| Datenbank | D15 Sichtbare Properties, Reihenfolge, Spaltenbreite, Umbruch | View settings „Properties“, Ziehen | – | fehlt | `update_view { properties: [namen in Reihenfolge], wrap }`; Breite bewusst nicht | S |
| Datenbank | D16 Layout-Optionen (Karten-Vorschau, -Größe, Datums-Property, Zeitraum, Karte, „Open pages in“, Titel und Icon zeigen) | View settings | – | fehlt | `update_view { options }` mit Namen wie in der Oberfläche | M |
| Datenbank | D17 Berechnungen (Summe, Anzahl …) | Tabellenfuß | – | fehlt; Ergebnis auch nicht lesbar | `update_view { calculations }`; `query_database` gibt die Fußzeile aus | M |
| Datenbank | D18 Chart und Dashboard-Widgets | View settings „Chart“, „Widgets“ | `create_chart` nur Swift; `create_view type=chart` ohne Achsen | Achsen, Aggregat, Typ, Widgets fehlen | `update_view { chart }` | M |
| Datenbank | D19 Formular-Ansicht | Form | `create_view type=form` | Fragen, Pflichtfelder fehlen | `update_view { form }` | M |
| Datenbank | D20 Zeilen-Vorlagen | „New“ ▾, „Templates“ | – | fehlt | `update_database { templates }`; `add_row { template }` | M |
| Datenbank | D21 Datenbank sperren | View settings „Lock database“ | – | fehlt | `update_database { locked }` | S |
| Datenbank | D22 Als ganze Seite öffnen, Zeilen-Vorschau, Suche in der Ansicht | Kopfzeile | – | bewusst nicht | Rein visuell; `query_database { search }` deckt die Suche. | – |
| Datenbank | D23 Karte: Ort suchen (Geocoding) | Ort-Zelle | – | bewusst nicht | Geocoding nur über den Knopf (Entscheidung 10.11.); der Agent setzt Text oder Koordinaten. | – |

### S · Shell, Seitenmenü, Library

| Bereich | Aktion | Wo in der Oberfläche | Werkzeug heute | Lücke | Vorschlag | Aufwand |
| --- | --- | --- | --- | --- | --- | --- |
| Shell | S1 Suchen | ⌘K | `search`, `recall` | Filter (Art, Ort, Datum) und Sortierung wie in ⌘K fehlen | `search { kind?, within?, sort? }` | S |
| Shell | S2 Seitenbaum lesen | Sidebar | `list_pages` | Teamspaces und Bereiche nicht sichtbar | `list_pages` nennt Bereich; ohne `parent` Gruppen je Bereich | S |
| Shell | S3 Seite anlegen (auch aus Vorlage) | ⌘N, „+“, Starter-Vorlagen | `create_page` | Bereich, Stelle, Starter-Vorlage (Tasks, Notes, Journal, Wiki) fehlen | `create_page { section?, after?, template? }` | S |
| Shell | S4 Umbenennen, Emoji-Icon | Titel, Icon | `update_page` | – | erledigt | – |
| Shell | S5 Icon aus Phosphor (mit Farbe) oder Bild | Icon-Picker „Icons“ | – | fehlt | `update_page { icon: "phosphor:…" \| <ref> }`, Liste aus core | S |
| Shell | S6 Cover: Farbe, Verlauf, Bild, Link, Höhe, Position | „Change cover“ | nur `remove_cover` | fehlt | `update_page { cover }` | M |
| Shell | S7 Schrift, Small text, Full width | Seitenmenü | nur beim Anlegen in der App | fehlt | `update_page { font, small_text, full_width }` | S |
| Shell | S8 Seite sperren | Seitenmenü „Lock page“ | – | fehlt; schreiben Agenten heute in gesperrte Seiten? prüfen | `update_page { locked }`; Schreib-Werkzeuge lehnen gesperrte Seiten ab | S |
| Shell | S9 Verschieben in Seite | Ziehen, „Move to…“ | `move_page` | Stelle (davor/danach), Bereich/Teamspace, mehrere fehlen | `move_page { ids, parent \| section, before?/after? }` | S |
| Shell | S10 Duplizieren | Menü | `duplicate_page` | – | erledigt (nur MCP) | – |
| Shell | S11 Favoriten | Seitenmenü, Sidebar | `set_favorite` | Reihenfolge der Favoriten | bewusst nicht (persönliche Anordnung), sonst `after` | – |
| Shell | S12 Papierkorb: hinein, zurück, Liste | Menü, Trash | `trash_page`, `restore_page`, `list_trash` | – | erledigt (nur MCP) | – |
| Shell | S13 Endgültig löschen, Papierkorb leeren | Trash „Delete forever“, „Empty Trash“ | – | fehlt | offen (Frage 3) | S |
| Shell | S14 Teamspaces: anlegen, umbenennen, Icon, löschen | Sidebar | – | fehlt | Einzelwerkzeuge oder `workspace`-Skript; Löschen mit `destructiveHint` | M |
| Shell | S15 Workspace-Name und -Icon | Sidebar-Kopf | – | fehlt | `update_workspace` | S |
| Shell | S16 Backlinks, Verwandtes | Backlinks-Leiste | `backlinks`, `related` | – | erledigt | – |
| Shell | S17 Graph lesen | Library „Graph“ | `related` (eine Seite) | ganzer Graph bzw. Nachbarschaft mit Tiefe fehlt | `related { depth }`; ganzer Graph nur als Zählung | S |
| Shell | S18 Library: filtern, sortieren, „Same title“, Mehrfachauswahl | Library | `search`, `list_pages` | Liste nach Art, Datum, Dubletten fehlt | `search` ohne Query mit `kind`, `sort`, `duplicates` | S |
| Shell | S19 Link kopieren | Seitenmenü | jede Antwort nennt `based://page/<id>` | – | erledigt | – |
| Shell | S20 Board-Hintergrund | Seitenmenü „Background“ | `draw_board`: `background …` | – | erledigt | – |
| Shell | S21 Tabs, Zurück/Vor, neues Fenster, Sidebar ein/aus und Breite, Theme, Tastenkürzel-Übersicht | Tab-Leiste, ⌘[ ⌘], ⌘\ | – | bewusst nicht | Fenster und Darstellung des Geräts, keine Workspace-Daten. | – |
| Shell | S22 Sidebar-Einträge anordnen/ausblenden, Reiter anpinnen | Sidebar | – | bewusst nicht | Persönliche Anordnung je Gerät; die Baum-Reihenfolge selbst deckt S9. | – |
| Shell | S23 Problem melden | ⇧⌘B | – | bewusst nicht | Bündel enthält Gerätedaten und bleibt lokal (Entscheidung 11.11.). | – |

### V · Versionsverlauf, Export, Import

| Bereich | Aktion | Wo in der Oberfläche | Werkzeug heute | Lücke | Vorschlag | Aufwand |
| --- | --- | --- | --- | --- | --- | --- |
| Verlauf | V1 Versionen ansehen | Seitenmenü „Version history“ | – | fehlt | `page_history { id }`: Zeit, Autor, Kurz-Diff; `read_page { version }` | M |
| Verlauf | V2 Version wiederherstellen | „Restore“ | – | fehlt | `restore_version` (ein Undo-Schritt, `destructiveHint`) | S |
| Export | V3 Seite exportieren (Markdown, HTML, PDF, Word, JSON, OPML, Archiv) | „Export…“ | `read_page` (Markdown als Text) | Dateiformate fehlen; Datei muss zum Agenten | `export_page { id, format, subpages? }` → Datei-Ref, über stdio auch Pfad | L |
| Export | V4 Ganzen Workspace exportieren | Settings → Import | – | fehlt | wie V3; nur stdio oder als Download-Link des Servers | L |
| Export | V5 Drucken | ⌘P | – | bewusst nicht | Gerät. PDF deckt V3. | – |
| Import | V6 Dateien importieren (Markdown, HTML, Word, Notion-ZIP, Obsidian, Logseq, Bear, Evernote, OPML, Archiv) | ⌘N „Import“, Settings | `create_page { markdown }` | alles außer Markdown-Text fehlt | `import_files { refs \| path, parent? }` über die Importer aus core; Antwort ist der Bericht | L |
| Import | V7 Notion-Import (Hybrid, API) starten, pausieren | Settings → Import | – | fehlt | offen: braucht Token und läuft lange; eher „bewusst nicht“ (Frage 5) | L |

### M · Meeting Notes

| Bereich | Aktion | Wo in der Oberfläche | Werkzeug heute | Lücke | Vorschlag | Aufwand |
| --- | --- | --- | --- | --- | --- | --- |
| Meetings | M1 Meeting anlegen | ⌘N „Meeting notes“, Slash | – | fehlt | `create_page { kind: "meeting" }` bzw. `add meeting` in `edit_blocks` | S |
| Meetings | M2 Meetings auflisten | Library „Meetings“ | `search` findet Seiten | Liste mit Datum, Dauer, Zustand fehlt | `list_meetings` | S |
| Meetings | M3 Notizen, Zusammenfassung, Transkript lesen | Reiter im Block | `read_page` (prüfen, was vom Block ankommt) | Transkript kann sehr lang sein, Zeitmarken und Sprecher | `read_meeting { id, part, from?, limit? }` | M |
| Meetings | M4 Notizen und Zusammenfassung schreiben | Tippen | – | fehlt | `edit_blocks` in den Abschnitten; Zusammenfassung als eigener Abschnitt | M |
| Meetings | M5 Sprecher benennen, Kontext anhängen | Block | – | fehlt | `update_meeting { speakers, context }` | M |
| Meetings | M6 Aufnahme starten/stoppen, später transkribieren, Modell laden | Block, Pop-up, Settings | – | bewusst nicht | Mikrofon und Modell gehören dem Gerät; ein Agent darf nicht aufnehmen. | – |
| Meetings | M7 Aufnahme abspielen | Block | – | bewusst nicht | Wiedergabe am Gerät. | – |

### B · Agent Brain, Inbox, Home, Projekte

| Bereich | Aktion | Wo in der Oberfläche | Werkzeug heute | Lücke | Vorschlag | Aufwand |
| --- | --- | --- | --- | --- | --- | --- |
| Brain | B1 Erinnerungen lesen, About me | Agent Brain | `recall`, `about_me` | – | erledigt (nur MCP; eigene Agenten haben `recall_memories`, `semantic_search`, `related_pages`, also drei Namen für dasselbe → G1) | – |
| Brain | B2 Erinnerung speichern, ersetzen | Agent Brain | `remember { replaces }` | – | erledigt | – |
| Brain | B3 Erinnerung freigeben („To review“), löschen | Memories-Datenbank | `update_row`/`trash_page` auf der Zeile | Freigabe privater Fakten darf ein Agent nicht selbst geben | bewusst nicht für „To review → freigegeben“ (Entscheidung 18.11.); Regel im Werkzeug festhalten und testen | S |
| Brain | B4 Skills lesen | Settings → Agents & AI | `list_skills`, `load_skill`, Prompts | Dateien eines Skills (`read_skill_file`) fehlen | nachziehen | S |
| Brain | B5 Skill anlegen, ändern, ein/aus, importieren | Settings → Agents & AI | Skills sind Seiten → `create_page` | ein/aus und Import fehlen | offen (Frage 3: darf ein Agent seine eigenen Anweisungen ändern?) | M |
| Inbox | B6 Inbox lesen, beantworten | Home, Inbox | `inbox`, `resolve_inbox` | – | erledigt | – |
| Inbox | B7 Agent per @ ansprechen, Frage stellen | Inbox-Format (Vaultite) | `ask_main_agent` | Frage an den Nutzer aus MCP heraus fehlt | `ask_user { question, options? }` → Inbox | S |
| Home | B8 Projekte lesen, anlegen, Status | Home, Projekt-Ansicht | `list_projects`, `get_project`, `create_project`, `update_project_status` | Ziel, Budget, Ordner ändern; archivieren | `update_project` | S |
| Home | B9 Läufe lesen | Home, Agent-Ansicht | `list_runs`, `get_run` | – | erledigt | – |
| Home | B10 Aufgaben-Karten, Zeitpläne (Cron) | Home, Tasks | – | anlegen, ändern, löschen fehlt | `list_schedules`, `update_schedule`; Karten über `ask_main_agent` | M |
| Home | B11 Fällige Aufgaben | Home rechts | `query_database` je Datenbank | kein „was ist fällig“ über alle | `due { from, to }` (Logik gibt es: `dueItems`) | S |
| Home | B12 Captures | Quick capture | nur Swift | fehlt im TS-Server | `capture`, `list_captures`, `file_capture` nachziehen, sobald Captures in Based Next da sind | M |
| Home | B13 Zeitraum wählen, Begrüßung | Home | – | bewusst nicht | Darstellung. | – |
| Chat | B14 Chats lesen, Coding-Sitzungen steuern | Chat, Coding | Host-Werkzeuge nur Swift | fehlt im TS-Server | zurückgestellt: AI-Schalter ist für die Beta aus (12.11.) | L |

### T · Teilen und Rechte

| Bereich | Aktion | Wo in der Oberfläche | Werkzeug heute | Lücke | Vorschlag | Aufwand |
| --- | --- | --- | --- | --- | --- | --- |
| Teilen | T1 Sehen, wer Zugriff hat | „Share“ | – | fehlt | `list_shares { id }` (lesend) | S |
| Teilen | T2 Link anlegen (view, comment, edit), Einladung | „Share a link“, „Create invite“ | – | fehlt | `share_page`; offen (Frage 3) | M |
| Teilen | T3 Zugriff entziehen, Rolle ändern | „Revoke“, „Remove“ | – | fehlt | `revoke_share`; Entziehen ist die sichere Richtung | S |
| Teilen | T4 Im Web veröffentlichen, Embeds erlauben | „Publish to web“ | – | fehlt | `publish_page`; offen (Frage 3) | M |
| Teilen | T5 Kommentare | – | – | gibt es in Based noch nicht | kommt mit Multi-User (Entscheidung 11.11.) | – |

### X · Einstellungen

| Bereich | Aktion | Wo in der Oberfläche | Werkzeug heute | Lücke | Vorschlag | Aufwand |
| --- | --- | --- | --- | --- | --- | --- |
| Einstellungen | X1 Darstellung: Theme, Schrift, Dichte, Sprache, Feel | Settings → App | – | bewusst nicht | Gelten je Gerät und liegen nicht im Workspace. | – |
| Einstellungen | X2 Seiten: was zuerst öffnet, wie neue Seiten starten | Settings → Pages | – | fehlt | nur wenn im Workspace gespeichert: `get_settings`/`set_setting` mit fester Liste | S |
| Einstellungen | X3 Agenten-Regeln, Rechte-Stufe (Private/Balanced/Open), API-Schlüssel | Settings → Agents & AI | – | bewusst nicht | Ein Agent darf seine eigenen Grenzen und Schlüssel nie ändern. Lesen der geltenden Regeln („was darf ich?“) als `based_guide safety`. | S |
| Einstellungen | X4 Verbindungen (MCP-Server) | Settings → Connections | `list_connections` nur Swift | lesen fehlt; anlegen bewusst nicht | `list_connections` nachziehen | S |
| Einstellungen | X5 Sync & Server, Backups, iCloud, Tailnet, Updates, Diagnose | Settings → Workspace/System | – | bewusst nicht | Betreffen Gerät, Zugangsdaten oder Datensicherheit. Lesend: Sync-Zustand in `based_guide overview` genügt. | – |
| Einstellungen | X6 Workspace zurücksetzen, Undo-Verlauf leeren | Settings → General (noch nicht gebaut) | – | bewusst nicht | Nicht umkehrbar. | – |

## Zählung

| Bereich | Zeilen | erledigt | Lücke | bewusst nicht | offen |
| --- | --- | --- | --- | --- | --- |
| Grundlage | 4 | 0 | 4 | 0 | 0 |
| Editor | 37 | 2 | 30 | 3 | 2 (E33 → M1, E35) |
| Datenbanken | 23 | 3 | 18 | 2 | 0 |
| Shell | 23 | 6 | 12 | 4 | 1 (S13) |
| Verlauf, Export, Import | 7 | 0 | 5 | 1 | 1 (V7) |
| Meetings | 7 | 0 | 5 | 2 | 0 |
| Brain, Inbox, Home | 14 | 4 | 7 | 2 | 1 (B5) |
| Teilen | 5 | 0 | 2 | 0 | 3 (T2, T4, T5) |
| Einstellungen | 6 | 0 | 2 | 4 | 0 |

## Nicht geprüft

- Diese Liste stammt aus dem Code (Menüs, Slash-Liste, Worker-Protokoll, Tastatur-Register, `docs/*.md`), nicht aus
  der laufenden App. Was nur per Ziehen oder Hover erreichbar ist und in keiner dieser Quellen steht, kann fehlen.
- `registerContextItems` wird nur an zwei Stellen aufgerufen (freie Fläche in `App.tsx`, Board). Die übrigen Menüs
  (Sidebar, Seitenmenü, Blockmenü, Datenbank) sind eigene Komponenten; ihre Einträge sind aus den Dateien gelesen.
- Ob jeder vorhandene Schreib-Aufruf genau eine Transaktion ist (G4) und ob Agenten in gesperrte Seiten schreiben
  können (S8), ist gelesen, nicht mit einem Test belegt.
- Whiteboard: nicht erneut geprüft, gilt laut Auftrag als Vorbild (Stand 18.11.).
