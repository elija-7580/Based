# Auftrag: Agent-Parität in ganz Based

Dieses Dokument ist der Arbeitsauftrag für einen Agenten (Planung: Fable, Umsetzung: Opus oder Fable). Es steht für
sich: wer es liest, braucht kein Gespräch davor. Der Backlog-Eintrag dazu heißt „Agent-Parität · Alles, was der
Mensch in Based kann, kann auch der Agent (MCP)“.

## Ziel

Elija, 18.11.2026: „Alles, was der Mensch kann, in der gesamten App muss auch der Agent können. Aber halt extrem
effizient und verlässlich.“

Ein Agent (Claude Desktop, Claude Code, ChatGPT, Codex über MCP – und Baseds eigene Agenten) soll jede Aktion, die
ein Mensch in Based Next ausführen kann, ebenfalls ausführen können. Nicht über einen Browser oder Klicks, sondern
über Werkzeuge, die wenige Token kosten und nie halb schreiben.

Vorbild ist das Whiteboard (Stand 18.11.): `read_board`, `draw_board`, `list_files`, `upload_file` – siehe
`docs/mcp.md`, Abschnitt „Whiteboards“, und `packages/core/src/whiteboard/agent.ts`.

## Regeln (nicht verhandelbar)

1. **Eine Werkzeug-Schicht.** Jedes Werkzeug lebt in `packages/brain/src/tools.ts` (`WorkspaceTools`). Der
   MCP-Server (`apps/server/src/mcp.ts`) registriert es nur und reicht durch; Baseds eigene Agenten
   (`apps/web/src/worker/chat.ts`, `apps/server/src/agent-engine.ts`) bekommen es automatisch. Nie zwei
   Implementierungen derselben Aktion. Reine Logik (Parser, Planung, Umrechnung) gehört nach `packages/core`, testbar.
2. **Knapp.** Lesen gibt Text zurück, eine Zeile je Ding, kurze Kennungen statt langer IDs (wie `boardHandles`),
   lange Listen mit `limit`/`offset` und „… N more“. Schreiben nimmt, wo es passt, ein kleines Skript statt vieler
   Einzelaufrufe (wie `draw_board`). Die Anordnung rechnet Based, nicht der Agent.
3. **Verlässlich.** Jeder schreibende Aufruf ist genau eine `store.transact` (ein Undo-Schritt, alles oder nichts).
   Bei Skripten: eine falsche Zeile wird mit Grund gemeldet, der Rest gilt. Fehlermeldungen sagen, wie es richtig
   geht (gültige Werte aufzählen).
4. **Erkennbar.** Was ein Agent schreibt, trägt die Herkunft (BSD-522: `store.withActor`, Seite „ai“/„mixed“) und wo
   es eine Darstellung gibt den Marker. Die Regeln für Agenten (`mcpRuleRefusal` in `mcp.ts`) gelten für jedes neue
   Schreib-Werkzeug automatisch – prüfen, dass das neue Werkzeug dort richtig eingeordnet ist.
5. **Sicher.** Nichts, was der Server aus dem Netz oder vom Rechner holt, ohne die Schutzregeln aus
   `apps/server/src/board-files.ts` (kein privates Netz, Größe und Zeit begrenzt, lokale Pfade nur über stdio).
   Endgültiges Löschen, Teilen nach außen und Einstellungen, die Daten betreffen, nur mit `destructiveHint` und
   so, dass die Rechte-Stufe greift.
6. **Dieselben Namen wie die Oberfläche.** Farben, Blockarten, Ansichten: die Listen aus `packages/core`
   verwenden (z. B. `BOARD_STROKE_COLORS`), nicht neu aufschreiben. Fehlt eine Liste in core, zuerst dorthin ziehen
   und die Oberfläche darauf umstellen.

## Vorgehen

### Schritt 1 – Bestandsaufnahme (Fable, keine Code-Änderung)

Erstelle `docs/agent-parity-matrix.md`: eine Tabelle aller Aktionen, die ein Mensch in Based Next ausführen kann,
mit Spalten **Bereich · Aktion · wo in der Oberfläche · Werkzeug heute · Lücke · Vorschlag · Aufwand (S/M/L)**.

Quellen, damit nichts fehlt:

- Kontextmenüs: alle Aufrufe von `registerContextItems` (`packages/ui/src/native/contextMenu.ts`)
- ⌘K und „New“: `apps/web/src/components/QuickFind.tsx`, `NewPalette.tsx`
- Editor: Slash-Menü und Blockarten (`packages/editor/src/blocks/slash.ts`), Format-Popup, Turn-into, Ziehen von
  Blöcken, Spalten, Blockfarben, Tastenkürzel (`docs/keyboard.md`, `docs/editor-parity.md`)
- Datenbanken: `packages/database-ui` (Properties, Ansichten, Filter, Sortierung, Gruppen, Formeln, Relationen)
- Shell: Sidebar (`apps/web/src/shell`), Tabs, Favoriten, Teamspaces, Papierkorb, Library (Graph, Meetings)
- Seitenmenü „…“: Icon/Cover, Schrift, volle Breite, Sperren, Export, Versionsverlauf, Teilen (`docs/sharing.md`)
- Meeting Notes (`docs/meeting-notes.md`), Agent Brain und Inbox (`apps/web/src/brain`), Home, Einstellungen
- Import/Export (`docs/notion-import.md`)
- Vorhandene Werkzeuge: `docs/mcp.md` und `WorkspaceTools.specs`

Erste bekannte Lücken (prüfen, nicht abschreiben): Blöcke gezielt verschieben/einrücken/in Spalten setzen,
Blockfarben und Turn-into, Cover/Icon (Phosphor, Bild), Bilder und Dateien in Seiten einfügen (`upload_file`
gibt es schon), Kommentare (kommen mit Multi-User), Teilen und Rollen, Versionsverlauf ansehen/wiederherstellen,
Notion-Import starten, Export, Meeting Notes (Aufnahme, Transkript), Graph lesen, Sidebar-Anordnung, Agent-Brain-
Erinnerungen lesen/schreiben, Einstellungen.

Bewusst **nicht** als Werkzeug: rein Visuelles ohne Daten (Zoom, Scrollen, Fokus, Hover), Fenster/Tabs der App,
Dinge, die nur für das Gerät gelten (Tastatur-Layout, Theme des Geräts) – in der Matrix mit „bewusst nicht“ und
einem Satz Grund aufführen.

### Schritt 2 – Entscheidungen mit Elija

Höchstens fünf Fragen auf einmal, jede mit Empfehlung, kurz und auf Deutsch (Elijas Stil). Typische Fragen:
Reihenfolge der Bereiche; ob ein Bereich ein Skript-Werkzeug bekommt (wie `draw_board`) oder Einzelwerkzeuge;
was Agenten bei Teilen/Löschen/Einstellungen ohne Rückfrage dürfen. Produktentscheidungen trifft nur Elija.

### Schritt 3 – Backlog

Je Bereich ein Eintrag im Notion-Backlog „Based Backlog“ (Typ Feature, Bereich „Server/MCP“ plus den Bereich der
App), mit Problem, Plan, Akzeptanz und der Liste der Aktionen aus der Matrix. „Autonom machbar“ nur, wenn keine
Produktentscheidung offen ist. Vorschlag für die Reihenfolge, falls Elija nichts anderes sagt:

1. Seiten-Editor (Blöcke: verschieben, Spalten, Farben, Turn-into, Bilder/Dateien einfügen) – am häufigsten gebraucht
2. Datenbanken (fehlende Property-Arten, Formeln, Relationen, Gruppierung)
3. Seitenmenü und Shell (Icon/Cover, Favoriten, Sidebar, Teamspaces, Papierkorb-Reste)
4. Versionsverlauf, Export, Import
5. Meeting Notes, Agent Brain, Home
6. Teilen und Rechte (nach Multi-User-Entscheidungen), Einstellungen

### Schritt 4 – Umsetzung je Eintrag

- Werkzeug in `WorkspaceTools` + Registrierung in `mcp.ts` (gleicher Name, Eingaben als zod, `readOnlyHint` für
  Lesendes) + Beschreibung so, dass ein Modell es ohne weitere Hilfe richtig benutzt (Beispiel in der Beschreibung).
- Tests: Logik in `packages/core/test`, Werkzeug in `packages/brain/test/tools.test.ts`, MCP-Weg in
  `apps/server/test/mcp.test.ts` (Werkzeugliste im Test „initialize“ ergänzen).
- `docs/mcp.md` und die Matrix aktualisieren (Lücke → erledigt, mit Commit).
- Wenn die Oberfläche dieselbe Logik braucht: Logik nach core ziehen und die Oberfläche darauf umstellen (Beispiel:
  `boardFileParts` wird von Fläche und Agent benutzt).
- Prüfen nach `AGENTS.md`: `ci/typecheck/run-ts.sh --fast`; berührte E2E-Specs; nicht auf die GitHub-CI warten oder
  sie abfragen (höchstens einmal `ci-logs` lesen); Merge nach main erst mit grünem `ts-fast`.
- Backlog-Eintrag: Ergebnis mit „Geprüft: …“ und einem Mac-Test-Satz, den Elija in Claude Desktop ausprobieren kann
  (z. B. „Sag Claude: verschieb den dritten Absatz in eine zweite Spalte neben das Bild“).

## Fertig heißt

- Jede Zeile der Matrix ist „erledigt“ oder „bewusst nicht“ (mit Grund).
- Ein Abnahmetest pro Bereich in `apps/server/test/mcp.test.ts`, der eine typische Aufgabe so löst, wie ein Agent es
  täte (mehrere Werkzeuge hintereinander), und das Ergebnis im Store prüft.
- Token-Budget: typische Aufgaben je Bereich in höchstens drei Aufrufen; Antworten eines Lese-Werkzeugs für eine
  normale Seite unter 2 000 Zeichen (mit `limit`/`offset` für mehr).
