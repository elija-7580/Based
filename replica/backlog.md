# Backlog — alle Anforderungen mit ehrlichem Status

Stand: Pass 12. Legende: ✅ umgesetzt (Code + Linux-Tests/Type-Check, **auf dem Mac noch nicht gebaut**),
🟡 teilweise / ungetestet, ❌ offen.

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

## Editor & Seiten
| Anforderung | Status | Notiz |
|---|---|---|
| Drag-Handles (sechs Punkte), Verschachteln, Verschieben | 🟡 | Gutter in Pass 9 repariert; braucht Mac-Test |
| Blöcke/Spalten/Bilder in der Größe ändern | 🟡 | Spalten + Bilder; nicht alle Blocktypen |
| Seiten öffnen wie Notion (Vollbild, Side Peek, Center Peek) | ✅ | |
| Outline rechts | ✅ | `PageOutline` |
| Mehrere Seiten auswählen (⌘/⇧-Klick, Bulk-Aktionen) | ✅ | Pass 11 in der neuen Sidebar neu umgesetzt |
| Gute Sidebar (Hover-Chevrons, „…" & „+", Drag zum Sortieren/Verschachteln, Breite ziehen, ⌘\\ einklappen + Hover-Peek) | ✅ | Pass 11 |
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

## Später
| Anforderung | Status |
|---|---|
| watchOS | ❌ |
| Zusammenarbeit (mehrere Nutzer) | ❌ |
| UI-Tests | 🟡 XCUITests geschrieben, nie gelaufen |
