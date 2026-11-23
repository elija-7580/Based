# Based auf dem iPhone (apps/mobile)

Stand 23. 11. 2026. Entscheidung Elija: Based kommt als native iPhone-App aufs Handy (ADR 0011: Start mit Tauri Mobile).

## Was die Hülle ist

`apps/mobile` ist eine eigene, dünne Tauri-2-Kiste: ein Fenster um `apps/web/dist`, keine Plugins, keine Rust-Logik.
Sie ist bewusst von `apps/desktop` getrennt, damit die Mac-App (Menü, Updater, lokaler Server) unberührt bleibt.

In der Hülle verhält sich die Oberfläche wie im Browser: `isTauri()` ist dort falsch, `isMobileShell()` wahr
(`apps/web/src/desktop.ts`). Der Workspace liegt wie überall in SQLite-WASM auf OPFS, im Container der App.
Die Herkunft der Seite ist `tauri://localhost` – dieselbe wie in der Mac-App, deshalb darf sie den lokalen Server der
Mac-App ansprechen (CORS, `localAppOrigin` in `apps/server/src/main.ts`).

## Verbinden mit dem Mac

Auf dem Mac: Settings → Sync & server → Gerät koppeln zeigt einen Link `based://pair?url=…&token=…`.
Auf dem iPhone: Settings → Sync & server, den Link in „Server URL“ einfügen – Adresse und Token sind gefüllt – Connect.

## Bauen

Nur auf dem Mac mit Xcode (das Xcode-Projekt unter `src-tauri/gen/` wird erzeugt und nicht eingecheckt):

```
pnpm --filter @based/mobile exec tauri ios init
pnpm --filter @based/mobile exec tauri ios dev      # Simulator oder angeschlossenes iPhone
```

In der CI baut `.github/workflows/mobile.yml` bei jedem Pull Request, der die Hülle berührt, unsigniert für den
Simulator. Von Hand gestartet mit „testflight“ baut der Workflow signiert und lädt zu TestFlight hoch.

## Offen

- TestFlight braucht einen App-Eintrag in App Store Connect mit der Kennung aus `tauri.conf.json` und einen
  API-Schlüssel mit der Rolle „App Manager“ (die vorhandenen Secrets `APPLE_API_*`).
- Noch nicht auf einem echten Gerät geprüft: Mikrofon in der WebView, Ränder um Notch und Home-Balken,
  Tastatur über dem Editor, Kopplung per Kamera (QR) statt Einfügen.
