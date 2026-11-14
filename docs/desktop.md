# Based Next – die Mac-App der neuen Oberfläche (BSD-164)

„Based Next“ ist die Web-App (`apps/web`, Design „Based Default“) in einer dünnen Tauri-2-Hülle (`apps/desktop`,
ADR 0011). Sie läuft **neben** der Swift-App „Based“: eigener Name, eigene Bundle-ID
(`com.friedrich-ulrich.based.next` statt `com.friedrich-ulrich.based`), eigene Daten.

| | |
|---|---|
| Download (immer die neueste) | <https://github.com/elija-7580/Based/releases/download/next-latest/Based-Next.dmg> |
| Alle Versionen | Releases `next-<version>` (Vorabversionen; „Latest“ bleibt die Swift-App) |
| Gebaut von | `.github/workflows/desktop.yml` bei jedem Push auf `main`, der `apps/web`, `apps/desktop` oder `packages` ändert (oder per Hand: Actions → Desktop → Run workflow; dann nur als Artefakt, ohne Release) |
| Systemvoraussetzung | macOS 13 oder neuer, Apple Silicon oder Intel (universelle App) |

## Installieren

1. `Based-Next.dmg` laden und öffnen.
2. **Based Next** auf **Programme** ziehen.

## Erstes Öffnen

Die App ist **ad hoc signiert** (kein Apple Developer Team, keine Notarisierung). macOS lässt sie deshalb beim ersten
Start nicht einfach durch:

- **macOS 13/14:** im Finder unter Programme **Rechtsklick (oder ctrl-Klick) auf „Based Next“ → Öffnen → Öffnen**.
- **macOS 15 (Sequoia) und neuer:** der Rechtsklick-Weg wurde von Apple entfernt. Einmal doppelklicken (Meldung
  wegklicken), dann **Systemeinstellungen → Datenschutz & Sicherheit → ganz unten „Dennoch öffnen“** und bestätigen.
- Alternative für alle Versionen im Terminal:
  `xattr -dr com.apple.quarantine "/Applications/Based Next.app"`

Danach startet die App normal. Updates (unten) brauchen diesen Schritt nicht noch einmal.

## Updates

- Beim Start fragt die App nach ein paar Sekunden still `latest.json` im Release `next-latest` ab. Gibt es eine
  neuere Version, kommt die Frage **„Install and Restart“** – ein Klick lädt das Paket, prüft seine Signatur gegen den
  öffentlichen Schlüssel in `apps/desktop/src-tauri/tauri.conf.json`, ersetzt die App und startet sie neu.
- Von Hand: Menü **Based Next → Check for Updates…** (meldet auch „kein Update“ und Fehler).
- Versionsnummer: `0.1.<Laufnummer des Desktop-Workflows>`; jeder Lauf auf `main` ist damit neuer als der vorige.
- Updates gibt es nur, wenn der Workflow mit dem Secret unten gelaufen ist. Fehlt es, entsteht trotzdem eine DMG
  (Release `next-<version>`, Warnung im Workflow-Log), aber kein Update-Paket – installierte Kopien merken davon nichts.

## Secret für die Update-Signatur (einmalig anlegen)

Der Updater installiert nur Pakete, die mit dem privaten Schlüssel zum öffentlichen Schlüssel in `tauri.conf.json`
signiert sind. Dafür braucht GitHub Actions **ein** Repository-Secret:

| Name | Inhalt | Wo |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | der komplette Inhalt der Schlüsseldatei (eine Zeile, beginnt mit `dW50cnVzdGVk…`) | github.com/elija-7580/Based → **Settings → Secrets and variables → Actions → New repository secret** |

- Der Schlüssel hat **kein Passwort**; ein Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` ist nicht nötig.
- Der private Schlüssel liegt **nicht** im Repo. Aktuelles Paar: neu erzeugt am 10.11.2026 (das erste ging verloren) und Elija als Datei übergeben; nach dem
  Anlegen des Secrets zusätzlich sicher aufbewahren (z. B. Passwortverwaltung). Geht er verloren, kann keine
  installierte Kopie mehr automatisch aktualisiert werden – dann neues Paar erzeugen
  (`pnpm --filter @based/desktop exec tauri signer generate --ci -p "" -w <datei>`), den neuen öffentlichen Schlüssel
  in `tauri.conf.json` → `plugins.updater.pubkey` eintragen, Secret ersetzen und die DMG einmal von Hand neu installieren.
- Mit dem Sparkle-Schlüssel (`SPARKLE_PRIVATE_KEY`) der Swift-App hat das nichts zu tun.

## Developer ID: Updates ohne Admin-Passwort (einmalig anlegen)

Ad hoc signiert lässt macOS (Datenschutz → App-Verwaltung) den Updater die App in /Programme nicht ersetzen; der
Updater weicht dann auf „mit Administratorrechten“ aus – darum fragt jedes Update nach dem Mac-Passwort. Mit einem
**Developer-ID-Application**-Zertifikat signiert (und notarisiert) der Desktop-Workflow die App selbst, sobald diese
Repository-Secrets da sind; ohne sie bleibt alles ad hoc wie bisher:

| Name | Inhalt |
|---|---|
| `APPLE_CERTIFICATE` | Developer-ID-Application-Zertifikat als .p12, base64 (`base64 -i cert.p12 \| pbcopy`) |
| `APPLE_CERTIFICATE_PASSWORD` | Passwort, mit dem die .p12 exportiert wurde |
| `APPLE_SIGNING_IDENTITY` | z. B. `Developer ID Application: Elija Friedrich-Ulrich (TEAMID)` |
| `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_P8` | App-Store-Connect-API-Schlüssel (Issuer-ID, Key-ID, Inhalt der .p8) für die Notarisierung |

Das erste Update von einer ad-hoc-Kopie auf die signierte fragt noch einmal (die alte App darf die neue nicht
ersetzen); danach nicht mehr. Notarisiert entfällt auch das „Dennoch öffnen“ beim ersten Start.

## Speicher

Die Daten liegen dauerhaft im Datenbereich der App, getrennt von der Swift-App: SQLite-WASM auf OPFS im
Dedicated Worker – also genau derselbe Speicherweg wie im Browser, im WebKit-Datenordner von Based Next
(`~/Library/WebKit/com.friedrich-ulrich.based.next/`). Das Dateiformat ist das der Swift-App (`SqlitePersistence`:
`records`, `meta`, `changes`, gleiche Migrationen). Kann OPFS nicht geöffnet werden, läuft der Workspace im Speicher und
unten in der Seitenleiste steht dann „Not saved“ – es geht also nie still etwas verloren.

**Warum (noch) kein natives SQLite über `@tauri-apps/plugin-sql`:** die Speicher-Schnittstelle `SqlDatabase`
(`packages/sync/src/sql.ts`) ist synchron, weil der Store synchron schreibt (wie in Swift) und bei einem Fehler sofort
schreibgeschützt wird. Das SQL-Plugin ist nur asynchron über IPC erreichbar, und diese IPC gibt es im Worker, in dem der
Store läuft, gar nicht. Synchron ließe sich das nur über SharedArrayBuffer + `Atomics.wait` mit Weiterleitung über den
Hauptthread erzwingen (braucht COOP/COEP und einen eigenen Proxy) – mehr Hülle, als ADR 0011 will, und fehleranfälliger
als der erprobte OPFS-Weg. Ein eigener Treiber `@based/sync/tauri` lohnt sich erst, wenn der Store asynchron
schreiben kann oder die Datei für andere Programme (Swift-App, Backups) sichtbar sein muss.

## Fenster, Menüs, Kürzel

- Titelleiste im Overlay-Stil: die Ampel-Knöpfe liegen über der Seitenleiste, die Fläche darüber und der obere Rand
  ziehen das Fenster (`data-tauri-drag-region`, `apps/web/src/desktop.ts`).
- Menüs: **Based Next** (Über, Check for Updates…, Dienste, Ausblenden, Beenden), **Edit** (Undo/Redo, Cut/Copy/Paste,
  Select All), **Window** (Minimieren, Zoomen, Vollbild, Schließen) – nur Standardeinträge, in `src-tauri/src/lib.rs`.
- Alle anderen ⌘-Kürzel (⌘K, ⌘P, ⌘N, …) belegt kein Menü; sie kommen unverändert in der Web-App an.
- Glas (`data-material="glass"`) gilt wie in Safari, weil der WebView sich als Mac meldet.
- Seitenfenster (BSD-202): „Open in new window“ (Seitenmenü •••, Rechtsklick in der Seitenleiste) öffnet ein Tauri-Fenster
  `page-*` mit `?window=page#page-<id>` – eigener Verlauf, die Tabs des Hauptfensters bleiben unberührt. Menü-Befehle
  (⌘W „Close Tab“, ⇧⌘W „Close Window“) wirken auf das Fenster vorn; der rote Knopf blendet nur das Hauptfenster aus,
  Seitenfenster schließen. Rechte: `capabilities/default.json` gilt für `main` und `page-*`. Im Browser: neues Fenster.

## Lokal bauen

```sh
pnpm install
pnpm --filter @based/desktop dev      # Fenster mit Vite-Dev-Server (Hot Reload)
pnpm --filter @based/desktop build    # .app unter apps/desktop/src-tauri/target/release/bundle/macos/
```

Braucht Rust (stable). Unter Linux zusätzlich `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev
librsvg2-dev libsoup-3.0-dev`; dort prüft `pnpm --filter @based/desktop exec tauri build --no-bundle` Konfiguration
und Rust-Teil. Das App-Icon entsteht aus `apps/desktop/icon.svg` (= `docs/design/logo/based-icon-light.svg` im
macOS-Raster) mit `pnpm --filter @based/desktop exec tauri icon icon.svg -o src-tauri/icons`.

## HTTP (Notion-API-Import, BSD-217)

Die Hülle lädt `tauri-plugin-http`, damit der Import direkt mit `api.notion.com` sprechen kann (ein Browser-Tab darf das
wegen CORS nicht). Erlaubt sind nur die Adressen in `src-tauri/capabilities/default.json`: die Notion-API und die Hosts,
von denen Notion Dateien ausliefert (`*.notion.so`, `*.notion.com`, `*.notionusercontent.com`, `*.notion-static.com`,
`*.amazonaws.com`). Das Token liegt verschlüsselt in der Web-Ablage (`shell/secrets.ts`, Name `notion:token`), nie in
Rust oder im localStorage. Ablauf: `apps/web/src/worker/notionApi.worker.ts` holt und übersetzt, der Hauptthread macht
das HTTP (`shell/notionTransport.ts`), geschrieben wird im Store-Worker wie beim Datei-Import.

## Lokaler Server und Kommandozeile (BSD-138)

Beides ist **Opt-in** (Settings → Sync & server → „Local server & command line“) und braucht **Node.js ≥ 22** auf
dem Mac. Die App bringt keine eigene Node-Laufzeit mit, nur ein JavaScript-Bundle (`based-server.cjs`, ~8 MB, als
Resource) und lädt nichts herunter. Fehlt Node oder ist es zu alt, sagt sie das mit Installationsbefehl.

- **Node finden:** über die Login-Shell wie im Terminal (`/bin/zsh -ilc 'command -v node && node --version'`), damit
  Homebrew/nvm gefunden werden.
- **Gespräche aus Claude Code und Codex (BSD-251):** läuft der lokale Server, zeigt der Chat sie als eigene Gruppe
  „Claude Code & Codex“ (lesen, „Continue in Based“, Terminal-Befehl kopieren), und Coding benutzt ihn ohne
  „Use for sync“. Im Chat und in Coding gibt es dafür einen Knopf, der den lokalen Server einschaltet. Der Server
  lässt Anfragen aus dem Fenster der App zu (`BASED_APP_ORIGIN`, nur Tauri/Loopback) – der Token bleibt Pflicht.
- **Local server (an/aus):** startet `node based-server.cjs desktop` mit `BASED_ACTION=local` – nur 127.0.0.1,
  Port 47821, eigene Datenbank `local-server.sqlite` im App-Datenordner. Der Token wird von der App erzeugt, liegt in
  ihrer verschlüsselten Ablage und geht über die Umgebung an den Prozess, nie über die Kommandozeile. Der Server
  schreibt `~/.config/based/local.json` (ohne Token) und `~/.config/based/local-token` (beide 0600) und räumt sie
  beim Beenden weg; er endet mit der App (stdin zu). „Use for sync“ verbindet diese App mit ihm, damit `based`
  dieselben Seiten sieht. Coding-Agenten laufen mit `--coding-root` = Home und dem PATH der Login-Shell.
- **Command line tool (Install…/Uninstall):** legt einen kleinen Starter an (Standard `~/.local/bin/based`, Ort
  wählbar; Hinweis, wenn der Ordner nicht im PATH ist), der das Bundle mit genau dieser Node startet. Überschreibt
  keine fremde Datei und entfernt nur den eigenen Starter (Kennzeichen-Zeile). `based` nimmt den lokalen Server,
  wenn kein anderer eingestellt ist, oder mit `--local`.
- **Rust:** nur das offizielle Shell-Plugin. `capabilities/local-server.json` erlaubt im Hauptfenster genau zwei
  feste Aufrufe (Node suchen; `exec node "$BASED_BUNDLE" desktop`), ohne freie Argumente; was zu tun ist, steht in
  `BASED_ACTION`. Das App-Menü „Install Command Line Tool…“ zeigt nur den Weg in die Einstellungen.

Bauen: `pnpm --filter @based/desktop sidecar` (läuft vor `tauri dev`/`tauri build` automatisch, auch unter Linux)
bündelt `apps/desktop/sidecar/entry.ts` mit esbuild nach `apps/desktop/dist-sidecar/based-server.cjs`. Ausprobieren
ohne App: `node apps/desktop/dist-sidecar/based-server.cjs cli --help`.
