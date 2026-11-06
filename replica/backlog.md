# Backlog — alle Anforderungen mit ehrlichem Status

Stand: Pass 16. Legende: ✅ umgesetzt (Code + Linux-Tests/Type-Check), 🟡 teilweise / ungetestet, ❌ offen.
Seit Pass 12/13 baut und startet die App auf dem Mac (Nutzer-Log: macOS 27.2, Notion-Import mit 53.086
Blöcken / 221 Datenbanken); die einzelnen Funktionen sind damit aber noch nicht alle von Hand geprüft.

> Wichtig: Bis Pass 10 kompilierte die App in Xcode nicht (3 Fehler aus Pass 8/9, jetzt behoben). Alles
> unten ist deshalb „im Code vorhanden", aber erst nach dem ersten erfolgreichen Xcode-Build wirklich
> geprüft. `bash ci/typecheck/run.sh` prüft `App/Shared` unter Linux gegen SwiftUI/AppKit/MapKit-Stubs.

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
| Chat-UI wie Claude Code | 🟡 | Pass 18: Thinking, Tool-Karten, To-dos, Markdown, Anhänge, Diktat, Stop; Artefakt-Panel fehlt; am Mac prüfen |

