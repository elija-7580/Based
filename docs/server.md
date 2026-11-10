# TS-based-server (`apps/server`)

Der TypeScript-Server aus Phase 3 (BSD-158, ADR 0011). Er spricht dasselbe Sync-v2-Protokoll wie der Swift-
`based-server` ([sync-protocol.md](sync-protocol.md)) auf demselben SQLite-Dateiformat und bietet MCP
([mcp.md](mcp.md)) und Echtzeit-Text über Hocuspocus (Yjs). Erster Schnitt: Sync, MCP-Seitenwerkzeuge, Hocuspocus.
Teilen, Agenten, Captures usw. bleiben vorerst beim Swift-Server (siehe „Offen“).

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
| | `BASED_LOG_LEVEL` | `info` | `debug` loggt jede Anfrage |

Neben der Datenbank legt der Server `<db>.collab.sqlite` an (Y-Zustände für `/collab`).

Ohne Token gibt es keinen Loopback-Sondermodus wie beim Swift-Server (`--insecure-public`): der TS-Server
verweigert den Start.

## Endpunkte

| Methode | Pfad | Zugriff | Body-Grenze | |
|---|---|---|---|---|
| GET | `/health`, `/` | öffentlich | | `{ok, name, impl: "ts", protocol: 2, time}` |
| GET | `/sync/v2/info` | Owner | | `{protocol, seq, oldestSeq}` |
| POST | `/sync/v2/push` | Owner | 32 MiB | `{records, deletions}` → `{newer, seq, deleted}` |
| GET | `/sync/v2/pull?after&limit` | Owner | | Seiten, `limit` 1…5000 (Standard 500) |
| GET | `/sync/v2/wait?after&timeout` | Owner | | Long-Poll, 1…55 s (Standard 25) |
| POST | `/sync/push`, GET `/sync/pull?since` | Owner | 32 MiB | v1 für sehr alte Apps (Stempel-Cursor) |
| POST | `/mcp` | Owner | 32 MiB | MCP Streamable HTTP (zustandslos, JSON-Antworten) |
| GET/DELETE | `/mcp` | Owner | | 405 (kein SSE) |
| WS | `/collab` | Token in der Auth-Nachricht | 16 MiB/Nachricht | Hocuspocus, Dokument `page:<id>` |

Router-Kette wie Swift `ServerRouter` (ADR 0006): CORS-Preflight → Route (404, 405 mit `Allow`) →
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
`restore_page`, `list_trash`. Ressourcen `based://docs/<topic>` (overview, markdown, safety) und
`based://page/<id>` (Liste: die ersten 500 Seiten). Seiten kommen als Markdown (`MarkdownExporter` aus
`@based/core`), Links auf Seiten als `based://page/<id>`; Markdown wird mit `MarkdownImporter` zu Blöcken, Links
auf `based://page/<id>` werden Erwähnungen. Änderungen sind lokale Änderungen des Servers und erreichen Geräte per
Sync v2. Werkzeugfehler (unbekannte Seite, Seite im Papierkorb) kommen als `isError`-Antwort.

## Echtzeit-Text (`/collab`)

`src/collab.ts`: `@hocuspocus/server` (v4) hinter dem eigenen HTTP-Server (`ws`, `noServer`). Ein Y.Doc je Seite,
Name `page:<id>`, XML-Fragment `blocks` wie `packages/editor` (`DocSession`). Auth über die Hocuspocus-Auth-
Nachricht (Provider-Option `token`), unbekannte Seiten werden abgewiesen. Speichern 2 s nach der letzten Änderung
(spätestens 10 s) in `<db>.collab.sqlite`, Tabelle `yjs_documents(name, state, updated)`.

**Noch nicht verbunden:** Der Server materialisiert Y-Änderungen nicht selbst in Records und füllt ein neues Y.Doc
nicht aus den Records. Solange das so ist, darf der Web-Editor `/collab` nicht einschalten: zwei Geräte würden
beim ersten Öffnen jeweils die Records ins leere Dokument übernehmen (doppelter Inhalt). Nächster Schritt: Server-
seitige `DocSession` mit einem kopflosen `BlockConverter` (BlockNote-Schema ohne DOM), die das Y.Doc beim Laden
aus den Records füllt und Änderungen als eine Store-Transaktion schreibt; Clients übernehmen dann keine Records
mehr, wenn der Server einen Zustand liefert.

## Tests

```sh
pnpm --filter @based/server test                                   # Vitest: Protokoll, SyncClient, MCP, collab, Start
SWIFT_BIN=…/swift/usr/bin ci/server/swift-client-compat.sh [--skip-build] [--reference]
```

- `test/sync-http.test.ts`: Endpunkte und Router (401/404/405/413/400, CORS), newer/deleted, Long-Poll, GC, v1.
- `test/client-compat.test.ts`: `SyncClient` aus `packages/sync` gegen den Server über HTTP (Swift-Korpus
  byte-gleich, Offline, Tombstones, GC mit Full-Pull, Live über Long-Poll, falscher Token).
- `ci/server/swift-client-compat.sh`: startet den TS-Server (Port 18120) und lässt den **unveränderten** Swift-
  Client (`ServerSync`) über HTTP dagegen laufen: `Swift/BasedBrain/Tests/BasedBrainTests/ExternalServerCompatTests.swift`
  (übersprungen ohne `BASED_COMPAT_SERVER_URL`/`_TOKEN`). Danach liest der TS-Client denselben Server
  (`test/external-mixed.test.ts`: alles, was Swift schrieb, ist im TS-Kern lesbar und byte-gleich). `--reference`
  wiederholt die Swift-Suite gegen den Swift-Server als Kontrolle. Braucht Swift 6.x unter Linux.

## Offen

- **Teilen** (docs/sharing.md: `/s/<secret>`, `/p/<id>`, `/share/v1/…`, gefilterter Pull/Push für Gäste) ist nicht
  gebaut. Plan: `ShareService` nach TS portieren (Nutzer, Grants, Links in `meta`, Geheimnisse nur als SHA-256),
  der Router bekommt die Zugriffsart `ownerOrShared` mit Principal; `pull` filtert Records nach Leserecht (Seiten,
  die den geteilten Bereich verlassen, als Löschung), `push` prüft Record für Record und rollt mit der Server-Kopie
  zurück; veröffentlichte Seiten als HTML über `HTMLExporter`. Bis dahin bekommen Share-Tokens 401 (Swift: 403).
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
