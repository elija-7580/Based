# Based auf der Apple Watch (apps/watch)

Stand 23. 11. 2026. Elija: „Ideen festhalten mit Audio“, auch von der Uhr. ADR 0011: die Watch-App ist nativ (Swift)
und kann nur eines – einen Gedanken festhalten. Vorlage war die Uhr-App der alten Swift-App (BSD-66, `legacy/App/watchOS`).

## Was sie kann

- **Sprachnotiz**: ein großer Knopf. Tippen nimmt auf (AAC, mono, 32 kHz, etwa 360 KB je Minute), noch einmal tippen
  beendet und schickt. Die Aufnahme läuft weiter, wenn das Handgelenk sinkt. Aufnahmen unter 0,7 s werden verworfen.
- **Diktat oder Text**: „Dictate or type“ öffnet die Eingabe der Uhr (Diktat, Kritzeln, Tastatur).
- **Komplikation** fürs Zifferblatt (rund, Ecke, Zeile): ein Mikrofon, das die App öffnet und sofort aufnimmt.
  Derselbe Weg für die Aktionstaste und Kurzbefehle („Record a Thought“).
- Unter dem Knopf steht, wie viele Notizen heute festgehalten wurden und wie viele noch auf das iPhone warten.

## Der Weg einer Notiz

```
Uhr (apps/watch)                    iPhone (apps/mobile)                         Workspace (apps/web)
Aufnahme / Text → Ausgang  ──────▶  Plugin based-watch (Swift)  ──────────────▶  drainWatchInbox
(outbox, bis das iPhone             WCSession.didReceive → Eingang               Sprachnotiz: Seite „Voice note — …“ mit
 den Empfang bestätigt)             Application Support/watch-inbox              Meeting-Block, Aufnahme als Spur „upload“
        WCSession.transferFile      Befehle pending / read / done                Text: Seite mit dem Text
```

- **Uhr** (`Shared/WatchCaptureTransfer.swift`): jede Notiz liegt mit Kennung (UUID), Aufnahmezeit und Dauer im Ausgang,
  bis `WCSessionFileTransfer` ohne Fehler endet. Das überlebt Neustarts und Zeiten ohne iPhone in Reichweite.
  Format der Metadaten: `kind = based.watch.voice`, `v = 1`, `id`, `at`, `dur`, `ext` (`m4a` oder `txt`) – dasselbe
  wie in der alten App; ein neueres Format lehnt ein älteres iPhone ab und lässt die Datei liegen.
- **iPhone** (`apps/mobile/src-tauri/plugins/watch`): WatchConnectivity weckt die App im Hintergrund. Das Plugin
  kopiert die Datei in den Eingang und meldet der Oberfläche `based:watch-inbox`. Mehr tut die Hülle nicht.
- **Workspace** (`apps/web/src/mobile/watchInbox.ts`): beim Start, bei der Meldung und wenn die App nach vorn kommt,
  wird der Eingang geleert. Erst wenn die Seite steht, verlässt die Notiz den Eingang; eine Liste erledigter
  Kennungen verhindert eine zweite Seite, falls die App dazwischen abbricht. Die Seite trägt die Zeit der Uhr.
  Die Aufnahme ist ein gewöhnliches Asset und geht mit dem Sync auf alle Geräte; transkribiert wird wie bei jeder
  Aufnahme, sobald ein Gerät mit Transkription sie hat (`docs/meeting-notes.md`).

Keine neuen Records und keine neue Form im Datenformat: Seite, Meeting-Block, Spur `upload`, Textblöcke.

## Bauen

Nur auf dem Mac mit Xcode 16 und XcodeGen (`brew install xcodegen`); das Xcode-Projekt wird erzeugt, nicht eingecheckt.

```
cd apps/watch
swift test                 # Übertragung und Ausgang, ohne Uhr
xcodegen generate
open BasedWatch.xcodeproj  # Schema BasedWatch, Ziel: Simulator oder die eigene Uhr
```

In der CI (`.github/workflows/mobile.yml`, Job „Based (Apple Watch)“) laufen bei jedem Pull Request, der `apps/watch`
oder `apps/mobile` berührt, die Tests und ein unsignierter Bau für den Simulator.

Kennungen: die Uhr-App heißt `com.friedrich-ulrich.based.next.watchkitapp`, die Komplikation
`….watchkitapp.complication`; beide hängen an der Kennung der iPhone-App (`WKCompanionAppBundleIdentifier`).

## Offen

- **Noch nicht im TestFlight-Bau.** Eine Uhr-App kommt nur als Teil der iPhone-App aufs Gerät (im Paket unter
  `Based.app/Watch/`). Der iPhone-Bau läuft über `tauri ios build`, das `xcodebuild` mit `-sdk iphoneos` aufruft;
  ein Uhr-Ziel im selben Projekt baut damit nicht. Nächster Schritt: die Uhr-App vorab mit dem richtigen SDK bauen,
  ins Archiv der iPhone-App legen und beim Export mitsignieren – erst, wenn der iPhone-Bau allein in TestFlight liegt.
- Noch nicht auf echten Geräten geprüft: Aufnahme mit gesenktem Handgelenk, Übertragung ohne geöffnete iPhone-App,
  Komplikation auf den einzelnen Zifferblättern.
- Die Uhr schickt nur, wenn die iPhone-App installiert ist; direkt an einen Server (ohne iPhone) schickt sie nicht.
