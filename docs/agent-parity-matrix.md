# Agent-Parität: Matrix

Bestandsaufnahme vom 18.11.2026, gelesen auf `main` (f07b0bf) plus `feat/board-markdown` (f27f9b9, dort liegt der
Auftrag `docs/agent-parity.md`). Wird je Eintrag fortgeschrieben (Lücke → „erledigt“).

**Stand 18.11., Nacht:** Alle sieben Einträge sind gebaut, bis auf das, was unten unter „Noch offen“ steht. Schritt 2
ist entschieden, siehe „Entscheidungen“. Die vier Punkte „Was vor der Matrix zu wissen ist“ beschreiben den Stand vor
dem Umbau.

**Nachtrag 18.11., später:** Import als Werkzeug (`import_files`, `notion_import`; der Importer liegt jetzt im Kern),
die kurze Werkzeugliste auch für die App-eigenen Agenten und Server-Läufe, Skills (`read_skill_file`, `save_skill`),
Formular-Fragen (`update_view { form }`) und „Undo“ an jeder Agenten-Aktion im Chat sind gebaut.

**Noch offen** (jeweils eigener Backlog-Eintrag):
- B7 `ask_user`: braucht ein Antwortfeld in der Inbox (die Freigabe-Karte kann nur Allow/Deny).
- V7 Notion-Import: als Werkzeug gibt es den Weg über die Notion-API (Token am Server, `BASED_NOTION_TOKEN`). Der
  Hybrid-Weg (Export-ZIP plus API) und Pausieren fehlen; ein Notion-ZIP allein geht über `import_files`.
- V3 PDF-Export (der Server hat keinen Browser zum Drucken), B12 Captures (gibt es in Based Next noch nicht),
  B14 Coding-Sitzungen, B10 Zeitplan anlegen.
- D11 Datumsformat, D12 Status-Gruppen, D14 verschachtelte Filter, S1/S18 Sortierung und Dubletten, S17 Graph mit
  Tiefe, T4 Embeds, X2 Workspace-Einstellungen.
- Rechte-Stufen Private/Balanced/Open gibt es in Based noch nicht. Bis dahin gilt: „Work freely“ = Open, alles andere
  fragt beim Freigeben und bei Skills in der Inbox.
- „Undo“ im Chat gilt, solange die App läuft; nach einem Neustart bleibt der Versionsverlauf der Seite.

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

## Entscheidungen (Elija, 18.11.2026, Schritt 2)

1. **Reihenfolge und Zeitpunkt entscheidet Fable; es soll fertig werden.** Festgelegt: G (eine Schicht, Einordnung,
   Doku) → Editor → Datenbanken → Shell → Verlauf/Export/Import → Meetings/Brain/Home → Teilen/Einstellungen.
   Start sofort, jeder Eintrag geht mit grünem `ts-fast` nach main. Was bis zum Freeze (Fr 20.11.) nicht grün ist,
   wartet auf einem Branch bis nach der Beta (Mo 23.11.).
2. **Form der Werkzeuge entscheidet Fable.** Festgelegt: Editor als `read_blocks` + `edit_blocks` (Skript, wie
   `draw_board`); Datenbanken ohne Skript, die vorhandenen Werkzeuge werden erweitert. Ein Argumentname für Seiten:
   `id` (so kennen es die MCP-Clients); `page_id` bleibt als Alias, bis die eigenen Agenten umgestellt sind.
3. **Was ein Agent ohne Rückfrage darf, hängt an der Rechte-Stufe** (Private / Balanced / Open, Standard Balanced).
   **Endgültig löschen fragt immer einen Menschen**, in jeder Stufe. Umsetzung:

   | Aktion | Private | Balanced | Open |
   | --- | --- | --- | --- |
   | Lesen, Schreiben in Seiten und Datenbanken, Papierkorb (rückholbar) | nach den Regeln der Stufe | ja | ja |
   | Endgültig löschen, Papierkorb leeren, Teamspace löschen, Property mit Werten löschen | Frage in der Inbox | Frage in der Inbox | Frage in der Inbox |
   | Link anlegen, veröffentlichen, Einladung | nein | Frage in der Inbox | ja |
   | Zugriff entziehen | ja | ja | ja |
   | Skills anlegen und ändern, Workspace-Einstellungen | Frage in der Inbox | Frage in der Inbox | ja |
   | Eigene Rechte-Stufe, Regeln, API-Schlüssel, Sync-Zugang | nein | nein | nein |

   „Frage in der Inbox“ heißt: das Werkzeug führt nichts aus, legt die Frage an (`ask`-Weg, `resolve_inbox`) und
   meldet dem Agenten die Kennung; nach der Freigabe läuft genau dieser Aufruf. Die letzte Zeile ist die einzige
   Ausnahme von „alles, was der Mensch kann“: sonst könnte ein Agent die Tabelle selbst umschreiben.
4. **Undo für Agenten: ja.** `undo_last` nimmt den eigenen letzten Schreib-Aufruf zurück (weil jeder Aufruf eine
   Transaktion ist). Dazu in Based selbst: an jeder Agenten-Aktion im Chat ein „Undo“, mit dem der Mensch genau
   diesen Schritt zurückklickt, auch wenn danach schon weitergearbeitet wurde (wo das nicht sauber geht, sagt Based
   warum und bietet den Versionsverlauf der Seite an).
5. **Import und Export: alles, auch Dateien.** Jedes Format, das die App kann, in beide Richtungen; Dateien über
   Refs (`upload_file`, `list_files`) und über stdio als Pfad. Auch der Notion-Import (Hybrid und API) ist ein
   Werkzeug; das Token muss der Mensch einmal in den Einstellungen hinterlegt haben, der Agent bekommt es nie zu sehen.
6. **Der Agent hat auf alles Zugriff.** Elija: „genau das tun, was ein Mensch auch tun kann: Sachen designen,
   HTML schreiben, Datenbanken mit Visualisierungen erstellen, die Anordnung der Datenbanken verändern, den kompletten
   Workspace umgraben.“ Damit entfällt „bewusst nicht“ für alles, was Daten des Workspaces ändert. Es bleibt nur für
   das, was dem Gerät gehört (Fenster, Theme, Mikrofon) und für die letzte Zeile der Tabelle oben.

Damit ändern sich gegenüber der ersten Fassung: S13 (endgültig löschen: Werkzeug mit Inbox-Frage), E35 (Undo: ja),
V7 (Notion-Import: ja), T2/T4 (Teilen: nach Stufe), B5 (Skills: nach Stufe), X2 (Workspace-Einstellungen: ja), D18
und E23 rücken nach vorn (Visualisierungen, HTML). M6 bleibt: aufnehmen kann nur das Gerät.

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
| Grundlage | G1 Eine Werkzeug-Schicht | – | zwei Schichten (siehe oben) | erledigt | erledigt 18.11.: alle Werkzeuge in `packages/brain/src/tools/`, `mcp.ts` meldet nur an; ein Argumentname `id` (alte Namen gehen weiter) | – |
| Grundlage | G2 Einordnung der Schreib-Werkzeuge | – | `readOnlyHint`/`destructiveHint` von Hand | erledigt | erledigt 18.11.: `write`/`destructive` an der Definition, Test prüft die Listen | – |
| Grundlage | G3 `docs/mcp.md` stimmt | – | beschreibt Swift-Stand mit | erledigt | erledigt 18.11. | – |
| Grundlage | G4 Undo je Aufruf | ⌘Z | – | erledigt | erledigt 18.11.: `store.atomic` um jeden Schreib-Aufruf, dazu `undo_last` | – |

### E · Seiten-Editor

| Bereich | Aktion | Wo in der Oberfläche | Werkzeug heute | Lücke | Vorschlag | Aufwand |
| --- | --- | --- | --- | --- | --- | --- |
| Editor | E1 Seite lesen | Seite | `read_page` (Markdown) | erledigt | erledigt 18.11.: `read_blocks` | – |
| Editor | E2 Text ans Ende schreiben | Tippen | `append_markdown` | – | bleibt | – |
| Editor | E3 Block an einer Stelle einfügen | Enter, Slash, „+“ | – | erledigt | erledigt 18.11.: `edit_blocks`, `{after= before= in=}` | – |
| Editor | E4 Text eines Blocks ändern | Tippen | `find_replace` (Textstelle) | erledigt | erledigt 18.11.: `set h: Text` | – |
| Editor | E5 Fett, kursiv, Code, Link, Textfarbe | Format-Popup, ⌘B … | Markdown beim Schreiben | Textfarbe und Hintergrund im Text nicht ausdrückbar | Markdown bleibt; Farbe als `==`-artige Schreibweise erst bei Bedarf | M |
| Editor | E6 Block löschen | ⌫, Blockmenü „Delete“ | `replace_page_content` (alles) | erledigt | erledigt 18.11.: `del` | – |
| Editor | E7 Block duplizieren | ⌘D, Blockmenü | – | erledigt | erledigt 18.11.: `dup` | – |
| Editor | E8 Block verschieben (in der Seite) | Griff ziehen, ⌘⇧↑/↓ | – | erledigt | erledigt 18.11.: `move` | – |
| Editor | E9 Einrücken, ausrücken, verschachteln | Tab, ⇧Tab, Ziehen | Markdown-Einrückung beim Schreiben | erledigt | erledigt 18.11.: `indent`, `outdent`, `move … {in=}` | – |
| Editor | E10 Spalten 2–5, Breiten | Slash, Ziehen an den Rand | – | erledigt | erledigt 18.11.: `{left= right=}`, `cols`, `{ratio=}`, `uncols` | – |
| Editor | E11 Turn into (inkl. Toggle-Überschrift, Section, Gleichung) | Blockmenü, ⌘⌥0–8 | – | erledigt | erledigt 18.11.: `set h {type=…}` | – |
| Editor | E12 Turn into page | Blockmenü, ⌘⌥9 | – | erledigt | erledigt 18.11.: `set h {type=page}` | – |
| Editor | E13 Block in andere Seite verschieben | Blockmenü „Move to“, ⌘⇧P | – | erledigt | erledigt 18.11.: `move h {page=<id>}` | – |
| Editor | E14 Blockfarbe | Blockmenü „Color“ | Callout-Farbe über `> [!NOTE]` | erledigt | erledigt 18.11.: `{color=}` / `{bg=}` | – |
| Editor | E15 To-do abhaken, Toggle auf/zu | Klick, ⌘Enter | `find_replace` trifft `[ ]` nicht | erledigt | erledigt 18.11.: `check`, `uncheck`, `{open=}` | – |
| Editor | E16 Callout-Icon | Emoji-Picker | Markdown-Callout (festes Icon) | erledigt | erledigt 18.11.: `{icon=}` | – |
| Editor | E17 Code: Sprache, Umbruch | Leiste am Block | Sprache über Code-Zaun | erledigt | erledigt 18.11.: `{lang= wrap}` | – |
| Editor | E18 Bild einfügen (Upload, Link), Breite, Ausrichtung, Unterschrift | Slash, Ablegen, Bildleiste | Bild per Link im Markdown; `upload_file` legt nur aufs Board | erledigt | erledigt 18.11.: `linked: <Datenbank-ID> {view=}` | – |
| Editor | E19 Video, Audio, Datei, PDF einfügen | Slash, Ablegen | – | erledigt | erledigt 18.11.: `file: <ref>` (Art aus der Datei), `video`, `audio`, `pdf` | – |
| Editor | E20 Web-Bookmark, Embed | Slash, URL einfügen | – | erledigt | erledigt 18.11.: `synced:`, `sync`, `unsync` | – |
| Editor | E21 Einfache Tabelle: Zellen, Zeile/Spalte | Tabelle | Markdown-Tabelle beim Anlegen | erledigt | erledigt 18.11.: `table`, `cell`, `row`, `col` | – |
| Editor | E22 Gleichung (Block, inline) | Slash | `$$…$$`, `$…$` im Markdown | erledigt | erledigt 18.11.: `equation:` und Markdown | – |
| Editor | E23 Mermaid, HTML-Block (Code/Ergebnis zeigen) | Slash, Blockleiste | Code-Zaun `mermaid`/`html`; `add_html`/`add_mermaid` nur Swift | erledigt | erledigt 18.11.: `code: … {lang=html show=result}` | – |
| Editor | E24 Unterseite, Inline-Datenbank, Whiteboard im Inhalt | Slash „Page“, „Database“, „Whiteboard“ | `create_page {parent}`, `create_database {inline}`, `draw_board {parent}` | erledigt | erledigt 18.11.: `page`, `database`, `board` an jeder Stelle über `edit_blocks` | – |
| Editor | E25 Linked view of database | Slash | – | erledigt | erledigt 18.11.: `button: Label {add= open= url= confirm= insert}` | – |
| Editor | E26 Synced Block (Copy and sync, Unsync) | Blockmenü | – | erledigt | erledigt 18.11.: Datums-Erwähnung `@2026-11-20[ 14:00][ → …][ (remind)]` | – |
| Editor | E27 Button-Block mit Schritten | Slash „Button“, „Edit“ | `add_button` nur Swift | erledigt | erledigt 18.11.: Bookmark-Vorschau holt der Server | – |
| Editor | E28 Inhaltsverzeichnis, Trenner | Slash | Trenner `---` | erledigt | erledigt 18.11.: `toc`, `divider` | – |
| Editor | E29 Erwähnung (Seite, Datum, Erinnerung) | `@`, `[[` | Seite über `[Titel](based://page/<id>)` | erledigt | erledigt 18.11.: `upload_file { page, after, caption }` | – |
| Editor | E30 Unverlinkte Erwähnung verlinken | Backlinks „Link“ | – | fehlt | `link_mention` oder Teil von `edit_blocks` | S |
| Editor | E31 Link auf einen Block kopieren | Blockmenü | – | Kennung fehlt | teils 18.11.: Kennung da; offen: Link `based://page/<id>#<block>` in der Antwort | S |
| Editor | E32 Als Markdown kopieren | ⌘C, Blockmenü | `read_page` | – | erledigt | – |
| Editor | E33 Meeting-Block anlegen | Slash „Meeting notes“, ⌘N | – | erledigt | erledigt 18.11.: `meeting: Titel` | – |
| Editor | E34 Ask AI im Text | Leertaste, Slash, Formatleiste | – | bewusst nicht | Der Agent ist selbst das Modell; er schreibt über `edit_blocks`. | – |
| Editor | E35 Undo/Redo | ⌘Z; „Undo“ an der Agenten-Aktion im Chat | – | erledigt | erledigt 18.11.: `undo_last` für den Agenten; im Chat ein „Undo“ an jeder schreibenden Aktion (`ToolResult.undo`, `undoByToken`) | – |
| Editor | E36 Blockauswahl, Schreibmarke, Suchen in der Seite, Gliederung ein/aus | Esc, ⌘F, Seitenmenü | – | bewusst nicht | Rein visuell; `search` und `read_blocks` decken das Finden ab. | – |
| Editor | E37 Echtzeit-Präsenz | Cursor anderer | – | bewusst nicht | Kein Dateninhalt. | – |

### D · Datenbanken

| Bereich | Aktion | Wo in der Oberfläche | Werkzeug heute | Lücke | Vorschlag | Aufwand |
| --- | --- | --- | --- | --- | --- | --- |
| Datenbank | D1 Datenbanken und Schema lesen | – | `list_databases`, `database_schema` | – | erledigt (nur MCP, siehe G1) | – |
| Datenbank | D2 Zeilen lesen | Ansicht | `query_database { search, sort }` | erledigt | erledigt 18.11.: `query_database { view, filters, filter_mode, properties }`; Fußzeile der Ansicht als „Calculations: …“ | – |
| Datenbank | D3 Zeile anlegen, Werte setzen | „New“, Zelle | `add_row`, `update_row` | erledigt | erledigt 18.11.: Relation über Zeilen-ID oder Titel (Gegenseite wird mitgeführt), Person, Dateien (Ref oder Link), Ort als Text | – |
| Datenbank | D4 Viele Zeilen auf einmal | Einfügen, Autofill, Mehrfachauswahl | – | erledigt | erledigt 18.11.: `add_rows`, `update_rows` (alles oder nichts, ein Undo-Schritt) | – |
| Datenbank | D5 Zeile löschen, duplizieren, verschieben | Zeilenmenü | `trash_page`, `duplicate_page` (Zeile ist Seite) | nicht dokumentiert, nicht getestet für Zeilen | Test + Hinweis in der Beschreibung | S |
| Datenbank | D6 Zeile als Seite schreiben | Zeile öffnen | `append_markdown`, `read_page` | – | erledigt | – |
| Datenbank | D7 Datenbank anlegen, umbenennen | Slash, ⌘N | `create_database`, `update_database` | – | erledigt (nur MCP) | – |
| Datenbank | D8 Property anlegen, umbenennen, Typ, löschen | Property-Menü | `update_database` | erledigt | erledigt 18.11.: `update_database` ist als zerstörend markiert | – |
| Datenbank | D9 Formel | Property-Menü „Formula“ | Typ anlegbar | erledigt | erledigt 18.11.: `update_database { formulas }`; Fehler nennt die Stelle | – |
| Datenbank | D10 Relation und Rollup einrichten | Property-Menü | Typ anlegbar | erledigt | erledigt 18.11.: `update_database { relations, two_way, rollups }` | – |
| Datenbank | D11 Zahlen- und Datumsformat, ID-Präfix, Beschreibung | Property-Menü | – | erledigt | erledigt 18.11.: `update_database { number_formats, id_prefixes, descriptions }`; Datumsformat offen | – |
| Datenbank | D12 Optionen: Farbe, umbenennen, löschen, Reihenfolge, Status-Gruppen | Property-Menü | `add_options` | erledigt | erledigt 18.11.: `update_database { update_options, option_order }` (umbenennen, Farbe, löschen, Reihenfolge); Status-Gruppen offen | – |
| Datenbank | D13 Ansicht anlegen, umbenennen, löschen | Reiter, „Add view“ | `create_view`, `update_view`, `delete_view`, `list_views` | erledigt | erledigt 18.11.: `list_views` ist lesend markiert | – |
| Datenbank | D14 Filter, Sortierung, Gruppierung | Filter, Sort, Group | `update_view` | erledigt | erledigt 18.11.: `update_view { hide_empty_groups, date_grouping }`; verschachtelte Filtergruppen und Untergruppen offen | – |
| Datenbank | D15 Sichtbare Properties, Reihenfolge, Spaltenbreite, Umbruch | View settings „Properties“, Ziehen | – | erledigt | erledigt 18.11.: `update_view { properties, wrap }` | – |
| Datenbank | D16 Layout-Optionen (Karten-Vorschau, -Größe, Datums-Property, Zeitraum, Karte, „Open pages in“, Titel und Icon zeigen) | View settings | – | erledigt | erledigt 18.11.: `update_view { card_preview, card_size, date_property, end_date_property, map_property, open_in, show_icons, show_title, limit }` | – |
| Datenbank | D17 Berechnungen (Summe, Anzahl …) | Tabellenfuß | – | erledigt | erledigt 18.11.: `update_view { calculations }`; `query_database { view }` gibt sie aus | – |
| Datenbank | D18 Chart und Dashboard-Widgets | View settings „Chart“, „Widgets“ | `create_chart` nur Swift; `create_view type=chart` ohne Achsen | erledigt | erledigt 18.11.: `update_view { chart, add_widgets }` | – |
| Datenbank | D19 Formular-Ansicht | Form | `create_view type=form` | erledigt | erledigt 18.11.: `update_view { form: { title, description, questions } }`; welche Properties gefragt werden: `properties` | – |
| Datenbank | D20 Zeilen-Vorlagen | „New“ ▾, „Templates“ | – | erledigt | erledigt 18.11.: `update_database { add_templates, delete_templates, default_template }`, `add_row { template }` | – |
| Datenbank | D21 Datenbank sperren | View settings „Lock database“ | – | erledigt | erledigt 18.11.: `update_database { locked }` | – |
| Datenbank | D22 Als ganze Seite öffnen, Zeilen-Vorschau, Suche in der Ansicht | Kopfzeile | – | bewusst nicht | Rein visuell; `query_database { search }` deckt die Suche. | – |
| Datenbank | D23 Karte: Ort suchen (Geocoding) | Ort-Zelle | – | bewusst nicht | Geocoding nur über den Knopf (Entscheidung 10.11.); der Agent setzt Text oder Koordinaten. | – |

### S · Shell, Seitenmenü, Library

| Bereich | Aktion | Wo in der Oberfläche | Werkzeug heute | Lücke | Vorschlag | Aufwand |
| --- | --- | --- | --- | --- | --- | --- |
| Shell | S1 Suchen | ⌘K | `search`, `recall` | erledigt | erledigt 18.11.: `search { kind, edited_after, edited_before }`; Sortierung offen | – |
| Shell | S2 Seitenbaum lesen | Sidebar | `list_pages` | erledigt | erledigt 18.11.: `list_pages` nennt den Bereich, `section`; `get_workspace` | – |
| Shell | S3 Seite anlegen (auch aus Vorlage) | ⌘N, „+“, Starter-Vorlagen | `create_page` | erledigt | erledigt 18.11.: `create_page { section, after, template }` | – |
| Shell | S4 Umbenennen, Emoji-Icon | Titel, Icon | `update_page` | – | erledigt | – |
| Shell | S5 Icon aus Phosphor (mit Farbe) oder Bild | Icon-Picker „Icons“ | – | erledigt | erledigt 18.11.: `update_page { icon }` (Phosphor, Datei-Adresse, Bild-Link) | – |
| Shell | S6 Cover: Farbe, Verlauf, Bild, Link, Höhe, Position | „Change cover“ | nur `remove_cover` | erledigt | erledigt 18.11.: `update_page { cover, cover_height, cover_position }`; Farb- und Verlaufsliste jetzt im Kern | – |
| Shell | S7 Schrift, Small text, Full width | Seitenmenü | nur beim Anlegen in der App | erledigt | erledigt 18.11.: `update_page { font, small_text, full_width }` | – |
| Shell | S8 Seite sperren | Seitenmenü „Lock page“ | – | erledigt | erledigt 18.11.: `update_page { locked }`; jedes inhaltsändernde Werkzeug lehnt gesperrte Seiten ab | – |
| Shell | S9 Verschieben in Seite | Ziehen, „Move to…“ | `move_page` | erledigt | erledigt 18.11.: `move_page { ids, parent_id \| section, before \| after }` | – |
| Shell | S10 Duplizieren | Menü | `duplicate_page` | – | erledigt (nur MCP) | – |
| Shell | S11 Favoriten | Seitenmenü, Sidebar | `set_favorite` | Reihenfolge der Favoriten | bewusst nicht (persönliche Anordnung), sonst `after` | – |
| Shell | S12 Papierkorb: hinein, zurück, Liste | Menü, Trash | `trash_page`, `restore_page`, `list_trash` | – | erledigt (nur MCP) | – |
| Shell | S13 Endgültig löschen, Papierkorb leeren | Trash „Delete forever“, „Empty Trash“ | – | erledigt | erledigt 18.11.: `delete_forever`, `empty_trash`: legen eine Rückfrage an („Needs you“), laufen erst nach Allow in Based; `resolve_inbox` von außen lehnt sie ab | – |
| Shell | S14 Teamspaces: anlegen, umbenennen, Icon, löschen | Sidebar | – | erledigt | erledigt 18.11.: `create_teamspace`, `update_teamspace`, `delete_teamspace` (zerstörend markiert, Seiten wandern nach Private) | – |
| Shell | S15 Workspace-Name und -Icon | Sidebar-Kopf | – | erledigt | erledigt 18.11.: `update_workspace` | – |
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
| Verlauf | V1 Versionen ansehen | Seitenmenü „Version history“ | – | erledigt | erledigt 18.11.: `page_history`, `read_version` (in der App; der Server führt keinen Verlauf) | – |
| Verlauf | V2 Version wiederherstellen | „Restore“ | – | erledigt | erledigt 18.11.: `restore_version` (in der App) | – |
| Export | V3 Seite exportieren (Markdown, HTML, PDF, Word, JSON, OPML, Archiv) | „Export…“ | `read_page` (Markdown als Text) | erledigt | erledigt 18.11.: `export_page { format: markdown, html, docx, json, opml; subpages; path }` am Server → Datei-Adresse, über stdio auch Pfad; PDF offen | – |
| Export | V4 Ganzen Workspace exportieren | Settings → Import | – | erledigt | erledigt 18.11.: `export_workspace { format: markdown, html, archive }` am Server | – |
| Export | V5 Drucken | ⌘P | – | bewusst nicht | Gerät. PDF deckt V3. | – |
| Import | V6 Dateien importieren (Markdown, HTML, Word, Notion-ZIP, Obsidian, Logseq, Bear, Evernote, OPML, Archiv) | ⌘N „Import“, Settings | `create_page { markdown }` | erledigt | erledigt 18.11.: `import_files { refs, text + name, path (stdio), parent }` mit den Importern der App (Kern: `interop/prepare-files.ts`) | – |
| Import | V7 Notion-Import (Hybrid, API) starten, pausieren, Stand lesen | Settings → Import | – | fehlt | teils 18.11.: `notion_import { action: start \| status \| cancel, links, parent }` über die Notion-API; Hybrid und Pause offen | L |

### M · Meeting Notes

| Bereich | Aktion | Wo in der Oberfläche | Werkzeug heute | Lücke | Vorschlag | Aufwand |
| --- | --- | --- | --- | --- | --- | --- |
| Meetings | M1 Meeting anlegen | ⌘N „Meeting notes“, Slash | – | erledigt | erledigt 18.11.: `edit_blocks` mit `meeting: Titel` | – |
| Meetings | M2 Meetings auflisten | Library „Meetings“ | `search` findet Seiten | erledigt | erledigt 18.11.: `list_meetings` | – |
| Meetings | M3 Notizen, Zusammenfassung, Transkript lesen | Reiter im Block | `read_page` (prüfen, was vom Block ankommt) | erledigt | erledigt 18.11.: `read_meeting { part: overview \| transcript, offset, limit }` | – |
| Meetings | M4 Notizen und Zusammenfassung schreiben | Tippen | – | erledigt | erledigt 18.11.: Notizen über `edit_blocks {in=<Abschnitt>}` (die Kennung nennt `read_meeting`), Zusammenfassung über `update_meeting { summary }` | – |
| Meetings | M5 Sprecher benennen, Kontext anhängen | Block | – | erledigt | erledigt 18.11.: `update_meeting { speakers, add_context, remove_context }` | – |
| Meetings | M6 Aufnahme starten/stoppen, später transkribieren, Modell laden | Block, Pop-up, Settings | – | bewusst nicht | Mikrofon und Modell gehören dem Gerät; ein Agent darf nicht aufnehmen. | – |
| Meetings | M7 Aufnahme abspielen | Block | – | bewusst nicht | Wiedergabe am Gerät. | – |

### B · Agent Brain, Inbox, Home, Projekte

| Bereich | Aktion | Wo in der Oberfläche | Werkzeug heute | Lücke | Vorschlag | Aufwand |
| --- | --- | --- | --- | --- | --- | --- |
| Brain | B1 Erinnerungen lesen, About me | Agent Brain | `recall`, `about_me` | – | erledigt (nur MCP; eigene Agenten haben `recall_memories`, `semantic_search`, `related_pages`, also drei Namen für dasselbe → G1) | – |
| Brain | B2 Erinnerung speichern, ersetzen | Agent Brain | `remember { replaces }` | – | erledigt | – |
| Brain | B3 Erinnerung freigeben („To review“), löschen | Memories-Datenbank | `update_row`/`trash_page` auf der Zeile | Freigabe privater Fakten darf ein Agent nicht selbst geben | bewusst nicht für „To review → freigegeben“ (Entscheidung 18.11.); Regel im Werkzeug festhalten und testen | S |
| Brain | B4 Skills lesen | Settings → Agents & AI | `list_skills`, `load_skill`, Prompts | erledigt | erledigt 18.11.: `read_skill_file` | – |
| Brain | B5 Skill anlegen, ändern, ein/aus, importieren | Settings → Agents & AI | Skills sind Seiten → `create_page` | erledigt | erledigt 18.11.: `save_skill { name, description, body, enabled }`; ohne „Work freely“ Rückfrage in der Inbox | – |
| Inbox | B6 Inbox lesen, beantworten | Home, Inbox | `inbox`, `resolve_inbox` | – | erledigt | – |
| Inbox | B7 Agent per @ ansprechen, Frage stellen | Inbox-Format (Vaultite) | `ask_main_agent` | Frage an den Nutzer aus MCP heraus fehlt | `ask_user { question, options? }` → Inbox | S |
| Home | B8 Projekte lesen, anlegen, Status | Home, Projekt-Ansicht | `list_projects`, `get_project`, `create_project`, `update_project_status` | erledigt | erledigt 18.11.: `update_project { name, goal, status, budget_eur }` | – |
| Home | B9 Läufe lesen | Home, Agent-Ansicht | `list_runs`, `get_run` | – | erledigt | – |
| Home | B10 Aufgaben-Karten, Zeitpläne (Cron) | Home, Tasks | – | anlegen, ändern, löschen fehlt | teils 18.11.: `list_schedules`, `update_schedule` (an/aus, wann, was, löschen); anlegen über `ask_main_agent` | M |
| Home | B11 Fällige Aufgaben | Home rechts | `query_database` je Datenbank | erledigt | erledigt 18.11.: `due { from, to }` | – |
| Home | B12 Captures | Quick capture | nur Swift | fehlt im TS-Server | `capture`, `list_captures`, `file_capture` nachziehen, sobald Captures in Based Next da sind | M |
| Home | B13 Zeitraum wählen, Begrüßung | Home | – | bewusst nicht | Darstellung. | – |
| Chat | B14 Chats lesen, Coding-Sitzungen steuern | Chat, Coding | Host-Werkzeuge nur Swift | fehlt im TS-Server | zurückgestellt: AI-Schalter ist für die Beta aus (12.11.) | L |

### T · Teilen und Rechte

| Bereich | Aktion | Wo in der Oberfläche | Werkzeug heute | Lücke | Vorschlag | Aufwand |
| --- | --- | --- | --- | --- | --- | --- |
| Teilen | T1 Sehen, wer Zugriff hat | „Share“ | – | erledigt | erledigt 18.11.: `list_shares` (HTTP-Server) | – |
| Teilen | T2 Link anlegen (view, comment, edit), Einladung | „Share a link“, „Create invite“ | – | erledigt | erledigt 18.11.: `share_page { kind: link \| invite }`: ohne „Work freely“ Rückfrage in der Inbox, der Server führt nach Allow aus | – |
| Teilen | T3 Zugriff entziehen, Rolle ändern | „Revoke“, „Remove“ | – | erledigt | erledigt 18.11.: `revoke_share` | – |
| Teilen | T4 Im Web veröffentlichen, Embeds erlauben | „Publish to web“ | – | erledigt | erledigt 18.11.: `share_page { kind: publish }`; Embeds erlauben offen | – |
| Teilen | T5 Kommentare | – | – | gibt es in Based noch nicht | kommt mit Multi-User (Entscheidung 11.11.) | – |

### X · Einstellungen

| Bereich | Aktion | Wo in der Oberfläche | Werkzeug heute | Lücke | Vorschlag | Aufwand |
| --- | --- | --- | --- | --- | --- | --- |
| Einstellungen | X1 Darstellung: Theme, Schrift, Dichte, Sprache, Feel | Settings → App | – | bewusst nicht | Gelten je Gerät und liegen nicht im Workspace. | – |
| Einstellungen | X2 Seiten: was zuerst öffnet, wie neue Seiten starten | Settings → Pages | – | fehlt | nur wenn im Workspace gespeichert: `get_settings`/`set_setting` mit fester Liste | S |
| Einstellungen | X3 Agenten-Regeln, Rechte-Stufe (Private/Balanced/Open), API-Schlüssel | Settings → Agents & AI | – | bewusst nicht | Ein Agent darf seine eigenen Grenzen und Schlüssel nie ändern. Lesen der geltenden Regeln („was darf ich?“) als `based_guide safety`. | S |
| Einstellungen | X4 Verbindungen (MCP-Server) | Settings → Connections | `list_connections` nur Swift | erledigt | erledigt 18.11.: `list_connections` (ohne Geheimnisse) | – |
| Einstellungen | X5 Sync & Server, Backups, iCloud, Tailnet, Updates, Diagnose | Settings → Workspace/System | – | bewusst nicht | Betreffen Gerät, Zugangsdaten oder Datensicherheit. Lesend: Sync-Zustand in `based_guide overview` genügt. | – |
| Einstellungen | X6 Workspace zurücksetzen, Undo-Verlauf leeren | Settings → General (noch nicht gebaut) | – | bewusst nicht | Nicht umkehrbar. | – |

## Zählung

| Bereich | Zeilen | erledigt | Lücke | bewusst nicht | offen |
| --- | --- | --- | --- | --- | --- |
| Grundlage | 4 | 4 | 0 | 0 | 0 |
| Editor | 37 | 31 | 3 (E5, E30, E31) | 3 | 0 |
| Datenbanken | 23 | 21 | 0 (Reste bei D11, D12, D14) | 2 | 0 |
| Shell | 23 | 17 | 2 (S17, S18) | 4 | 0 |
| Verlauf, Export, Import | 7 | 5 | 1 (V7 teils) | 1 | 0 |
| Meetings | 7 | 5 | 0 | 2 | 0 |
| Brain, Inbox, Home | 14 | 8 | 4 (B7, B10 teils, B12, B14) | 2 | 0 |
| Teilen | 5 | 4 | 0 | 0 | 1 (T5, kommt mit Multi-User) |
| Einstellungen | 6 | 1 | 1 (X2) | 4 | 0 |

## Nicht geprüft

- Diese Liste stammt aus dem Code (Menüs, Slash-Liste, Worker-Protokoll, Tastatur-Register, `docs/*.md`), nicht aus
  der laufenden App. Was nur per Ziehen oder Hover erreichbar ist und in keiner dieser Quellen steht, kann fehlen.
- `registerContextItems` wird nur an zwei Stellen aufgerufen (freie Fläche in `App.tsx`, Board). Die übrigen Menüs
  (Sidebar, Seitenmenü, Blockmenü, Datenbank) sind eigene Komponenten; ihre Einträge sind aus den Dateien gelesen.
- Ob jeder vorhandene Schreib-Aufruf genau eine Transaktion ist (G4) und ob Agenten in gesperrte Seiten schreiben
  können (S8), ist gelesen, nicht mit einem Test belegt.
- Whiteboard: nicht erneut geprüft, gilt laut Auftrag als Vorbild (Stand 18.11.).
