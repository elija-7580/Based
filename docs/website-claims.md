# Website-Aussagen gegen den Beta-Umfang (BSD-415)

Stand: Website-Branch `site/basednotes-app` @ 1dda22c (14.11.2026, 01:50), Seiten Start (Desktop + Handy),
Workspace, Agents, Leaving Notion, Roadmap, Manifesto. Abgleich mit `replica/features.csv` (Spalten `beta` und `ts`)
und dem Backlog. Geprüft von der Nachtschicht (Schicht A, 14.11.); die Texte selbst ändert nur Elija, auf dem
Website-Branch wurde nichts geändert.

**Status:** **ohne Grundlage** = die Beta kann es nicht und die Seite sagt nicht „by release“ ·
**teilweise** = Kern da, Aussage geht weiter · **Release** = nach der Beta, auf der Seite schon so gekennzeichnet ·
**Beta** = mit Beleg da.

**Teil 2 (ebenfalls hier):** Inhalte, die die Seiten aus Daten im Skript zeichnen – r/Notion-Karten (Start),
Vergleichstabelle und „The list everyone has“ (Leaving Notion), Funktionskacheln (Workspace), Steuerung, Fähigkeiten
und Modelle (Agents), Phasen (Manifest). Nicht bewertet: Aussagen über Notion und Obsidian (Quellen stehen auf der Seite).

## 1. Ohne Grundlage (je ein Vorschlag)

| # | Aussage (Seite) | Befund | Vorschlag |
|---|---|---|---|
| 1 | „Meeting notes transcribed on your Mac, offline“ – Liste „Beta on the Mac“ (Start) | Keine Transkription im TS-Stack: `Transcriber` hat nur eine Test-Implementierung; Modelle sind katalogisiert und ladbar, aber ohne Laufzeit (BSD-226, BSD-231 Teil 3 offen). features.csv „AI meeting notes“: beta = labs, ts = partial. | In „Release“ verschieben oder „Meeting notes with recording and timestamps; offline transcription after beta“. |
| 2 | „Sync between your Apple devices through iCloud“ – „Beta on the Mac“ (Start), „The beta syncs your Apple devices through iCloud“ (Workspace), „iCloud in the beta“ (Agents, Workspace) | Ordner-Sync über iCloud Drive ist ein Spike hinter einem Schalter (BSD-296/334, ADR 0015, `packages/sync/src/folder.ts`, Standard aus); BSD-414 (Node-Laufzeit für Backups und iCloud-Sync) ist blockiert. Kein iPhone-Client in der Beta (features.csv „Sync between Mac and iPhone“: after). | „Sync between your Macs through iCloud Drive (preview)“ – und „Apple devices“ erst, wenn es den iPhone-Client gibt. |
| 3 | „Or run one locally.“ / „Bring your own keys, or run models locally.“ (Agents, Start) | Lokale Modelle: Lader + Katalog + OPFS-Ablage da (BSD-231 Teil 1–2b), aber keine Laufzeit für Chat-Modelle; lokale Modelle sind nur für Transkription/Embeddings/Redact geplant. | Satz streichen oder „Local models for private tasks after beta“. |
| 4 | „On your Mac, on your phone, in your inbox“ – Agenten melden sich (Agents) | In der Beta nur auf dem Mac (Needs-you-Inbox in der App, features.csv „Approval inbox“: beta). Kein Handy, keine E-Mail-Benachrichtigung. | „On your Mac today; phone and email after beta“. |
| 5 | „Open source · Your data, your devices · AI only if you switch it on · Built in Vienna, EU servers“ (Start) und Badge „EU servers“ (Handy-Start) | Es gibt in der Beta keine Based-Server (Based Cloud kommt zum Release); „EU servers“ steht ohne „by release“. | Badge „EU servers“ → „EU cloud at release“ oder in der Beta weglassen. |
| 6 | „Three copies … Your device, your encrypted cloud and snapshots in a folder you choose. Restore is one click.“ (Handy-Start 03, Workspace „Backups“) | Lokale Backups teilweise (BSD-274, features.csv: beta, ts = partial – lokaler Server sichert nach ~/Documents/Based Backups); „encrypted cloud“ gibt es in der Beta nicht; Ein-Klick-Wiederherstellen in der Mac-App hängt an BSD-414 (blockiert). | „Two copies in the beta (your Mac and a backup folder), the encrypted cloud copy at release.“ |

## 2. Teilweise

| # | Aussage (Seite) | Befund | Vorschlag |
|---|---|---|---|
| 7 | „Databases with a hundred thousand rows stay instant“ / „a hundred thousand rows feel like ten“ (Start, Handy) | Gemessen und im Test sind 50 000 Zeilen (features.csv „Large database performance (50k rows)“: beta, yes; `packages/core/test/large-database.test.ts`). 100 000 nicht gemessen. | Auf „fifty thousand rows“ ändern oder eine 100k-Messung ergänzen (eigener Eintrag). |
| 8 | „Four positions, per task. Change it any time, even mid-run.“ (Agents) | Vier Modi da (Ask / Ask before edits / Work freely / Plan, BSD-245; features.csv beta = labs). „Per task“ und „mid-run“ nicht belegt (Modus gilt je Chat/Agent/Projekt). | „Four positions, per agent or chat.“ |
| 9 | „Connect the ChatGPT or Claude account you already pay for“ (Agents) | ChatGPT über Codex-Login: beta, ts = partial; Claude nur über die Claude-Code-CLI (ACP), nicht als Konto-Login. | „Use the ChatGPT login or the Claude Code CLI you already have, or an API key.“ |
| 10 | „Logs, too … Agents write to it through the CLI or MCP.“ (Workspace) | CLI `based`: beta = labs, ts = partial (Seiten/Suche über MCP); MCP-Server: labs, partial. | „through MCP (CLI coming)“. |
| 11 | „Every line they write is signed“ / „Yellow ticks are agent edits. Each one can be undone on its own.“ (Start, Agents, Workspace) | Agenten-Markierung und Versionsverlauf da (features.csv „Page history / versions“: beta, yes); „einzeln rückgängig machen“ je Agenten-Änderung nicht belegt. | „Yellow ticks are agent edits; restore any earlier version.“ |
| 12 | „Any AI can join through MCP“ (Start, Agents) | MCP-Server (stdio + HTTP) da, beta = labs, ts = partial. | lassen, als „labs“ kennzeichnen. |

## 3. Release – auf der Seite schon als „by release“ bzw. „Release“ gekennzeichnet

| Aussage | Beleg |
|---|---|
| „Based Cloud on EU servers, end-to-end encrypted“, „Your phone gets everything. The server gets gibberish.“ | Liste „Release“ und „by release“ auf Workspace/Agents; features.csv „E2E encrypted transcripts“: after, ts = no. Die Überschrift „Your phone gets everything …“ steht aber ohne Hinweis über einem Bild Mac ↔ iPhone – Hinweis „at release“ in die Überschriftenzeile ziehen. |
| „iPhone, iPad, web, then Windows, Linux and Android“ | Liste „Release“. |
| „One agent session across terminal, cloud and phone“, „Terminal, cloud, phone. Same conversation.“ | Liste „Release“; auf der Agents-Seite steht die Überschrift ohne Hinweis, nur der Fußtext nennt „The beta starts on the Mac“. |
| „Self-hosting for anyone who wants it“, „Self-host with one command, same apps.“ | features.csv „Self-hosted server sync“: after, ts = yes (`deploy/`, Docker). „One command“ stimmt mit `deploy/`; „same apps“ erst mit den Clients zum Release. |

## 4. Beta – mit Beleg

| Aussage | Beleg |
|---|---|
| „Mac app, data stored locally“, „Offline is the default. Every row, every formula.“ | Tauri-Desktop (ADR 0011), features.csv „Offline editing“: beta, yes. |
| „Databases, pages, import from Notion“; „Drop the ZIP into Based. Pages, databases, relations and nesting are rebuilt locally.“ | features.csv „Import Notion export“: beta, yes (BSD-254, auch ≥ 500 MB); Ansichten über den API-Import (BSD-217). |
| „Tables, boards, timelines and calendars … Filters, relations, rollups, linked views and full pages inside every row.“ | features.csv Datenbank-Zeilen (beta, yes). |
| „Agents with your own keys, opt-in“, „AI only if you switch it on“ | AI-Schalter (aus = keine AI-Flächen), eigene Schlüssel; Agenten beta/labs. |
| „every version since day one, no plan limit“ | features.csv „Page history / versions“: beta, yes. |
| „Same slash menu, same ⌘K“ | Block-Editor + Quick Find (beta, yes). |
| „Schedule agents to run while you sleep“ | features.csv „Custom agents on schedule“: labs, partial (Server legt fällige Läufe an). Als „labs“ kennzeichnen. |
| „Open source“ | LICENSE: MIT. „every line is in the public repo“ (Manifest) setzt voraus, dass das Repo öffentlich ist – vor dem Start prüfen. |

## 5. Teil 2 – Aussagen aus Skriptdaten

### Ohne Grundlage (je ein Vorschlag)

| # | Aussage (Seite) | Befund | Vorschlag |
|---|---|---|---|
| 13 | „Every row opens as a full page with blocks, sub-pages and comments.“ (Workspace, Kachel) | Kommentare gibt es im TS-Stack nicht (kein Record-Typ; features.csv „Comments and discussions“: after, ts = no). | „… with blocks and sub-pages.“ |
| 14 | „When a property changes, do something. Or ask an agent to.“ (Workspace, Kachel Automationen) | Keine Datenbank-Automationen; im Manifest selbst als spätere Phase („automations“) genannt. | Kachel als „after beta“ kennzeichnen. |
| 15 | „Meeting notes when you start them, transcribed on your device, offline. The audio never leaves your Mac.“ (Start, r/Notion-Karte) | wie #1 – keine Transkription. | „Meeting notes with recording and timestamps; on-device transcription after beta.“ |
| 16 | „Connect ChatGPT, Claude, an API key or a local model“ / „Run a model on your own machine for anything sensitive. Nothing leaves the device.“ (Start-Karte, Leaving Notion, Agents) | wie #3 – keine Laufzeit für lokale Modelle. | „local models after beta“. |
| 17 | „Three copies: your device, your encrypted cloud and automatic snapshots to a folder you choose. Restore is one click.“ / „Every version kept, three copies, restore in one click.“ (Leaving Notion, Vergleich) | wie #6. | wie #6. |
| 18 | „Beta is Mac only with iCloud.“ (Leaving Notion, Vergleich) | wie #2 – iCloud-Ordner-Sync ist ein Spike hinter einem Schalter. | „Beta is Mac only; iCloud sync as a preview.“ |

### Teilweise

| # | Aussage (Seite) | Befund | Vorschlag |
|---|---|---|---|
| 19 | „Agent edits can be undone one by one.“ (Leaving Notion), „Every edit is marked and can be undone in one step.“ (Agents, Stufe „Work freely“) | Markierung da; Rückgängig über Undo/Versionsverlauf, kein eigenes „diese Agenten-Änderung zurücknehmen“. | wie #11. |
| 20 | „Agents never delete or share anything without asking.“ (Start) | Seit BSD-403 fragen endgültiges Löschen, Inbox-Antworten, Senden über externe Werkzeuge und Shell ohne Sandbox auch in „Work freely“ – außer eine allow-Regel erlaubt es ausdrücklich. In den Papierkorb legen fragt in „Work freely“ nicht. | „… never delete for good or send anything out without asking, unless you allow it.“ |
| 21 | „Talk to your workspace from the CLI. Works offline against your local copy.“ (Agents) | CLI `based`: labs, partial (über MCP; ask/runs/inbox erst mit dem TS-Server). | als „labs“ kennzeichnen. |
| 22 | „Opt-in and planned: … a local check flags names, numbers and other private details.“ (Agents, Start) | als „planned“ gekennzeichnet – passt (Redact Stufe 2 hängt an BSD-231). | lassen. |
| 23 | „A hundred thousand rows feel like ten.“ (Leaving Notion, zweimal) | wie #7 (gemessen 50 000). | wie #7. |

### Beta – mit Beleg

| Aussage | Beleg |
|---|---|
| „Table, board, list, gallery, calendar, timeline. Same rows, any shape.“, „The formula language you know, evaluated locally and offline.“ | features.csv List/Gallery view, Formeln (beta, yes). |
| „Row templates for meetings, clients, lectures, bug reports.“ | „Database templates“: beta, yes. |
| „Markdown with real file names and a lossless archive. Leaving takes one click.“ | „Export Markdown …“, „Lossless workspace archive export/import“: beta, yes. |
| „Teach an agent a routine once …“, „What agents learn … kept as pages“, „Ask your whole workspace. Every answer links to the pages it came from.“ | Skills, AI memories (beta, yes), Zitate (`packages/brain/src/cite`). |
| „Deadlines, approvals and what changed overnight, saved as a row in your briefings database.“ | Daily Brief / Needs-you (beta). |
| „No AI buttons … Based is a complete workspace without a single model connected.“ | AI-Schalter (e2e ai-switch.spec). |
| Manifest-Phasen („Monorepo, types, golden fixtures, CI“ … „Tabs, supertags, whiteboard, PDF notes, automations“) | Plan, keine Beta-Aussage. |
