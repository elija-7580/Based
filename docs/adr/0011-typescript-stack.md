# ADR 0011: Neustart auf TypeScript-Kern mit Tauri (Desktop) und Capacitor/Tauri (Mobil)

- **Status:** umgesetzt (2026-11-11, BSD-168) · akzeptiert 2026-11-09 (Elija)
- **Ersetzt:** ADR 0010 (Automerge als Text-CRDT). ADR 0001–0009 gelten inhaltlich weiter (Sync v2, Tombstones,
  Kollaboration vorbereiten, Haupt-Agent, Design-Tokens), werden aber im neuen Stack neu umgesetzt.
- **Bezug:** `docs/sync-protocol.md`, `replica/features.csv`, ADR 0008

## Kontext

Based soll in den nächsten 1–2 Jahren auf **allen** Plattformen laufen: Mac, iPhone, iPad, Watch, Windows,
Linux und Android. Apple-Feel ist kein Muss; gewünscht ist das Obsidian-Gefühl: schnell, local-first,
offline, wenig RAM und akkusparend. Beim Editor zählt „stabil“ mehr als „maximal nativ“. Ein Neustart ist
ausdrücklich erlaubt.

Mit Swift müsste der schwierigste Teil (Block-Editor mit Echtzeit-Zusammenarbeit) für Android ein zweites Mal
gebaut werden. Drei native Oberflächen (SwiftUI, Compose, Web) kosten grob das 2–2,5-Fache, dauerhaft.

## Optionen

1. **Swift weiter**, Android/Windows später separat. Verworfen: zwei bis drei Oberflächen, zwei Editoren.
2. **Electron + Capacitor** (Obsidian-Modell). Erprobt, aber Electron ist schwer (Start 1–2 s, viel RAM).
3. **Flutter + Rust-Kern** (AppFlowy-Modell). Rich-Text-Editoren in Flutter sind schwächer als ProseMirror.
4. **Native Oberfläche pro Plattform + Web-Editor.** Bestes Gefühl, aber ~2–2,5× Aufwand.
5. **TypeScript-Kern + Web-Oberfläche in dünnen Hüllen: Tauri 2 auf dem Desktop, Capacitor oder Tauri Mobile
   auf iOS/Android, Watch nativ.**

## Entscheidung

Option 5.

| Teil | Wahl |
|---|---|
| Editor | BlockNote (ProseMirror + TipTap), Kern MPL-2.0. **Keine** `@blocknote/xl-*`-Pakete (GPL-3.0/kommerziell). |
| Text-CRDT / Echtzeit | Yjs (y-prosemirror). Ersetzt Automerge aus ADR 0010: dort fiel Yjs nur wegen fehlender Swift-Bindings raus. |
| Oberfläche | React + TypeScript, ein Code für alle Plattformen |
| Desktop | Tauri 2 (WKWebView / WebView2 / WebKitGTK), offizielles Updater-Plugin (DMG mit Ein-Klick-Update) |
| Mobil | Start mit Tauri Mobile; Wechsel auf Capacitor, falls es hakt (Oberfläche identisch, Wechsel billig) |
| Watch | kleine native Swift-App (nur Aufnahme), wie bisher geplant |
| Native Extras | Share-Extension, Widgets, Hintergrundaufnahme als Plugins in Swift/Kotlin |
| Lokal | SQLite pro Gerät + Yjs-Dokumente, local-first, offline voll nutzbar |
| Server | TypeScript (Node/Bun): Sync v2, Hocuspocus für Yjs, offizielles MCP-SDK |
| Notausgang Linux | Falls WebKitGTK Probleme macht: nur Linux in Electron verpacken |

**Regel: Die Hülle bleibt dünn.** Editor, Datenmodell, Sync, Abfragen, Formeln und Import liegen in Paketen
ohne Plattformbezug (`packages/core`, `packages/editor`, `packages/sync`). Die Hülle liefert nur Fenster,
Dateien, SQLite, Updates und native Extras. Logik in der Hülle ist ein Review-Fehler (wie heute „Logik in
BasedCore/BasedBrain, Views dünn“).

## Migration: wie der Umstieg nachhaltig klappt

Es gibt keinen brauchbaren Swift→TypeScript-Transpiler für App-Code (vorhandene Projekte sind Spielzeug oder
unfertig, und SwiftUI→React lässt sich ohnehin nicht mechanisch übersetzen). Stattdessen sorgen Skripte dafür,
dass das **Verhalten** gleich bleibt, und Agenten portieren den Code Modul für Modul:

1. **Typen generieren, nicht abtippen.** Die Record-Payloads (`workspace`, `block`, `database`, `view`, …) sind
   `Codable`. Ein Skript erzeugt daraus einmalig TypeScript-Typen und Zod-Schemas (z. B. mit
   CodableToTypeScript), danach ist das TS-Schema die Quelle.
2. **Golden Fixtures als Orakel.** Ein Swift-Exportlauf (`swift run based-fixtures`, neues Target) schreibt für
   die Kernlogik Eingabe→Ausgabe-Paare als JSON nach `fixtures/`: Formeln, Abfragen/Filter/Sortierung,
   Property-Umwandlung, Notion-HTML-Import, HLC, Tombstones, Relationen, Sortierschlüssel, Suche. Die
   TS-Tests spielen dieselben Fixtures ab. Ein Modul gilt als portiert, wenn alle seine Fixtures grün sind.
   Die ~730 bestehenden Swift-Tests sind die Vorlage dafür, welche Fälle exportiert werden.
3. **Daten wandern über das Sync-Protokoll.** Sync v2 ist sprachneutrales JSON. Der neue Client spricht
   zuerst mit dem bestehenden Swift-`based-server` und zieht so alle Daten. Für Geräte ohne Server: ein
   Export-Skript (`based-cli export --records`) schreibt die lokale SQLite als Record-JSON, der neue Client
   importiert es. Bestehender `richText` wird beim ersten Öffnen in ein Yjs-Dokument übersetzt.
4. **Strangler statt Big Bang.** Die Swift-App bleibt nutzbar, bis die TS-App in `replica/features.csv`
   (neue Spalte `ts`) die Must-Features erreicht. Der Swift-Server wird zuletzt ersetzt.
5. **Nachtschicht kann autonom portieren.** Swift-Tests, Fixture-Export, Node-Tests und Playwright laufen alle
   unter Linux. Portierungs-Einträge mit Fixtures sind damit „autonom machbar“.

Reihenfolge: (a) Monorepo-Gerüst + Typen + Fixture-Export, (b) Kern-Logik nach Fixtures portieren,
(c) Web-Client mit Editor und lokalem Speicher, (d) TS-Server mit Sync, Yjs und MCP, (e) Tauri-Desktop mit
Auto-Update, (f) Mobil, (g) native Extras und Watch.

## Konsequenzen

- Der Großteil von App, BasedCore und BasedBrain wird abgelöst; der Swift-Code bleibt als Referenz und
  Fixture-Quelle im Repo. **Umgesetzt (BSD-168, 11.11.2026):** alle Must-Features der Mac-Beta in
  `replica/features.csv` (Spalte `ts`) auf yes; Swift-App, Swift-Server und ihre Skripte liegen eingefroren in
  `legacy/`; `deploy/` startet den TS-Server; CI baut die Swift-Apps nicht mehr und prüft nur noch, dass
  `fixtures/` zum Swift-Code passt; die Swift-Releases (`release.yml`) sind abgeschaltet. Ein Migrationsassistent
  (`based-cli export --records`) entfällt – entschieden von Elija: es gibt keine Daten, die nur in der Swift-App liegen.
- Eine Oberfläche statt mehrerer; neue Features einmal bauen.
- Kein Apple-Feel; Desktop-Start und RAM deutlich unter Electron.
- Der Editor muss auf WebKit (iOS, Mac, Linux) und Chromium (Android, Windows) laufen; Playwright testet beide.
- Rust nur in der Tauri-Hülle (Vorlage + offizielle Plugins), keine eigene Rust-Logik.
- ADR 0010 ist ersetzt; der CRDT-Spike bleibt als Messgrundlage in `spikes/crdt/`.
