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
- Der private Schlüssel liegt **nicht** im Repo. Er wurde beim Einrichten erzeugt und separat übergeben; nach dem
  Anlegen des Secrets zusätzlich sicher aufbewahren (z. B. Passwortverwaltung). Geht er verloren, kann keine
  installierte Kopie mehr automatisch aktualisiert werden – dann neues Paar erzeugen
  (`pnpm --filter @based/desktop exec tauri signer generate --ci -p "" -w <datei>`), den neuen öffentlichen Schlüssel
  in `tauri.conf.json` → `plugins.updater.pubkey` eintragen, Secret ersetzen und die DMG einmal von Hand neu installieren.
- Mit dem Sparkle-Schlüssel (`SPARKLE_PRIVATE_KEY`) der Swift-App hat das nichts zu tun.

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
