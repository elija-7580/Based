# Nichts vom System

Jeder Klick in Based öffnet Based-Oberfläche – auch der Rechtsklick, an jeder Stelle. Umsetzung: `packages/ui/src/native`
(`@based/ui/native`, Styles `@based/ui/native.css`), einmal am Start eingeschaltet (`installNativeFree` in
`apps/web/src/main.tsx`). Die Rechnung steht in `logic.ts` (Unit-Tests `packages/ui/test/native.test.ts`), das Verhalten
prüft `apps/web/e2e/native-free.spec.ts` in Chromium und WebKit.

| Statt (System) | Based | Wie |
| --- | --- | --- |
| Kontextmenü des Browsers/WebViews | Based-Menü | Global am Fenster. Bausteine mit eigenem Menü rufen wie bisher `preventDefault()`. Sonst: Text-Einträge (Cut/Copy/Paste/Select all), Link-Einträge, dazu was die App per `registerContextItems` anmeldet (freie Fläche: Search, New page, Back, Forward, Settings). |
| Aufklappliste von `<select>` | Based-Liste (`role=listbox`) | Global, auch für fremde Bausteine (Code-Block). Das Feld bleibt ein `<select>` (Wert, Tests mit `selectOption`). Maus, Pfeile, Tippen, Enter, Escape. |
| `title`-Blase | Based-Tooltip | Jedes `title` wandert nach `data-tip`; Name/Beschreibung bleiben über `aria-label`/`aria-description`. Im Code darf weiter `title=` stehen. |
| Auswahl von `<input type="date/time">` | `DateField`/`TimeField` | Textfeld (ISO-Tag bzw. HH:MM) mit Based-Kalender bzw. Zeitliste. Keine `type="date/time/color/…"`-Felder mehr anlegen. |
| Systemdialoge (Tauri `dialog.ask/message`) | Based-Dialog | `shell/prompts.ts` (`askUser`, `showMessage`), gezeichnet von `PromptHost`. Das Dialog-Plugin ist entfernt. |
| „Einsetzen“-Blase von WKWebView | – | Die Hülle liest die Zwischenablage über `tauri-plugin-clipboard-manager`. |
| Drehfelder, Such-„x“, Kalender-Symbol, AutoFill-Knöpfe an Feldern | aus | `native.css`. |

Regeln für neue Oberflächen:

- Kein `alert/confirm/prompt`, kein `dialog.*` aus Tauri, keine `type="date|time|color"`-Felder.
- Schwebendes über `openLayer`/`showMenu` (liegt im Top Layer, nimmt dem Feld den Fokus nicht, schließt bei Klick
  daneben, Escape, Fensterwechsel und wenn der Anker wegscrollt).
- Nur beim Entwickeln öffnet ⌥⇧-Rechtsklick das Systemmenü (Web-Inspektor).

Bewusst beim System geblieben (liegt außerhalb des Fensterinhalts): die macOS-Menüleiste (ohne „Edit“-Menü kämen
⌘C/⌘V nicht im WebView an), die Ampel-Knöpfe des Fensters und der Datei-öffnen-Dialog beim Hochladen/Importieren.
