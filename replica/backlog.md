# Backlog — alle Anforderungen mit ehrlichem Status

Stand: Pass 46 (Nachtlauf 2026-11-21, TS-Stack, Abschnitt direkt unten; Pass 45 (Nachtlauf 2026-11-20) darunter; Pass 44 (Sonderlauf am Tag 2026-11-19) darunter; Pass 43 (Nachtlauf 2026-11-19) darunter; Pass 42 (Nachtlauf 2026-11-18, Lauf ab 11:12) darunter; Pass 41/40/39/38/37/36/35/33 darunter; Pass 25/24 = Swift); ältere Abschnitte Stand Pass 16. Legende: ✅ umgesetzt (Code + Linux-Tests/Type-Check), 🟡 teilweise / ungetestet, ❌ offen.
Seit Pass 12/13 baut und startet die App auf dem Mac (Nutzer-Log: macOS 27.2, Notion-Import mit 53.086
Blöcken / 221 Datenbanken); die einzelnen Funktionen sind damit aber noch nicht alle von Hand geprüft.

> Wichtig: Bis Pass 10 kompilierte die App in Xcode nicht (3 Fehler aus Pass 8/9, jetzt behoben). Alles
> unten ist deshalb „im Code vorhanden", aber erst nach dem ersten erfolgreichen Xcode-Build wirklich
> geprüft. `bash ci/typecheck/run.sh` prüft `App/Shared` unter Linux gegen SwiftUI/AppKit/MapKit-Stubs.

## Offen für Notion-Backlog (13.11., Notion war nicht erreichbar)

| Anforderung | Status | Notiz |
|---|---|---|
| TS · Animationen komplett überarbeiten (im Notion-Backlog seit 14.11., P1, Bereit) | ❌ | Wunsch Elija 13.11.: alle Animationen neu machen und verbessern. Plan: eine Motion-Sprache als Tokens (Dauer, Kurven, Federn) in packages/design-tokens, Bestand aller Übergänge (Menüs, Popover, Dialoge, Peek, Sidebar, Tabs, Blockziehen, Toasts) erfassen, jede Stelle auf die Tokens umstellen, `prefers-reduced-motion` überall, keine Layout-Sprünge, 60 fps auch in WebKit. Akzeptanz: Galerie/Fotos vorher-nachher, Tests auf Tokens (kein festes `ms` außerhalb der Tokens), Mac-Abnahme. Typ UX/Polish, Bereich Sidebar/Shell + Editor + Datenbanken, P1, L, autonom machbar; beim nächsten Lauf als Notion-Eintrag anlegen. |

## Pass 46 (Nachtlauf 2026-11-21, Feature-Stopp, RC-Abnahme)

Inbox: BSD-635–638 (Audit „Effizienz“) → Blockiert mit je einer Frage (Umbau über mehrere Pakete, nach der Beta); BSD-642 → Bereit. Schicht A (03:12–04:46) und B (03:12–04:47, dann 04:53–05:27). main 4308e573 → 9bb22aaf → cb2181e2 → 26d684c1 → 906d62f1 → cf05d367 → 16499f07 → f0fff4e9; `run-ts.sh --fast` auf jedem Stand grün, berührte Specs (polish, sidebar, report, find, beta-build) in Chromium und WebKit grün.

| Anforderung | Status | Notiz |
|---|---|---|
| BSD-627 polish.spec „Home neben dem offenen Chat“ wackelig | ✅ | Test wartet auf `data-floating`; 48/48 in beiden Browsern |
| BSD-628 Wackler WebKit (Seitenleiste ziehen, ⇧⌘B-Bündel) | ✅ | Drop nach Drop-Position, Auswahl ohne rAF-Drosselung; Sidebar.tsx, bugReport.ts |
| BSD-631 Warteliste von außen prüfbar (stats/check) | 🟡 | Mac-Test: Elija setzt `WAITLIST_STATS_TOKEN` am Server |
| BSD-632 Problem melden mit einem Klick („Send to Based“) | 🟡 | Server POST /api/report → Notion-Backlog, App mit Warteschlange; Mac-Test nach Notion-Einrichtung am Server; nicht im RC 0.2.11 |
| BSD-629 Gründerangebot für Beta-Tester | 🟡 | nur docs/beta/README.md; Mailtext für die Beta-Release-Seite im Eintrag |
| BSD-641 Beta-Fixture v0.2.11 (bc62b245) | ✅ | nur neue Dateien in fixtures/beta |
| BSD-642 Bildschirmfoto beim Melden zu langsam (WebKit) | ✅ | nur sichtbare Stil-Eigenschaften; WebKit 1,1–1,5 s → ~0,45 s, @perf-Test |
| BSD-643 ⌘K: wartendes Enter hängt, wenn die Suche scheitert | ✅ | find.spec 28/28 |

## Pass 45 (Nachtlauf 2026-11-20, Feature-Stopp)

Inbox leer; die Bereit-Einträge BSD-604 (Teil 2), 613, 614, 615, 585 sind laut eigenem Text erst ab 24.11. dran. Schicht A prüfte Datensicherheit, Notion-Import und ersten Start (ohne Befund) und behob BSD-611; Schicht B ging den Beta-Build als neuer Tester durch (Chromium/WebKit, hell/dunkel) und behob neun Fehler. main de906140 → 5c026a9d → 1d79b4df (Fast-Forward), `run-ts.sh --fast` grün auf jedem Stand, berührte Specs in Chromium und WebKit grün.

| Anforderung | Status | Notiz |
|---|---|---|
| BSD-611 Notion „Markdown & CSV“ zweimal importiert → doppelt | ✅ | stabile IDs wie im HTML-Weg nur für Dateien mit Notion-ID, Reimport-Schutz; ältere Markdown-Imports einmal neu angelegt |
| BSD-616 Mehrzeilige Felder mit Rahmen | ✅ | report.spec |
| BSD-617 ⌘N → New database ohne Schreibmarke | ✅ | shortcuts.spec |
| BSD-618 Library → Meetings: Umschalter vor dem Titel | ✅ | app-heads.spec |
| BSD-622 Blockmenü: falsche Kürzel | ✅ | editor-menus.spec |
| BSD-623 „New property“ rollt seitlich (WebKit) | ✅ | scrollbars.spec |
| BSD-624 •••-Seitenmenü ragt bei 900 × 600 aus dem Fenster | ✅ | shortcuts.spec |
| BSD-625/626 Seitenleisten-Menüs öffnen unter dem Fensterrand | ✅ | sidebar-nav.spec, sidebar-multi.spec |
| BSD-619/620/621 Feinschliff (Papierkorb-Rückmeldung, Fokusrahmen, Filterzeile) | ❌ | Blockiert, je eine Frage an Elija |

## Pass 44 (Sonderlauf am Tag 2026-11-19)

Die geplante Nachtschicht lief um 11:14 ein zweites Mal; Elija: „mach trotzdem die Schicht“. Zwei Schichten (A Prüfen, B Oberfläche), beide bis 13:10 fertig; main 5cebdf8c → cff2e007 (Fast-Forward über nightly/2026-11-19-tag-main), `run-ts.sh --fast` grün auf jedem Stand, dazu beta-requests.spec und beta-build.spec mit BASED_CHANNEL=beta in Chromium und WebKit (12/12).

| Anforderung | Status | Notiz |
|---|---|---|
| BSD-609 Rückfragen von KI-Apps in der Beta zeigen | 🟡 | Mac-Test; Liste unter Einstellungen → Connect AI apps, Erlauben/Ablehnen; MCP-Antwort nennt den Ort; kein Chat-/Agenten-Code beim Start |
| BSD-610 Beta-Fixtures v0.2.9/v0.2.10, Datum, zweiter Start | ✅ | neue Fixtures und Archive, alte unverändert |
| BSD-611 Notion „Markdown & CSV“ zweimal importiert → doppelt | ❌ | gefunden; Bereit, nach dem RC (berührt Import-Kennungen); features.csv richtiggestellt |
| BSD-612 Beta-Build-Durchgang läuft nicht automatisch in der CI | ❌ | Blockiert, Frage an Elija (ts-fast oder Beta-Release-Workflow) |
| BSD-607 Chat-Panel bei 900 × 600 | ❌ | Inbox → Blockiert, Designfrage |

## Pass 43 (Nachtlauf 2026-11-19)

Zwei Schichten (A Kern & Server, B Oberfläche), beide bis 04:41 fertig; main c3ba1fe → a593e22e (B) → c65f617b (A), jeweils Fast-Forward, `run-ts.sh --fast` grün auf jedem Stand, CI ts-fast auf den Branches grün.

| Anforderung | Status | Notiz |
|---|---|---|
| BSD-594 Speicher: geschlossene Editoren | ✅ | Fix + editor-leak.spec lagen schon auf main (7a383688); nachgeprüft |
| BSD-602 ZIP-Import „2 Seiten statt 1“ | ✅ | kein Fehler: Ordner im ZIP ist seit BSD-563 eine Seite; Spec + Unit-Prüfung angepasst |
| BSD-595 Chat-/Agenten-Code beim Erststart | ✅ | eigene Chunks; Start-JS 1 063 → 918 KiB gzip, Worker 319 → 281 KiB; Budget gesenkt |
| BSD-596 Leerlauf-Wächter / Sitzungs-Marke | 🟡 | Mac-Test; 0 Timer in 5 s Leerlauf (vorher ~100) |
| BSD-604 Spalte „ID“ bei 100 000 Zeilen | 🟡 | Teil 1: 2,1 s → 1,0 s, Undo 23–30 s → 1,5 s; Teil 2 blockiert (Frage Worker vs. Häppchen) |
| BSD-605 Datenbank 100 000 Zeilen Heap | 🟡 | Teil 1: Messschritt + Befund; Umbau nach dem 23.11. |
| BSD-599 Home hinter Chat bei 900 × 600 | ✅ | polish.spec |
| BSD-600 Werkzeug-Karte im Chat | ✅ | chat.spec |
| BSD-606 Beta-Fixtures v0.2.3–v0.2.8 + Archive | ✅ | neu gefunden und erledigt; alle öffnen/importieren ohne Unterschied |
| BSD-601 ask_user | ❌ | zurückgestellt: Feature außerhalb der Beta, überschneidet sich mit BSD-539 |

## Nachmittag 2026-11-18 (Chat mit Elija, Rest aus Pass 42)

Auftrag Elija 15:53: „mach die dinge die noch offen sind“. Antworten auf die vier Fragen: Prozent ×100 ja, Import-Quellen als Liste ja, Kalendertag vor der Beta ja, „me“ → Nutzerkennung ja; PR 35 und 37 mergen ja. Geprüft auf dem Merge-Stand: run-ts --fast (typecheck, lint, Wächter, Unit-Tests in drei Läufen, Smoke 33 grün); berührte Specs in Chromium und WebKit.

| Anforderung | Status | Notiz |
|---|---|---|
| PR 37 Datenformat (BSD-564, 569, 578, 579) | ✅ | gemergt; Inhalt wie in PR 37 beschrieben, Mac-Test offen |
| PR 35 Import-Quellen (BSD-563) | ✅ | gemergt; Konflikt mit #44 (CSV-Relationen): #44 löst Relationsspalten auf, die zweite Erkennung aus PR 35 entfällt |
| BSD-548 CI-Vorlage in .github | ✅ | schon von anderer Sitzung übernommen (09be3ea0, a4ad91b5); nächsten vollen main-Lauf ansehen |
| BSD-565 Hybrid-Import: Teil-ZIPs einzeln wählen | 🟡 | Mac-Test; mehrere Dateien im Dialog „Connect Notion directly“, eine Wurzel |
| BSD-566 Obsidian Canvas / Excalidraw als Board | 🟡 | Mac-Test; board-import.ts, Formen, Seitenkarten (Links), Bilder, Verbindungen, Tinte |
| BSD-567 Import-Dialog: Quellen als Liste | 🟡 | Mac-Test; Checkliste: geprüft 3 Größen hell/dunkel, behoben –, offen: in 900 × 600 nur ~2 Zeilen sichtbar (rollt) |
| BSD-580 Search by meaning in den Einstellungen | 🟡 | Mac-Test; Connect AI apps → Search by meaning, nur auf Klick |
| BSD-557 Website-Deploy | ❌ | Deploy auf basednotes.app macht Elija |

## Nachtlauf 2026-11-18 (Pass 42, TS-Stack, Beta-Sprint, Lauf ab 11:12 tagsüber)

Geplanter Nachtlauf, erst 11:12 gestartet; Hauptlauf hat ihn bis 16:00 begrenzt (Elija und weitere Sitzungen arbeiteten parallel auf main). Merges nach main (Hauptlauf, je auf dem Merge geprüft: run-ts --fast bzw. typecheck/lint/Design-Wächter/betroffene Tests + Smoke): 9d781fdc, 99db4af0, 02a4c98a, d8595446. Schicht A 11:25–14:00 und 14:25–15:21, Schicht B 11:25–13:00 (Doppelarbeit, nicht gemergt), 13:05–13:40 (ohne Commit), 13:45–14:17, 14:25–15:20. Rot nur unter Last (sync large-load, server sync-efficiency, brain recall, quickfind-perf) – einzeln grün; BSD-559/572 sichern die bekannten davon ab.

| Anforderung | Status | Notiz |
|---|---|---|
| BSD-548 CI: WebKit-Shards hängen | 🟡 | Mac-Test: Vorlage ci/github-actions-ci.yml + ci/playwright-install.sh nach .github übernehmen, nächsten main-Lauf ohne Push durchlaufen lassen |
| BSD-549 Dependabot-Warnung | ✅ | glib 0.18.5 nur unter Linux, nicht in der Mac-App; ci/deps-audit.mjs für den RC |
| BSD-557 Download-Link: Range umgeht die Grenze | ✅ | Fortsetzen nur bis 6 h nach gezähltem Download; wirkt nach Deploy der Website |
| BSD-558 Wiederherstellen kann Dateien löschen | ✅ | aus der Prüfung (Go/No-Go Datensicherheit); Test vorher rot |
| BSD-559 / BSD-572 wackelige Zeitmessungen | ✅ | CPU-Zeit mit Budget, eigene Testlimits |
| BSD-568 Rot auf main seit #34 | ✅ | durch ff770203 überholt |
| BSD-573 Update-Fallback zeigt auf beta-latest | ✅ | nennt Einladungslink; nativer Dialog nicht gesehen |
| BSD-571 Font „Based“: Lücke in Datenbank-Ansichten | ✅ | Rest von BSD-562; Zahlen fluchten weiter |
| BSD-583 Beta-Daten überstehen Formatwechsel | 🟡 | Mac-Test; Lücke diffProperties (unbekannte Felder) behoben; SyncClient stoppt bei Protokoll > 3 |
| BSD-581 Claude Code/Desktop verbinden | 🟡 | Mac-Test; Einstellungen → Connect AI apps, `based mcp` (stdio-Proxy), Server-Tokens widerrufbar |
| BSD-550/551/552 Einstieg | 🟡 | von Elijas Sitzung auf main (e5e5d43f); Schicht-B-Fassung verworfen |
| BSD-565/566 Hybrid-Import Teil-ZIPs, Canvas-Import | ❌ | Blockiert: warten auf PR 35 (gleiche Dateien) |
| BSD-564, 567, 578, 579 | ❌ | Blockiert mit je einer Frage an Elija |
| BSD-580 Agent Brain: Modell über lokalen Server | ❌ | Bereit, aus Zeitgründen nicht begonnen (AI-nah, zuletzt) |

## Nachtlauf 2026-11-18 (Pass 41, TS-Stack, Beta-Sprint)

Merges nach main (Hauptlauf, je run-ts --fast auf dem Merge grün): a2ca7394, a1e901a0, e0015d60, f0f870d0, bb51995e (dazu a11y/editor-passthrough in Chromium + WebKit), 32cbb955, 4eb16497, 2b6d4e09, e28c12ab, a23912d2, c153c6ae. Schicht A 03:13–06:49, Schicht B 03:13–06:23; beide früh fertig, weil nur noch Einträge „frühestens ab 24.11.“ offen waren. Keine Kollisionen.

| Anforderung | Status | Notiz |
|---|---|---|
| BSD-544 Rot auf main: a11y Tab-Durchlauf, editor-passthrough Notion-Import (P0) | ✅ | gewollte Änderungen vom 17.11.; Tabelle meldet aktive Zelle per aria-activedescendant; kein Datenfehler |
| BSD-514 App heißt „Based Notes Beta“ | 🟡 | Mac-Test; Bundle-ID, Datenordner, Kanal, appName-Kennung und Download-Link unverändert |
| BSD-522 Herkunft pro Block und Seite im Datenformat | ✅ | optionale Felder, alte Daten lesen sich unverändert; Agenten schreiben „ai“, keine Anzeige |
| BSD-542 Beta-latest.json nur Kurzfassung | 🟡 | Mac-Test (Install-Knopf in 0.2.2–0.2.4 erreichbar) |
| BSD-543 CSV-Import: „COVID-19“ bleibt Text | ✅ | aus der Prüfung (Schritt 5) |
| BSD-515 Teil 1 Library/Graph mit „Fast start“ | 🟡 | Teil 2 blockiert: FTS5 oder Dateisuche (Frage an Elija) |
| BSD-531 Rechteck-Auswahl / BSD-532 Blöcke ziehen | 🟡 | Mac-Test; p95 28 ms bei 300 Blöcken, Ziehstart ~20 ms |
| BSD-535 HTML-Block: Größe ziehen, HTML-Datei öffnen/ablegen | 🟡 | Mac-Test; Mermaid-Standard offen (Frage) |
| BSD-536 Tabelle: Zeichen beim Lostippen | ✅ | Puffer bis das Zellenfeld Fokus hat; Test 10× |
| BSD-525/527/528/529/530 Element-System 1, 3–6 | ✅ | Bausteine, ein Menü-Aussehen, 14 px Klickfläche, drei Animationen, App-Köpfe |
| BSD-509 Einstellungen-Zeile / BSD-524 a11y-Foto-Test / BSD-545 Long-Poll-Test / BSD-547 WebKit database-click | ✅ | Tests stabil |
| BSD-533 Auswahl wie in Notion | 🟡 | Mac-Test (Code seit 17.11. auf main) |

## Nachtlauf 2026-11-17 (Pass 40, TS-Stack, Beta-Sprint, Lauf ab 14:01)

Merges nach main: 16433984 (Schicht A bis 9b6fea5c + Schicht C des Zweitlaufs bis 8fd8a40d), 1d635a18 (Schicht B bis a6a48324, mit origin/main inkl. Whiteboard und ADR-0017-Stufe-A); jeweils run-ts --fast grün (@smoke 30/30), betroffene E2E in Chromium + WebKit grün, beta-build.spec im Beta-Kanal 8/8. Schicht A 14:05–15:50, Schicht B 14:05–16:36. Commit-Titel 465d8a29/10bb04b8/5a52c7ab tragen falsche Nummern (BSD-491/492/493 statt 498/503/504).

| Anforderung | Status | Notiz |
|---|---|---|
| BSD-478 Archiv-Import holt gelöschte Absätze/Ansichten/Spalten zurück (P1) | ✅ | nur ganze Papierkorb-Einheiten kommen zurück; Unterseite bringt ihren Behälter mit |
| BSD-491 Backups: Aufräumen liest alle Stände bei jedem Lauf | ✅ | Cache je Stand + Textsuche nach Datei-IDs; 15,8 s → 4,2 s einmal je Serverlauf |
| BSD-495 Zeitmessung 100 000 Records ins Gate | ✅ | scale-perf (Unit + @perf); Heap im Browser-Worker nicht messbar |
| BSD-501 website waitlist-Test „server exited 1“ | ✅ | PORT=0, echter Port vom System |
| BSD-481 features.csv/editor-parity Whiteboard | ✅ | Zeile ts=partial, beta=after |
| BSD-482 Neue Seite: Schreibmarke im Titel (P1) | ✅ | ⌘N, ⌥⌘N, „+“ |
| BSD-483/485 Einstellungen und Über-Seite im Beta-Build | ✅ | kein Teilen, hello@basednotes.app, „Based Beta“ ohne Agenten, „1 note“ |
| BSD-484 Slash-Menü: Gruppenkopf doppelt | ✅ | |
| BSD-486/487/488 (Schicht C) | ✅ | alte Links auf ausgeblendete Ansichten, Unique-ID-Wiederimport, Versionsverlauf mittig (488 doppelt umgesetzt, zusammengeführt) |
| BSD-498 Slash/@-Menü überdeckt unten die Zeile | ✅ | |
| BSD-503 Karten-Ansicht: Streifen über die Datumsgrenze | ✅ | |
| BSD-504 Ohne AI: „Use dashboard as Home“ ohne Wirkung | ✅ | Eintrag ausgeblendet |
| BSD-505 Papierkorb: „Delete forever“ ohne Rückfrage (P1) | ✅ | fragt nach |
| BSD-507 beta-build.spec rot nach BSD-231 + BSD-486 | ✅ | prüft jetzt die Meetings-Liste |
| BSD-502 Website: Transkription „after the beta“ | ❌ | Blockiert, Frage an Elija |
| BSD-489/490 Feinschliff Versionsverlauf/Board-Kante | ❌ | nach dem 23.11. |
| BSD-477 beta vorspulen + Pre-Release | ❌ | nur Beta-Agent (Nachtschicht darf beta nicht anfassen) |

## Nachtlauf 2026-11-17/18 (Pass 39, TS-Stack, Beta-Sprint, Lauf ab 12:20)

Merges nach main: 211f5bdd (Hauptlauf BSD-475 + b5cdae49 BSD-453 von außen), 81fc237f (Schicht B bis BSD-476, Fast-Forward), danach Schicht A bis BSD-472/473; jeweils run-ts --fast (typecheck, lint, Unit beider Formate, @smoke 29/29) grün, betroffene E2E in Chromium + WebKit grün. Schicht A 12:21–13:15, Schicht B 12:22–13:08.

| Anforderung | Status | Notiz |
|---|---|---|
| BSD-475 CI rot: kit-states-Bildvergleich auf dem Runner | ✅ | Pixelvergleich nur, wo die Grundbilder entstanden (ohne GITHUB_ACTIONS oder BASED_VISUAL=1); Zustandsprüfungen laufen überall |
| BSD-467 Problem melden → Mail an hello@basednotes.app | 🟡 | „Email report“ (mailto, nur Version/Kanal/System/Bericht-ID, kein Inhalt); Adresse in packages/core/src/bugReport.ts; Opener nur mailto:*; Mac-Test mit Mail.app |
| BSD-471 features.csv Spalte beta | ✅ | 179 statt 200 beta-Zeilen (15 → labs, 6 → after); Test in beta.test.ts |
| BSD-476 website waitlist-Test wackelig | ✅ | busy_timeout 5000, Test wartet auf Prozessende; 20/20 unter Last |
| BSD-469 Beta-Weg 2: Import → Export → Wiederimport | ✅ | e2e/beta-data.spec.ts, normal und BASED_CHANNEL=beta, Chromium + WebKit; Archiv und Sicherung vor Update exakt gleich |
| BSD-468 Release Notes und Tester-Anleitung RC | ✅ | docs/beta/RELEASE_NOTES.md „0.2 – release candidate“, README ergänzt |
| BSD-472 Markdown-Export ohne Zeileninhalt (P1) | ✅ | <Datenbank>/<Zeile>.md wie Notion |
| BSD-473 Markdown-Export: Datenbank-Link/-Position | ✅ | Link zeigt richtig, Datenbank bleibt beim Wiederimport an ihrem Platz |
| BSD-474 Based-HTML-Export → Datenbanken beim Wiederimport | ❌ | Blockiert, Frage an Elija: HTML als Leseformat oder Rundreise? |

## Nachtlauf 2026-11-17 (Pass 38, TS-Stack, Beta-Sprint)

Merges nach main: 7a4701af (A bis BSD-450 + B bis BSD-447), 49332323 (B bis BSD-357), 3fc3a335 (A3, BSD-302), 63bde3d5 (B2, BSD-400); jeweils run-ts --fast (typecheck, lint, Unit beider Formate, @smoke 29/29) grün, betroffene E2E in Chromium + WebKit grün. Schicht A 03:25–04:52, B 03:25–05:57, A2 ~04:50–05:00 (ohne Commit), A3 05:10–06:52, B2 05:52–07:00.

| Anforderung | Status | Notiz |
|---|---|---|
| BSD-455 Based Beta neben Based Next | 🟡 | Kanal-Tabelle packages/core/src/desktop-channel.ts: eigener Port 47822, local-beta.json/-token, „Based Beta Backups“, iCloud-Ordner „Based Beta“, Befehl based-beta; Mac-Test |
| BSD-456 Sicherung vor jedem App-Update, Migrations-Test alter Beta-Daten | 🟡 | Based-Archiv in $APPDATA/pre-update, zurückgelesen und geprüft, letzte 3; scheitert sie, kein Update; Fixtures beta-9614eb09 in beiden Formaten; Mac-Test |
| BSD-452 Node für Intel-Macs | 🟡 | universelle node (arm64 + x86_64) über scripts/macho.mjs; Mac-Test |
| BSD-433 Node signieren (Vorbereitung) | 🟡 | node.entitlements, sign-node.mjs, verify-app.mjs; Vorlage ci/github-actions-desktop-beta.yml – Elija kopiert nach .github/ |
| BSD-449 Backup-Ordner frei wählen | 🟡 | „Change folder…“, fehlender Ordner → Hinweis statt stillem Ausweichen; neue Abhängigkeit tauri-plugin-dialog 2.8.4 (MIT/Apache-2.0); Rust hier nicht kompiliert; Mac-Test |
| BSD-450 Wackelige E2E unter Last | ✅ | Upload-Wettlauf behoben, e2e/perf.ts (bester von 3, CI nur Warnung) |
| BSD-460 Share und „Not yet“-Seiten auf beta aus | ✅ | Beta-Gate |
| BSD-461 Keine leere Seite „Home“ | ✅ | Welcome ist Home |
| BSD-459 AI-Reste in My settings | ✅ | |
| BSD-436 Startvorlagen (Tasks, Notes, Journal, Wiki) | ✅ | packages/core/src/store/starter-templates.ts, auch unter ⌘N |
| BSD-447 Video/Audio mit Based-Bedienung | ✅ | BasedMediaPlayer in packages/ui |
| BSD-463 Willkommen verspricht keine Notion-Ansichten mehr | ✅ | |
| BSD-305 Teil 5/6 Editor-Feinschliff | 🟡 | e2e/beta-build.spec.ts gegen den Beta-Build; offen: Textauswahl-Farbe (Entscheidung Elija) |
| BSD-302 Teil 2–8 Zustands-Galerie | ✅ | erzwungene Zustände, Bildvergleich (nur Chromium/Linux), WebKit-Zeitgrenze behoben; Rest in BSD-465 |
| BSD-357 Rechtschreibvorschläge im Based-Menü | 🟡 | NSSpellChecker über Tauri-Befehle; Hülle hier nicht gebaut; Mac-Test |
| BSD-400 Tippen auf großen Seiten (WebKit) | 🟡 | Felder hängen nicht mehr an den Hüllen-props, renderRich ändert nur Textknoten; WebKit p50 (DPR 1) 25→15 ms, Chromium p95 44→20 ms; Mac-Messung |
| BSD-205 Einstellungen | 🟡 | im Beta-Umfang nichts mehr offen; Mac-Test |
| Neu offen: 464 (Einstellungen nach der Beta), 465 (Design-Kit-Bausteine), 466 (WebKit-Schatten .panel) | ❌ | alle blockiert mit Frage bzw. nach der Beta |

## Nachtlauf 2026-11-16 (Pass 37, TS-Stack)

Sammel-Merges 83606236 → a738bc1e; jeweils run-ts --fast (typecheck, lint, Design-Wächter, Unit beider Formate, @smoke) und betroffene E2E in Chromium + WebKit grün. Schicht A 03:12–07:40, Schicht B 03:12–07:48, Nachlauf A2/B2 07:50–08:45.

| Anforderung | Status | Notiz |
|---|---|---|
| BSD-440 (P0) Voller CI-Lauf rot: WebKit startet nicht | 🟡 | ubuntu-latest = Ubuntu 26.04, Playwright-WebKit braucht ICU 74; Vorlage ci/github-actions-ci.yml auf ubuntu-24.04 – Elija muss sie nach .github/ kopieren |
| BSD-442, BSD-448 (P0) Zeitmessungen in Unit-Tests rot unter Last | ✅ | logic.test und acp.test messen CPU-Zeit wie BSD-432; Schwellen unverändert |
| BSD-407 Teil 4b/4c: BlockNote ganz entfernt | ✅ | Server nimmt keine page:-Dokumente mehr an (alte Y-Zustände bleiben gespeichert); BlockNote, y-prosemirror, prosemirror-* aus packages/editor |
| BSD-438 Quick Find: Fokus springt zurück in die Seitenleiste | ✅ | auch Neu-Palette; 2 e2e-Tests |
| BSD-439 Quick Find: Auswahl hinter Listenende | ✅ | |
| BSD-280 Teil 5 Quick Find gegen Notion-Import messen | ✅ | |
| BSD-260 Teil 12–16 Dateiformate | 🟡 | Vorschau Text/Code/CSV (Kern), Excel-CSV, Word ☐/☑, CSV-Formelschutz, YAML-Frontmatter; offen: Anzeige im Datei-Block |
| BSD-231 Teil 3a–3e lokale Modelle | 🟡 | E5-Embeddings im Worker (onnxruntime-web, MIT), Suche + verwandte Seiten nach Bedeutung, whisper.cpp auf dem based-server; Mac-Test; offen: Einstellungs-Schalter |
| BSD-441, 445, 446, 451 Import/Export-Rundreisen (PRÜFEN Import/Export) | ✅ | Archiv-Papierkorb, Markdown-Escapes, eigener HTML-Export, Dateien im Workspace-Export |
| BSD-400 Teil 1/2 Tippen auf großen Seiten | 🟡 | Modell < 1 ms je Taste; Render-Fix auf wip/2026-11-16-b-BSD-400 (Chromium p95 50→21 ms, WebKit unter Last unklar) – Mac-Messung |
| BSD-301 Teil 4, 304 Teil 4 Überlauf, axe | ✅ | Home-Überdeckung behoben; axe auf 8 Screens; neue Test-Abhängigkeit @axe-core/playwright (MPL-2.0) |
| BSD-302 Teil 1, 305 Teil 4, 350 Teil 4, 417 Teil 1 | 🟡 | Token-Farben in allen Zuständen; Editor-Rest-Zustände; BasedChip; „Bewegung reduzieren“ überall |
| BSD-429 Synced Block Griff, BSD-443 Seitenbaum-ARIA, BSD-444 Tabellen-ARIA, BSD-346 Gliederung (Test) | ✅ | Nachlauf A2/B2; axe ohne Ausnahmen |
| BSD-260 Teil 17 Vorschau im Datei-Block (Text, CSV) | 🟡 | offen: Syntax-Hervorhebung, HTML-Varianten |
| Neu offen: 447 (Video/Audio-Steuerleiste), 450 (wackelige E2E unter Last) | ❌ | |

## Nachtlauf 2026-11-15 (Pass 36, TS-Stack)

Zwölf Sammel-Merges 993e9f88 → 6f8746cb; jeweils run-ts --fast (typecheck, lint, Design-Wächter, Unit beider Formate, @smoke) und betroffene E2E in Chromium + WebKit grün. Beide Schichten um ~08:20 vom Ausgabelimit gestoppt; Reste gemergt um 11:00.

| Anforderung | Status | Notiz |
|---|---|---|
| BSD-423 (P0) Archiv-Import zeigt nichts | 🟡 | Import holt Papierkorb/Gelöschtes mit neuem Stempel zurück; Mac-Test |
| BSD-416 WebKit: neue Seite nach sofortigem Neuladen weg | ✅ | Journal unbestätigter Änderungen beim Verlassen; persist-reload.spec |
| BSD-424 Lokaler Server „exit 1 … Node v26“ | 🟡 | Ursache belegter Port 47821, jetzt verständliche Meldung; Mac-Test |
| BSD-414 Node-Laufzeit mit der App ausliefern | 🟡 | Node v24 per fetch-node.mjs (SHA-256 gepinnt); Signatur = BSD-433; Mac-Test |
| BSD-425 Quick Find findet zu wenig | 🟡 | verteilte Begriffe, Optionen, Dateinamen, Tippfehler; Mac-Test |
| BSD-427, 431, 437 Sync (Zukunfts-Stempel, Ordner-Sync, verwaiste Blöcke) | ✅/🟡 | aus PRÜFEN Sync; 431 Mac-Test |
| BSD-410 Fixtures Agent Brain Teil 2, 411 Teil 2, 430 Asset-Migration, 432, 435 | ✅ | 435: 100.000 Zeilen öffnen (Stack-Overflow behoben), Sync 1,6 → 0,7 s |
| BSD-407 Teil 4a + 2g: BlockNote aus dem Client, Formatleiste aus Based-Bausteinen | 🟡 | offen: 4b/4c (kopfloser Konverter für alte page:-Dokumente) |
| BSD-310 ⌘W, 309 schmale Fenster ab 640 px, 358 Rechtsklick-Einfügen, 422 Sync-Karte | 🟡 | Mac-Test |
| BSD-341, 342, 344, 347/428, 340, 419, 421 | ✅ | Editor-/Shell-Feinschliff |
| BSD-260 Teil 11 (Google Docs), 231 Teil 2c-Kern, 305 Teil 3, 350 Teil 3 | 🟡 | Teile gelandet, Einträge bleiben Bereit |
| BSD-280 Teil 5 | ❌ | abgebrochen, WIP auf wip/2026-11-15-a-BSD-280 |

## Nachtlauf 2026-11-14 (Pass 35, TS-Stack)

Sieben Sammel-Merges, main = 64558736; jeweils run-ts --fast (typecheck, lint, Design-Wächter, Unit beider Formate, @smoke) und betroffene E2E in Chromium + WebKit grün.

| Anforderung | Status | Notiz |
|---|---|---|
| BSD-408 Volles E2E auf main rot (Blockmenü-Suche, ⇧Tab-Modus, editor-drag) | ✅ | Blockmenü/Seitenleiste wurden bei jedem Neuzeichnen neu eingehängt; Long-Poll setzte den Modus zurück |
| BSD-404 Dependabot (vitest 4, vite 6.4.6, katex 0.18, minimatch 11) | ✅ | pnpm audit leer; glib (Tauri/gtk3) bleibt mit Grund offen |
| BSD-403 Agent-Berechtigungen „fragt immer“ + Werkzeug-Aliasse wie Swift | ✅ | Fixture-Runner ohne die Abweichungen grün; Folge: 411 |
| BSD-402 Gast mit Nur-Lesen-Link ohne Share/Schreib-Einträge | ✅ | guest.spec beide Browser |
| BSD-407 BlockNote entfernen – Teil 1–2f | 🟡 | Lückenliste in docs/editor-parity.md; neuer Editor: Blockmenü-Suche, Copy as Markdown, Move to, Turn into page, [[, Bookmark, KaTeX inline, Bild per Link, Embed, PDF, Copy and sync, HTML-Vorschau. Offen: Teil 2g, 3 (Standard umschalten, Specs), 4 (löschen) |
| BSD-391, 409, 412, 413, 415 | ✅ | Seitenzeile, Icon-Export, Design-Wächter-Parser, Blockmenü-Lage, Website-Aussagen (docs/website-claims.md) |
| BSD-280 Teil 3–4, 260 Teil 10, 231 Teil 2b, 262 Teil 2a, 411 Teil 1 | 🟡 | Teile gelandet, Einträge bleiben Bereit |
| BSD-416 WebKit: neue Seite fehlt nach sofortigem Neuladen | ❌ | P1, möglicher Datenverlust – nächste Nacht zuerst |

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
| Whiteboard | 🟡 | BSD-263 Datenmodell, Yjs-Schema, Tinten-Codec; BSD-264 Board-Seite mit Fläche, Zettel, Rechteck (auf beta ausgeblendet); offen: Stift BSD-265, Text BSD-266, Verbindungen BSD-267 |
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

