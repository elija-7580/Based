# TS-based-server (`apps/server`)

Der TypeScript-Server aus Phase 3 (BSD-158, ADR 0011). Er spricht dasselbe Sync-v2-Protokoll wie der Swift-
`based-server` ([sync-protocol.md](sync-protocol.md)) auf demselben SQLite-Dateiformat und bietet MCP
([mcp.md](mcp.md)) und Echtzeit-Text über Hocuspocus (Yjs). Erster Schnitt: Sync, MCP-Seitenwerkzeuge, Hocuspocus.
Dazu Teilen (Freigaben, Links, Publish to web, [sharing.md](sharing.md)) und Sandboxen pro Lauf. Agenten,
Captures usw. bleiben vorerst beim Swift-Server (siehe „Offen“). Die Kommandozeile `based` liegt in `apps/cli`.

## Starten

```sh
pnpm --filter @based/server start -- --token "$(openssl rand -hex 24)" --db ./based.sqlite --port 8787
pnpm --filter @based/server start -- --stdio --db ./based.sqlite     # MCP für Desktop-Clients (kein Token nötig)
```

| Option | Umgebung | Standard | |
|---|---|---|---|
| `--token` | `BASED_TOKEN` | – | **Pflicht** für HTTP: ohne Token startet der Server nicht (Exit 2). Unter 16 Zeichen: Warnung |
| `--db` | `BASED_DB` | `based.sqlite` | Workspace (gleiches Format wie Swift-App und -Server) |
| `--port` | `BASED_PORT` | `8787` | |
| `--host` | `BASED_HOST` | `0.0.0.0` | |
| `--node` | `BASED_NODE` | `server` | HLC-Kennung der Server-Stempel; zwei Server am selben Workspace brauchen verschiedene |
| `--public-url` | `BASED_PUBLIC_URL` | – | einziger Origin mit CORS-Headern |
| `--stdio` | | aus | MCP über stdin/stdout statt HTTP |
| `--sandbox` | `BASED_SANDBOX` | aus | `docker` oder `local`: Sandbox pro Lauf, Routen `/sandbox/*` |
| `--sandbox-dir` | `BASED_SANDBOX_DIR` | `<db>.sandbox` | Snapshot-Archive |
| | `BASED_LOG_LEVEL` | `info` | `debug` loggt jede Anfrage |

Neben der Datenbank legt der Server `<db>.collab.sqlite` an (Y-Zustände für `/collab`).

Ohne Token gibt es keinen Loopback-Sondermodus wie beim Swift-Server (`--insecure-public`): der TS-Server
verweigert den Start.

## Endpunkte

| Methode | Pfad | Zugriff | Body-Grenze | |
|---|---|---|---|---|
| GET | `/health`, `/` | öffentlich | | `{ok, name, impl: "ts", protocol: 2, time}` |
| GET | `/sync/v2/info` | Owner, Gast | | `{protocol, seq, oldestSeq}` |
| POST | `/sync/v2/push` | Owner, Gast | 32 MiB | `{records, deletions}` → `{newer, seq, deleted}`; Gäste nach Rolle geprüft |
| GET | `/sync/v2/pull?after&limit` | Owner, Gast | | Seiten, `limit` 1…5000 (Standard 500); Gäste gefiltert |
| GET | `/sync/v2/wait?after&timeout` | Owner, Gast | | Long-Poll, 1…55 s (Standard 25) |
| GET | `/p/<id>[/<page>]`, `/s/<secret>` | öffentlich | | Publish to web, Link-Landeseiten ([sharing.md](sharing.md)) |
| | `/share/v1/…` | Owner, Gast | 4 KiB | Freigaben, Links, Widerruf ([sharing.md](sharing.md)) |
| | `/sandbox/…` | Owner | | Läufe, Snapshots, Restore, Aufräumen (nur mit `--sandbox`) |
| POST | `/sync/push`, GET `/sync/pull?since` | Owner | 32 MiB | v1 für sehr alte Apps (Stempel-Cursor) |
| POST | `/mcp` | Owner | 32 MiB | MCP Streamable HTTP (zustandslos, JSON-Antworten) |
| GET/DELETE | `/mcp` | Owner | | 405 (kein SSE) |
| WS | `/collab` | Token in der Auth-Nachricht | 16 MiB/Nachricht | Hocuspocus, Dokument `page:<id>` |

„Gast“ = Geräte-Token (`bdu_…`) oder Access-Link-Geheimnis (`bdl_…`); ein gültiger Gast-Token an einer Owner-Route
bekommt 403. Router-Kette wie Swift `ServerRouter` (ADR 0006): CORS-Preflight → Route (404, 405 mit `Allow`) →
Authentifizierung → Body lesen mit Grenze (413) → Handler. Unterschiede zum Swift-Router: Auth kommt **vor** dem
Lesen des Bodys (Unangemeldete können keine 32 MiB hochladen); der Token wird nur aus `Authorization: Bearer`
gelesen (nie `?token=`) und in konstanter Laufzeit verglichen.

Timeouts: `headersTimeout` 30 s, `requestTimeout` 120 s (deckt den längsten Long-Poll von 55 s), `keepAlive` 5 s.

Logs: JSONL auf stderr (`t, level, category, message` + Felder). Nur Methode, Pfad ohne Query, Status, Dauer,
Anzahlen – keine Titel, Texte, Bodies oder Tokens. Fehler loggen nur den Fehlertyp.

## Sync v2: Umsetzung

`SyncService` (`src/sync.ts`) = `WorkspaceStore` + `SqlitePersistence` aus `@based/sync`, wie der Swift-Server
Client-Code wiederverwendet. Eingehende Pushes werden als *remote* geloggt; `pull` liest das Change-Log.

- **Push** dekodiert streng (Zod-Schema aus `@based/core`): ein ungültiger Record → 400 für den ganzen Push (wie
  Swift `SyncPush`). Fehlendes `deletions` gilt als leer. Ungestempelte Löschungen stempelt der Server.
- **Pull** liest `limit + 1` Einträge, `more` = es gibt mehr. Ungültige Zahlen (`after=-1`, `after=x`) → 400
  (Swift nimmt dann still 0).
- **Wait** ist ereignisgesteuert: ein Store-Beobachter weckt wartende Anfragen (Swift fragt alle 400 ms ab).
  Schließt der Client die Verbindung, wird der Wartende sofort entfernt; beim Herunterfahren antworten alle.
- **seq** = `max(MAX(changes.seq), oldestSeq)`: bleibt monoton, auch wenn die GC die oberste Zeile entfernt.
- **Tombstone-GC** beim Start und stündlich: gestempelte Löschzeilen älter als 90 Tage, `meta sync.oldestSeq`
  steigt (gleicher Schlüssel und gleiches Format wie Swift, die Datei ist austauschbar).
- **v1** (`/sync/push|pull`): Tombstones kommen aus dem Change-Log (nicht aus `meta sync.tombstones`). Aktuelle
  Swift-Clients nutzen v1 nur nach einem 404 auf v2, also nie gegen diesen Server.
- Der Swift-Server legt beim Start eigene Records an (Agent-Brain-Datenbanken, Workspace-Record mit frischem
  Stempel); der TS-Server nicht. Er ändert beim Start nichts am Workspace.
- **Workspace-Record beim ersten Sync (BSD-179):** Gegen den Standard-Record des Swift-Servers („My Workspace“,
  Stempel = Startzeit, node `server`) verliert per Last-Writer-Wins der ältere Record eines Geräts – Name, Icon,
  Favoriten, Home-Seite, Teamspaces. Der TS-Server legt keinen solchen Record an (frischer Server: Change-Log leer).
  Übernimmt er eine Datei vom Swift-Server, steht der Record aber darin. Deshalb in `SyncService.push`: solange der
  Workspace-Record der unberührte, vom Server selbst gestempelte Standard ist (node = `--node`, Standardname, keine
  Favoriten/Teamspaces/Icon/Home-Seite), gewinnt der gepushte Record eines Geräts und bekommt einen frischen
  Server-Stempel (so erreicht er auch Geräte, die den Standard schon geholt haben). Kein neues Feld auf dem Draht.
  Der Swift-Server ist unverändert und hat den Fehler weiter. `test/fresh-server-workspace.test.ts`.

## Dateien (Assets, BSD-78)

`src/assets.ts`, Protokoll in `docs/sync-protocol.md` („Assets“). Blobs liegen als Dateien neben der Datenbank:
`<db>.assets/<ersten 2 Hex>/<sha256>`, angefangene Uploads in `partial/`, Vormerkungen der GC in
`unreferenced.json` (`--assets <dir>` / `BASED_ASSETS_DIR`, Grenze `--max-asset-mb` / `BASED_MAX_ASSET_MB`,
Standard 100). Die SQLite-Datei bleibt unverändert (gleiches Format wie Swift). Der Router kennt dafür Pfadmuster
(`/sync/v2/asset/:hash`), `PUT` und `HEAD`; Auth und Body-Grenze (8 MiB je Stück) wie bei jeder Route, ins Log kommt
das Muster statt des Pfads. Aufräumen (`App.collectAssets`) läuft mit der Tombstone-GC. Backups müssen den
Assets-Ordner mitnehmen. `test/assets.test.ts`.

## MCP

`src/mcp.ts` mit `@modelcontextprotocol/sdk` (Protokollversionen laut SDK). Werkzeuge: `based_guide`, `search`,
`read_page`, `list_pages`, `create_page`, `append_markdown`, `replace_page_content`, `update_page`, `trash_page`,
`restore_page`, `list_trash`; Datenbanken (BSD-221): `list_databases`, `database_schema`, `query_database` (Suche
in allen Zellen, Sortierung nach Property, Seiten), `add_row` / `update_row` (Properties per Name, Werte als Text;
neue Select-Optionen werden angelegt, ungültige Werte werden vorher abgelehnt – keine halb angelegten Zeilen).
Noch nicht im TS-Server: Projekte, Runs, Inbox, Hauptagent, Skills als Prompts, Berechtigungsregeln. Ressourcen `based://docs/<topic>` (overview, markdown, safety) und
`based://page/<id>` (Liste: die ersten 500 Seiten). Seiten kommen als Markdown (`MarkdownExporter` aus
`@based/core`), Links auf Seiten als `based://page/<id>`; Markdown wird mit `MarkdownImporter` zu Blöcken, Links
auf `based://page/<id>` werden Erwähnungen. Änderungen sind lokale Änderungen des Servers und erreichen Geräte per
Sync v2. Werkzeugfehler (unbekannte Seite, Seite im Papierkorb) kommen als `isError`-Antwort.

## Echtzeit-Text (`/collab`)

`src/collab.ts`: `@hocuspocus/server` (v4) hinter dem eigenen HTTP-Server (`ws`, `noServer`). Ein Y.Doc je Seite,
Name `page:<id>`, XML-Fragment `blocks` wie `packages/editor` (`DocSession`). Auth über die Hocuspocus-Auth-
Nachricht (Provider-Option `token`), unbekannte Seiten werden abgewiesen. Speichern 2 s nach der letzten Änderung
(spätestens 10 s) in `<db>.collab.sqlite`, Tabelle `yjs_documents(name, state, updated)`.

**Brücke Y.Doc ↔ Records (BSD-220, Teil 1):** Je geladenem Dokument läuft eine `DocSession` aus
`@based/editor/headless` (kopfloser BlockNote-Konverter, läuft in Node ohne DOM). Regeln:

- **Nur der Server füllt.** Gibt es noch keinen Y-Zustand, füllt der Server das Y.Doc aus den Records und setzt
  `based.origin = "server"` (Y.Map `based`). Ein Gerät übernimmt Records nie selbst in ein Dokument, das es mit
  `/collab` abgleicht (sonst doppelter Inhalt); ein lokal gefüllter Zustand ohne diese Markierung wird beim ersten
  Verbinden verworfen und durch den des Servers ersetzt (Client-Teil, BSD-220 Teil 2).
- **Text gewinnt über Yjs.** Y-Änderungen der Geräte schreibt der Server nach 120 ms Ruhe als eine
  Store-Transaktion (frische HLC-Stempel) – so erreichen sie Sync v2 und den Swift-Client. Zwei Geräte, die offline
  denselben Absatz ändern, behalten beide Änderungen (Yjs-Merge statt LWW).
- **Records von außen** (Sync-Push eines Geräts ohne Yjs, Swift-Client, MCP, Agenten) übernimmt der Server per Diff
  ins Y.Doc; die Geräte bekommen sie über Yjs. Für solche Records gilt weiter LWW je Block gegen gleichzeitige
  Y-Änderungen desselben Blocks.
- **Kein Zustand geht verloren, den Geräte kennen:** Diffs aus dem Store speichert der Server sofort (vor dem
  Verteilen), Y-Änderungen der Geräte vor dem Materialisieren; beim Laden wird nach dem Nachziehen gespeichert.
- Ein Update, das nicht zum Schema passt, wird protokolliert (ohne Inhalt) und ändert keine Records.

**Web-Client, Y-Zustände (BSD-220 Teil 2):** Der Store-Worker legt den Y-Zustand jeder Dokument-Wurzel in
`ydocs.sqlite` neben dem Workspace ab (Tabelle `ydocs(root, state, updated)`, nie gesynct; eigene Datei wie
`history.sqlite`, damit `based.sqlite` für die Swift-App auf v3 bleibt). Der Editor holt den Zustand vor dem Öffnen
(`YDocStore.prepare`, Protokoll `ydocLoad`/`ydocSave`); fehlt er oder ist er kaputt, baut die `DocSession` ihn aus
den Records neu – die Records bleiben die Quelle.

Offen (Teil 3): Geräte mit `/collab` schreiben ihre Text-Records nur lokal (kein Push, der Server materialisiert),
sonst kann ein Record-Push, der vor dem Y-Update desselben Geräts ankommt, als Diff noch einmal eingefügt werden;
Web-Client: Provider an `/collab` mit Token aus dem verschlüsselten Speicher, Abstammungs-Regel oben. Synced-Block-Originale (eigene Wurzeln) haben noch kein `/collab`-Dokument.

## Sandbox pro Lauf (BSD-161)

`src/sandbox.ts` (Port von Swift `Sandbox.swift`, `SandboxPart3/4.swift`). `DockerSandboxProvider` steuert die
`docker`-CLI über einen `CommandRunner`: ein Container je Lauf (`--init`, Labels `based.sandbox`/`based.run`,
`--cpus`, `--memory`, `--pids-limit`, `no-new-privileges`, `--cap-drop ALL`, optional `--network none`), Projekt-
ordner unter `/workspace/<projekt>`. Umgebung nur über `SandboxEnvironmentPolicy` (Allowlist; Namen, die nach
Geheimnis aussehen, nur ausdrücklich) und nur als `-e NAME` – Werte nie in argv, nie im Log; die docker-CLI selbst
bekommt nur `PATH`, `HOME`, `DOCKER_*`. Snapshot = `docker commit` + tar.gz des Ordners; Restore ersetzt den
Container und legt den alten Ordner als `<ordner>.before-restore-<zeit>` daneben. `LocalSandboxProvider` arbeitet
direkt im Ordner (Snapshots als tar.gz). `SandboxManager` hält die Sandboxen pro Lauf, beendet sie beim
Herunterfahren und findet verwaiste Container; Aufräumen alter Archive/Images/Sicherungen nur mit Bestätigung und
nur, was ein frischer Scan meldet. Owner-Routen `/sandbox/runs[/<run>]`, `…/snapshots`, `…/restore`, `…/stop`,
`/sandbox/leftovers`, `/sandbox/cleanup`. Gestartet werden Sandboxen vom Agenten-Laufzeitsystem, das im TS-Server
noch fehlt; der Treiber für Claude Code im Container ist nicht gebaut. Docker selbst ist ungeprüft (Tests mit
gemocktem Prozess); die lokale Variante läuft in den Tests mit echtem `tar`. Die Docker-Engine-API (statt CLI) ist
nicht umgesetzt.

## Betrieb und Härtung (BSD-75)

- Long-Poll (`/sync/v2/wait`, `/coding/…`) ist ereignisgesteuert: jede gespeicherte Änderung weckt die Wartenden,
  kein Abfragen, kein blockierter Thread. Grenzen: höchstens 16 offene waits je Client (Owner bzw. geteilter
  Principal) und 1024 insgesamt (`maxWaitsPerClient`, `maxWaits`); darüber `429` mit `Retry-After: 5` (der
  Sync-Client wartet dann mit Backoff).
- Logs: JSONL auf stderr, nur Methode, Pfad ohne Query, Status, Dauer, Zähler – keine Titel, Texte, Tokens, Bodies.
- Docker: `deploy/server-ts.Dockerfile` + `deploy/docker-compose.ts.yml` – läuft als Nutzer `node`, Dateisystem
  schreibgeschützt bis auf `/data` und `/tmp`, `cap_drop: ALL`, `no-new-privileges`, `HEALTHCHECK` auf `/health`,
  Backup-Dienst (`deploy/backup.sh`: täglich `sqlite3 .backup`, 7 Tage).

## Coding-Agenten (BSD-223)

Aus, solange der Server ohne `--coding-root <ordner>` (wiederholbar; oder `BASED_CODING_ROOTS=/a:/b`) startet.
Sitzungen laufen nur in diesen Ordnern; der Agent darf über `fs/*` nur im Sitzungsordner lesen und schreiben
(Symlinks aufgelöst). Agenten: Standardliste aus `@based/brain` (`DEFAULT_AGENTS`: Claude Code, Codex, Gemini CLI,
OpenCode), gestartet mit gefilterter Umgebung (Allowlist, BSD-33; `BASED_*` und Geheimnis-Namen nie). Für einen
Agenten freigegebene Variablen: `BASED_CODING_ENV="claude=ANTHROPIC_API_KEY,gemini=GEMINI_API_KEY"`. Token auf der
Kommandozeile eines Agenten werden abgelehnt. Eigene oder geänderte Agenten: `--coding-agents agents.json`
(bzw. `BASED_CODING_AGENTS`), eine Liste wie `[{"id":"mine","name":"Mein Agent","command":"my-acp","args":["--acp"]},
{"id":"gemini","enabled":false}]` – gleiche `id` ändert einen Standard-Agenten. Im Web-Client: Seitenleiste → Coding
(`#coding`). Alle Routen nur mit Owner-Token:

| Route | Zweck |
|---|---|
| `GET /coding/agents` | eingeschaltete Agenten |
| `GET/POST /coding/sessions` | Sitzungen; anlegen mit `{agent, cwd, mode?, resume?, handoffFrom?}` (`handoffFrom` = Agentenwechsel, das Transkript der alten Sitzung geht mit) |
| `GET /coding/sessions/:id/events?since=N&wait=ms` | ChatEvents ab N, Long-Poll bis 25 s |
| `POST /coding/sessions/:id/prompt` `{prompt}` | Turn starten (202; läuft schon einer: 409) |
| `POST /coding/sessions/:id/mode` `{mode}` | ask · askEdits · free · plan |
| `POST /coding/sessions/:id/cancel`, `DELETE /coding/sessions/:id` | Turn stoppen bzw. Sitzung beenden |
| `GET /coding/inbox?since=V&wait=ms` | offene Freigaben (Long-Poll auf die Version) |
| `POST /coding/inbox/:id` `{optionId}` | Freigabe beantworten (`null` = abbrechen) |
| `GET /coding/history`, `GET /coding/history/:tool/:id` | CLI-Verlauf des Server-Rechners (`~/.claude/projects`, `~/.codex/sessions`, nur lesend; Transkript als ChatEvents) |
| `GET /coding/doctor`, `POST /coding/doctor/:agent/test` | Setup-Doctor: CLIs (Pfad, Version), Login, Befehl zum Beheben; Test = Agent starten + ACP-Handshake |

Modus und Regeln entscheiden zuerst (Bash/Edit/Read …, wie im Chat); nur „ask“ landet in der Inbox.

## CLI `based` (`apps/cli`)

Ein Node-Einstieg (`bin/based.js`, lädt die TS-Quellen über tsx). Spricht den Server über MCP (Streamable HTTP,
`POST /mcp`, Bearer-Token). Befehle wie die Swift-CLI: `ask [--wait]`, `runs`, `run`, `page get|new|list`,
`search`, `inbox`, `tools`, `sandbox shell`, `login`, `config`. Der Token nie als Argument (`BASED_TOKEN`,
`--token-file`, `based login` liest stdin bzw. verdeckt am Terminal, `~/.config/based/config.json` mit 0600);
http nur für localhost. Werkzeug-Argumente passen sich dem Schema an (TS: `id`/`parent`, Swift: `page_id`/
`parent_id`). Was der Server nicht anbietet (TS: Hauptagent, Läufe, Inbox), meldet der Befehl mit Exit 1.

```sh
pnpm --filter @based/cli start -- search "Roadmap"      # oder: apps/cli/bin/based.js …
```

## Tests

```sh
pnpm --filter @based/server test                                   # Vitest: Protokoll, SyncClient, MCP, collab, Start
SWIFT_BIN=…/swift/usr/bin ci/server/swift-client-compat.sh [--skip-build] [--reference]
```

- `test/share.test.ts`: Rollen/Vererbung, gefilterter Pull/Push, Löschung beim Herausbewegen, Hashes, Widerruf,
  Einladung, Publish (ohne Token lesbar, privater Bereich nicht, HTML-Block-Sandbox, Bilder).
- `test/sandbox.test.ts`: Docker-Kommandozeilen (gemockter Prozess), Allowlist, lokale Snapshots, Aufräumen, Routen.
- `apps/cli/test/cli.test.ts`: `based` gegen einen In-Process-Server.
- `test/sync-http.test.ts`: Endpunkte und Router (401/404/405/413/400, CORS), newer/deleted, Long-Poll, GC, v1.
- `test/client-compat.test.ts`: `SyncClient` aus `packages/sync` gegen den Server über HTTP (Swift-Korpus
  byte-gleich, Offline, Tombstones, GC mit Full-Pull, Live über Long-Poll, falscher Token).
- `ci/server/swift-client-compat.sh`: startet den TS-Server (Port 18120) und lässt den **unveränderten** Swift-
  Client (`ServerSync`) über HTTP dagegen laufen: `Swift/BasedBrain/Tests/BasedBrainTests/ExternalServerCompatTests.swift`
  (übersprungen ohne `BASED_COMPAT_SERVER_URL`/`_TOKEN`). Danach liest der TS-Client denselben Server
  (`test/external-mixed.test.ts`: alles, was Swift schrieb, ist im TS-Kern lesbar und byte-gleich). `--reference`
  wiederholt die Swift-Suite gegen den Swift-Server als Kontrolle. Braucht Swift 6.x unter Linux.

## Offen

- **Teilen**: Universal Links (`/.well-known/apple-app-site-association`) und `/share/v1/resolve` fehlen noch; ein
  Gast-Modus im Web-Client (nur geteilte Seiten, ohne Workspace-Record) ist nicht gebaut – Gäste lesen im Browser,
  bearbeiten mit dem Token in Based. Eine Seite, die *in* den geteilten Bereich verschoben wird, kommt bei Gästen
  ohne ihren (unveränderten) Inhalt an, bis der sich ändert oder der Gast `/share/v1/snapshot` lädt (wie Swift).
- **Deploy** (`deploy/`) ist unverändert und startet den Swift-Server. Umstieg: Dockerfile mit `node:22-slim`,
  `pnpm deploy --filter @based/server` (oder ein esbuild-Bündel statt `tsx`), gleiche Variablen (`BASED_TOKEN`,
  `BASED_DB=/data/based.sqlite`, `BASED_PORT`, `BASED_PUBLIC_URL`), gleiches Volume; Caddy leitet WebSockets ohne
  Änderung weiter. Wichtig: **nie beide Server gleichzeitig auf dieselbe Datei** – jeder hält den Workspace im
  Speicher. Umschalten = Swift-Container stoppen, TS-Container auf derselben Datei starten (gleiches Format); zurück
  genauso. Was der TS-Server noch nicht kann (Agenten, Scheduler, Captures, Sessions, Teilen, Web-App `/app`),
  fehlt dann – ein paralleler Betrieb nach Pfaden bräuchte zwei Workspaces, die sich gegenseitig per Sync v2
  abgleichen (zwei `--node`-Kennungen).
- **MCP**: Datenbank-, Agenten-, Projekt-, Capture- und Host-Werkzeuge, `find_replace`, `move_page`,
  `duplicate_page`, `backlinks`, `set_favorite`, Prompts (Skills), `/mcp/session/<id>` mit Sitzungs-Tokens.
- Schreibfehler der Datenbank (Store schreibgeschützt) ergeben 500; ein Health-Feld dafür fehlt noch.
