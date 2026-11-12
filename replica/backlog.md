# Backlog — alle Anforderungen mit ehrlichem Status

Stand: Pass 33 (Nachtlauf 2026-11-12, TS-Stack, Abschnitt direkt unten; Pass 25/24 = Swift); ältere Abschnitte Stand Pass 16. Legende: ✅ umgesetzt (Code + Linux-Tests/Type-Check), 🟡 teilweise / ungetestet, ❌ offen.
Seit Pass 12/13 baut und startet die App auf dem Mac (Nutzer-Log: macOS 27.2, Notion-Import mit 53.086
Blöcken / 221 Datenbanken); die einzelnen Funktionen sind damit aber noch nicht alle von Hand geprüft.

> Wichtig: Bis Pass 10 kompilierte die App in Xcode nicht (3 Fehler aus Pass 8/9, jetzt behoben). Alles
> unten ist deshalb „im Code vorhanden", aber erst nach dem ersten erfolgreichen Xcode-Build wirklich
> geprüft. `bash ci/typecheck/run.sh` prüft `App/Shared` unter Linux gegen SwiftUI/AppKit/MapKit-Stubs.

## Nachtlauf 2026-11-12 (Pass 33, TS-Stack)
Zwei Schichten (A Kern & Server, B Oberfläche) 05:13–08:50, danach Kurzschichten A2/B2 bis 09:09, alles auf `main` = 11a86d8; nach jedem Merge geprüft: `pnpm -r typecheck`, `pnpm lint`, `pnpm -r test` (beide Datenformate; core 1674, brain 390, web 200+, server 150, editor 80, database-ui 64, sync 52, cli 19), Playwright gezielt + @smoke in Chromium und WebKit, zweimal voll (361 bzw. 378 grün, nur Wackler). CI neu (BSD-322): Merge-Check `ts-fast`, voller Lauf in 4 Shards, Zeitmessungen nicht blockierend, Status immer auf `ci-logs`.

| Anforderung | Status | Notiz |
|---|---|---|
| CI / Tests | ✅ | BSD-322 (ts-fast, Shards, @perf, ts/status.txt, store-perf robust), 298/299 + 321 (rote E2E behoben), 300 Klick-Durchlauf, 303 Token-Lint, 333 features.csv, 335 OPFS-Neuladen |
| Datensicherheit | ✅ | BSD-330 kein stiller Speicher-Fallback (Versionsverlauf überlebte Neuladen nicht – behoben mit 7cccc24), 274 automatische Backups (Mac-Test) |
| Editor | 🟡 | BSD-318 weiße Fläche/Callout (Mac-Test), 258 Rechteck aus dem Rand (Mac-Test), 305 Teil 1/2, 323 Blockfarben, 324 Gliederung; 261 Scrollbalken blockiert (Entscheidung) |
| Shell | 🟡 | BSD-310 ⌘W (Mac-Test), 288 Kontextmenü wie Swift, 301 Teil 1/2 Überlauf, 304 Teil 1/2 Tastatur/Fokus, 306 Datenbank-Kante |
| Agenten / Coding | 🟡 | BSD-331 Hänger-Messung monoton (Mac-Test), BSD-313 Slash/@/⇧Tab, 314 echtes Terminal (Mac-Test), 315 Handy über Tailscale (Mac-Test), 221 Teil 3e MCP-Regeln/Prompts/Inbox/Hauptagent, 243 Teil 3b, 163 Hinweis, 328 Teil 1 Chat-Fixtures |
| Sync / Import | 🟡 | BSD-296 iCloud-Option (ADR 0015, Spike hinter Schalter), 235 Teil 3 Widerruf live, 260 Teil 8 Logseq |

## Nachtlauf 2026-11-11 (Pass 32, TS-Stack)
Zwei Schichten (A Kern & Server, B Oberfläche) 05:07–08:49, alles auf `main` = d108cc5. Nach jedem Merge geprüft: `pnpm -r typecheck`, `pnpm lint`, `pnpm -r test` (core 1624, brain 379, web 163, server 112, editor 77, database-ui 64, sync 45, cli 11), Playwright gezielt bzw. voll (zuletzt voll 305/308, Rest einzeln grün). Mac-Abnahme offen für die mit „Mac-Test“ markierten Einträge (Anleitung im Notion-Backlog).

| Anforderung | Status | Notiz |
|---|---|---|
| Datensicherheit / Sync | ✅ | BSD-279 Zukunftsstempel, 271 Swift-P0s im TS-Kern belegt, 284/285 Gast-Sync, 286 falsche Uhr, 287 Nur-Speicher-Modus sichtbar, 248 DB-Fixtures (24/24, Fehler in unlinkRemovedRows behoben) |
| Import/Export | 🟡 | BSD-283 Gegendruck großer Import (Mac-Test), 260 Teil 6/7 (docx-Export, JSON/JSONL-Import) |
| Server/MCP/Agenten | 🟡 | BSD-221 Teil 3a–3d, 243 Teil 1–3a (Zeitpläne auf dem Server), 250 Teil 1/2, 242 Teil 2 (Mac-Test), 184 Privacy-Check, 227 Diagnose, 235 Teil 2/3 Gast-Modus, 252 Teil 1/2 Echtzeit-Text |
| Startseite / Shell | 🟡 | BSD-278 Startseite, 281 Seitenleiste neu (Mac-Test), 238 Tastatur fertig, 205 Teil 3, 270 ⌘-Halten (Mac-Test), 280 Teil 1 Bundle-Budget, 262 Teil 1 Graph-Layout |
| Editor | 🟡 | BSD-249 fertig, 258 Mausauswahl, 289 (P0), 201 Teil 3 Cover-Galerie, 90 Wikilinks fertig, 101 Link zu Block; 209 blockiert (Lizenz-/Netzfrage) |
| Datenbanken | 🟡 | BSD-255 Teil 1/2 Inline (Mac-Test), 225 Autofill, 293 ⌘Z in Ansichten, 216 Teil 1–3 Dashboard/Chart/Personen |
| Whiteboard | 🟡 | BSD-263 Datenmodell, Yjs-Schema, Tinten-Codec (ohne Oberfläche) |
| Tests | ✅ | BSD-294 notion-api-E2E, 295 Quick-Find-Zeitmessung robust, 292 Spalte beta in features.csv |

## Lauf 2026-11-09 (Pass 25)
Endstand der Nacht (Pass 24) per Fast-Forward auf GitHub-main gebracht (c65b2fe), danach zwei Schichten bis 14:10, alles auf `main` = GitHub. Unter Linux/Swift 6.2 nach jedem Merge geprüft (sauberer Build): BasedCore 322, BasedBrain 408 Tests grün; `ci/typecheck/run.sh`, `run.sh --ios` (neu, BSD-95) und `run-watch.sh` (neu, BSD-66) je 0 Fehler. Auf dem Mac nicht geprüft; Klick-Anleitungen in den Backlog-Einträgen.

| Anforderung | Status | Notiz |
|---|---|---|
| Hänger beim Start (Elijas Hang-Bericht) | 🟡 | BSD-135: App-body/MenuBarExtra-Schleife und HappierModel-Refresh-Rekursion behoben, Mac-Test offen |
| Kein stiller Datenverlust | 🟡 | BSD-42/121 Persistenz im Hintergrund mit Flush (App + based-server), BSD-107/130 unbekannte Werte bleiben erhalten, BSD-122 Schema erreicht Papierkorb-Zeilen, BSD-134 Undo nach Auf-/Zuklappen |
| Sync | 🟡 | BSD-123 doppelte Unique-IDs, BSD-72 HLC-Drift/Push nach Edit; Node-ID nach Restore offen (BSD-145) |
| Performance | 🟡 | BSD-117 Titel getrennt von Struktur, BSD-137 ⌘K off-main |
| Editor / Datenbanken | 🟡 | BSD-100 Turn into, BSD-120 Synced Block mehrfach, BSD-103 Tests, BSD-112 Relationen Teil 2, BSD-68 Design-Tokens Teil 1, BSD-71 Einstellungen Teil 1 |
| Sicherheit | 🟡 | BSD-136 HTML-Blöcke auf /p/ sandboxed, BSD-110 Env-Freigaben pro Agent |
| Agenten | 🟡 | BSD-96 Coding-Sessions, 97/126 Auto-Routing, 106/127/132 Sandbox, 108/128 Startseite, 109/129 Skills, 115 Berechtigungen, 116 Hauptfaden, 118 CLI, 119 Brief, 144 Watch-Status entprellt |
| Suche nach Bedeutung | 🟡 | BSD-62 lokale Embeddings, Related pages |
| Erfassen überall | 🟡 | BSD-64 Mac-Hotkey/Menüleiste, BSD-66 Apple Watch, BSD-11/131 Share Extension + Widgets (nicht eingebettet), BSD-113 Audio per POST /capture |

## Nachtlauf 2026-11-08/09 (Pass 24)
Alle Einträge sind Commits auf `main` dieser Nacht (seit 09.11. auf GitHub-main, c65b2fe). Unter Linux/Swift 6.2 verifiziert: `swift test` ohne `--disable-xctest` (BasedCore 252, BasedBrain 330) und `bash ci/typecheck/run.sh` → 0 Fehler. Auf dem Mac nicht geprüft; Klick-Anleitungen stehen in den Backlog-Einträgen (Notion „Based Backlog“).

| Anforderung | Status | Notiz |
|---|---|---|
| Testnetz grün (Swift Testing statt XCTest) | ✅ | BSD-19/20; zeitabhängige Tests stabilisiert (BSD-114) |
| Typecheck grün | ✅ | BSD-21: 52 → 0 Fehler; iOS-Typecheck fehlt noch (BSD-95) |
| CI-Vorlage Swift 6.2 | 🟡 | BSD-22; Aktivierung durch Elija (BSD-13) |
| ADRs 0001–0010 | ✅ | BSD-14, BSD-29 (0010 „proposed“: Automerge) |
| Kein stiller Datenverlust | 🟡 | BSD-15 Schreibfehler sichtbar, BSD-16 undekodierbar ≠ Löschung, BSD-17 Formeln absturzsicher, BSD-18 Typwechsel, BSD-99 Block löschen → Unterseiten in den Papierkorb |
| Sync korrekt | 🟡 | BSD-23 Schema-Version/Migrationen (v3), BSD-24 + BSD-104 gestempelte Tombstones/Waisen/GC, BSD-25 unbekannte Felder, BSD-26 Archiv-Origin, BSD-27 Undo vs. Remote, BSD-28 CloudKit aus; zwei echte Geräte ungetestet |
| Sicherheit Server | 🟡 | BSD-33 Env-Allowlist/Session-Token, BSD-34 Router + Auth + Limits, BSD-35 XSS/CSP, BSD-36 Prozesse, BSD-37 kein Shell-Hänger |
| Performance | 🟡 | BSD-38 inkrementelle Indizes (App-Seite BSD-117), BSD-39 DB-Revisionen, BSD-40 Erwähnungen |
| Relationen / Re-Import / Export | 🟡 | BSD-31 (+BSD-112), BSD-32, BSD-67 |
| Synced Blocks „Copy and sync“ | 🟡 | BSD-41; derselbe Block zweimal auf einer Seite: BSD-120 |
| Agenten-Kern | 🟡 | BSD-43 Runs, 44 Projekte, 45/94 ChatEngine, 46 Streaming, 47 Kontext, 48 Warteschlange, 49 Routing, 50/98 Berechtigungen, 51 Budget, 52/105 Hauptagent, 53 Sandbox, 55 Startseite, 56 Einrichtung, 57 Brief, 58 MCP, 59 Memories, 60 Skills, 61 Quellen, 54 CLI |
| Erfassen | 🟡 | BSD-63, BSD-65 (iOS-Intents ungeprüft), BSD-111; Rest BSD-113 |

## Grundlagen
| Anforderung | Status | Notiz |
|---|---|---|
| 1:1-Notion-Kopie für Mac + iPhone | 🟡 | macOS-Shell neu (Pass 11); iOS nutzt einfachere NavigationSplitView-Oberfläche |
| Sync Mac ↔ iPhone | 🟡 | CloudKit + eigener based-server (Sync/MCP/HTTP); nie zwischen echten Geräten getestet |
| Auf GitHub | ✅ | `elija-7580/Based` |
| CI (macOS/iOS-Builds bei jedem Push) | ❌ | Workflow liegt fertig in `ci/github-actions-ci.yml` (Mac-Build + Tests + Linux-Type-Check). Aktivieren: auf github.com „Add file → Create new file“, Name `.github/workflows/ci.yml`, Inhalt hineinkopieren, „Commit“. Der Agent darf Workflow-Dateien nicht selbst pushen |
| Notion-Design statt Obsidian-Look | 🟡 | Pass 11: Fenster ohne Titelleiste, Tabs in der Titelleiste, Notion-Sidebar, Seiten-Topbar, 708-pt-Textspalte, Notion-Farben |
| Alle Funktionen + Shortcuts 1:1 | 🟡 | Großer Teil (Blöcke, Slash-Menü, Markdown-Shortcuts, ⌘K/⌘N/⌘F/⌘J/⌘T/⌘W/⌘[/⌘]/⌘\\, ⌘⇧H …); vollständiger Abgleich offen |
| Notion-Einstellungen | 🟡 | Settings-Seiten im Notion-Stil; viele Workspace-/Team-Optionen ohne Funktion (kein Mehrbenutzer) |
| Start ohne Hänger (Keychain) | ✅ | Pass 14: Schlüssel werden im Hintergrund ohne Dialog aus der Keychain geladen; Freigabe bei neuer Code-Signatur über Einstellungen → AI („Allow Keychain access…“) |

## Editor & Seiten
| Anforderung | Status | Notiz |
|---|---|---|
| Drag-Handles (sechs Punkte), Verschachteln, Verschieben | 🟡 | Pass 14 neu: ein Hover-Bereich pro Seite (+ / ⋮⋮ verschwinden nicht mehr), eigenes Ziehen mit Geist + blauer Linie (verschachteln, ausrücken, Spalten, Auto-Scroll); Geometrie getestet, auf dem Mac noch nicht von Hand geprüft |
| Blöcke/Spalten/Bilder in der Größe ändern | 🟡 | Spalten + Bilder; nicht alle Blocktypen |
| Seiten öffnen wie Notion (Vollbild, Side Peek, Center Peek) | ✅ | |
| Outline rechts | ✅ | `PageOutline` |
| Mehrere Seiten auswählen (⌘/⇧-Klick, Bulk-Aktionen) | ✅ | Pass 11 in der neuen Sidebar neu umgesetzt |
| Gute Sidebar (Hover-Chevrons, „…" & „+", Drag zum Sortieren/Verschachteln, Breite ziehen, ⌘\\ einklappen + Hover-Peek) | ✅ | Pass 11 |
| Sidebar wie Notion (28-pt-Zeilen, 14 pt, Favorites / Teamspaces / Private, Footer Library · Trash · Settings, Inline-Umbenennen, Kontextmenü) | 🟡 | Pass 15; Type-Check OK, UI-Tests + Screenshots geschrieben (`SidebarLibraryUITests`), auf dem Mac noch nicht gelaufen. „Shared" fehlt bewusst (kein Teilen-Modell) |
| Löschen → Papierkorb mit Undo-Toast, Wiederherstellen, endgültig löschen (mit Bestätigung), Unterseiten gehen mit | ✅ | Pass 15; Store-Flows per Swift-Testing-Test geprüft, UI-Flow nur als XCUITest geschrieben |
| Library (alle Seiten/Datenbanken/Zeilen/Memories/Skills, Suche, Filter, Sortierung, Mehrfachauswahl, Bulk-Aktionen) | 🟡 | Pass 15; Filter/Sortierung getestet, UI auf dem Mac ungeprüft |
| Teamspaces | 🟡 | Pass 15: eigene Teamspaces anlegen/umbenennen/löschen (Seiten → Private); Notion-Import ordnet nicht automatisch zu (API liefert keine Teamspace-ID) |
| Tabs, ⌘K-Suche, ⌘N-Palette, ⌘F | ✅ | |

## Datenbanken
| Anforderung | Status | Notiz |
|---|---|---|
| Tabelle, Board, Liste, Galerie, Kalender, Timeline, Chart | ✅ | |
| Dashboards (Widgets aus mehreren DBs, 12-Spalten-Raster) | ✅ | Pass 11, inkl. Import aus der Notion-API |
| Number-Chart, Caption, Farbthema, Höhe | ✅ | Pass 11 |
| Formular-Ansicht | ✅ | Pass 11 (Fragen = Eigenschaften, Absenden legt Zeile an) |
| Karten-Ansicht (Map) | ✅ | Pass 12: MapKit-Karte mit Pins (Emoji-Icon), Auswahl → Karte der Zeile, „ohne Ort“-Liste, Geocoding getippter Adressen, Place-Eigenschaft mit Ortssuche; Import aus der Notion-API (`map_by`, Place-Werte) |
| Performance großer DBs | 🟡 | Fractional Index, Query-Cache, 50k-Zeilen-Benchmark unter Linux; auf dem Mac ungemessen |

## Notion-Import
| Anforderung | Status | Notiz |
|---|---|---|
| Über Link/API (alle Blöcke, DBs, Ansichten, Filter, Relationen, Rollups, Formeln, Dateien) | 🟡 | Pass 10 + Dashboards/Forms in Pass 11; gegen Fake-API getestet, nicht gegen deinen Workspace |
| Über HTML-Export (.zip) | ✅ | verlustarm; Ansichten/Formeln nur über die API |
| Fehler beim Import (von dir gemeldet) | 🟡 | Fehlermeldungen enthalten jetzt die fehlgeschlagene Anfrage; „Copy diagnostic report" im Import-Dialog — bitte Report schicken |

## KI & Agenten
| Anforderung | Status | Notiz |
|---|---|---|
| KI zentral (AI-first, Panel rechts wie Notion ⌘J) | ✅ | |
| Claude (API-Key **und** Abo über Claude Code CLI), ChatGPT/Codex, beliebige via MCP | 🟡 | Provider + ACP/CLI-Sessions vorhanden; Abo-Login nur über installierte CLI |
| Apple Intelligence (Autofill, Kategorisieren) | 🟡 | `AppleIntelligence.swift` (Foundation Models, macOS 26) + Autofill; ungetestet |
| MCP-Client + API-Keys, Based als MCP-Server | ✅ | lokal + based-server |
| Agent Brain komplett (Skills, Memories, Agents) | 🟡 | vorhanden; Darstellung „Brain in DB sieht komisch aus" offen |
| Brain auf VPS + iCloud, geplant, immer erreichbar | 🟡 | `deploy/` (Docker, Caddy, systemd); Deployment musst du ausführen |
| Agenten-UI wie Claude Code | ✅ | Pass 12: Willkommensbox, `/`-Befehle mit Popup (help, status, cost, clear, spawn, agents, board, mode, terminal, stop …), `@`-Datei-Erwähnungen, Diffs mit Zeilennummern (rot/grün), Statuszeile (Modus · Agent · Modell · Tokens), Unteragenten-Leiste; plus Terminal (Pass 9) |
| Agenten-Setup verständlich | 🟡 | Agent Doctor; Onboarding-Assistent fehlt |
| Happier-Stack (Sessions, Inbox, E2E) | 🟡 | Control-Room vorhanden |
| Kanban-Board für Agenten | ✅ | Pass 12: Spalten nach Status/Projekt/Agent, Drag & Drop (z. B. nach „Done“ = stoppen), Live-Aktivität, Freigaben direkt auf der Karte |
| Canvas: welche Agenten laufen in welchen Projekten | ✅ | Pass 12: Swimlanes pro Projekt, Baum Eltern → Unteragenten, animierte Kanten für aktive Agenten, Zoom/Pan, Zeitraum-Filter, geplante Agenten, Inspector mit Freigaben und Nachricht |
| Service-Verbindungen (Slack, Google, …) | ❌ | nur über MCP-Server, keine eingebauten OAuth-Konnektoren |
| Visualisierungen (HTML, Mermaid, Charts) | ✅ | |

## Ideen-Notiz (SB_Notes)
| Idee | Status |
|---|---|
| AI-first | ✅ |
| KI-Chats pro Projekt | 🟡 Sessions nach Projekt gruppiert |
| Speicherbare/wiederherstellbare Server-Sandbox | ❌ |
| Agenten-Hierarchie mit Sub-Agenten | ✅ Pass 12: Agenten starten Unteragenten (MCP-Tools `spawn_agent`, `wait_for_agents`, `agent_sessions`, `read_agent_session`, `message_agent`, `stop_agent`), erben Ordner/Projekt, melden ihr Ergebnis an den Eltern-Agenten; max. 3 Ebenen, 8 gleichzeitig |
| Übersichts-Dashboard | ✅ Agents: Sessions · Board · Canvas |

## Gemeldete Bugs
| Bug | Status |
|---|---|
| App kompiliert nicht / „nichts implementiert" | ✅ 3 Compile-Fehler behoben (Pass 11) — bitte neu bauen |
| UI verschiebt sich beim Öffnen, Überlappen/Abschneiden | 🟡 neue Shell ohne NavigationSplitView/Toolbar |
| „+" nicht klickbar | 🟡 neue Sidebar/Titelleiste mit eigenen Buttons |
| Sechs Punkte fehlen | 🟡 Pass 9 |
| Ruckeln / Langsamkeit | 🟡 Sidebar rendert nur bei Strukturänderungen; Messung auf dem Mac offen |
| Logging-System | ✅ Diagnostics (Log, Hänger-Watchdog, Crash-Report, Layout-Audit) |
| „Logs kopieren"-Button | ✅ Pass 13: Diagnostics → *Copy logs* (Bericht / gezeigte Einträge / alle Log-Dateien), Hilfe → *Copy Diagnostic Report*, Button im Absturz-Hinweis, *Copy line* pro Zeile, Kopieren pro Hänger |
| Hänger mit Ort (Stacktrace) | 🟡 Pass 13: Hauptthread-Stack wird während des Hängers gesampelt (Mach, ohne Signale) und symbolisiert; Mach-Teil nur gegen nachgebaute Header geprüft — braucht einen echten Hänger auf dem Mac |
| Falscher Absturz-Alarm nach Xcode-Stopp | ✅ Pass 13: Debugger-Flag im Marker → nur Notiz statt Alert |
| Doppelte Sidebar-Einträge („Teamspace Home" ×5, „AI Conversation Log" ×2) | 🟡 Pass 15: Ursache für „Teamspace Home" belegt (6 echte Seiten aus 6 Notion-Teamspaces, API liefert keine Teamspace-Zuordnung) → Teamspaces + Library-Filter „Same title"; „AI Conversation Log" in Notion nicht auffindbar, mögliche Ursachen in `replica/sidebar-duplicates.md` |

## Später
| Anforderung | Status |
|---|---|
| watchOS | ❌ |
| Zusammenarbeit (mehrere Nutzer) | ❌ |
| UI-Tests | 🟡 XCUITests geschrieben, nie gelaufen |

## Pass 16
| Anforderung | Status | Notiz |
|---|---|---|
| Chat antwortet sinnvoll ohne API-Key | 🟡 | Reihenfolge API-Modell → Claude Code → Apple Intelligence, Engine-Auswahl unter dem Eingabefeld; On-Device-Pfad ohne Tools; am Mac noch nicht geprüft |
| Agent Brain nicht löschbar | ✅ | Schutz im Store + Selbstreparatur (Tests) |
| Vor/Zurück überall (Maus, Tastatur, Wischen) | 🟡 | Maustasten 4/5, Wischen, ⌘←/⌘→, ⌘[/⌘], Verlaufsmenü; am Mac noch nicht von Hand geprüft |
| Home-Seite selbst wählen, Übersicht in Library | ✅ | |
| ⌘K: Cursor sofort im Suchfeld | 🟡 | Editor gibt den Fokus ab, Feld wird mehrfach fokussiert; am Mac prüfen |
| HTML-Block im Slash-Menü | ✅ | /html, /mermaid |
| Export als HTML | ✅ | Seite + ganzer Workspace; PDF fehlt noch |

## Pass 17
| Anforderung | Status | Notiz |
|---|---|---|
| Dateien hineinziehen | 🟡 | Seite, Text, Sidebar, ⌘V; am Mac prüfen |
| Kein schwebendes Settings-Fenster | ✅ | |
| Workspace-Name sichtbar + umbenennbar | ✅ | Popover in der Sidebar, Einstellungen |
| Mehrere Absätze auswählen | 🟡 | Ziehen über Absätze → Blockauswahl; ⇧↑/↓ über Blockgrenzen fehlt noch |
| Outline-Balken | 🟡 | reagiert jetzt auf Änderungen; am Mac prüfen |
| Sidebar Notes / AI mit zwei Homes | ✅ | |
| Tabs ziehen | 🟡 | eigene Geste; am Mac prüfen |
| Eigenes AI-Icon | ✅ | |
| Chat-UI wie Claude Code | 🟡 | Pass 18/19: Thinking, Tool-Karten, To-dos, Markdown, Anhänge, Diktat, Stop, Artefakt-Panel, Browser-Screenshots; am Mac prüfen |

