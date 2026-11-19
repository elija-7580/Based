# Performance-Budget

Maßstab: Based soll die schlankeste, schnellste und akkusparendste Notizen-App sein – ohne Abstriche bei Korrektheit
und Daten. Diese Datei hält Zielwerte und den gemessenen Stand fest. Zahlen werden an die gemessene Realität
angepasst, **nie nach oben ohne Begründung im Entwicklungslog**. Eine Verschlechterung um mehr als 5 % zum Vortag
ohne bewussten Grund ist ein Fund (P1; Leck, Absturz oder Hängen P0).

## Messen

```
BASED_CHANNEL=beta pnpm --filter @based/web exec vite build
node ci/perf/measure.mjs --out perf.json        # Chromium über Playwright + CDP, gibt JSON aus
```

`ci/perf/measure.mjs` misst Bundle (roh/gzip, Erststart getrennt), Kaltstart, beim Start geladene Dateien, Heap nach
GC, DOM-Knoten, Listener, Leerlauf (Timer-Aufrufe und CPU-Zeit in 10 s), Leck-Schleifen (50× Seite wechseln, 50× ⌘K),
Tippen auf einer 300-Block-Seite, den Start mit 20 000 Seiten und eine Datenbank mit 100 000 Zeilen (Heap, längste
Aufgabe beim Öffnen, Neuladen; einzeln mit `--only database`). `BASED_PERF_CHROME=<pfad>` nimmt ein vorhandenes
Chromium. Die Werte jedes Abends stehen in `perf-history.csv`. Alle Zahlen stammen aus dem Linux-Container
(Chromium headless); Mac-Werte (WKWebView, Energie, DMG) brauchen einen Mac-Test.

## Zielwerte und Stand (19.11.2026 abends, Beta-Build, main fad6141b; Vortag in Klammern)

| Kennzahl | Ziel | Stand | Wächter |
| --- | --- | --- | --- |
| Erststart-JS (index-*.js, gzip) | so klein wie möglich; Grenze 965 KiB (BSD-595) | 918,8 kB (1 065,7) nach BSD-595; nach Review 19.11. (Karten-Küstenlinien als eigener Chunk): 893,3 kB, roh 2 751 kB | `apps/web/scripts/bundle-budget.mjs` |
| Store-Worker (store.worker-*.js, gzip) | Grenze 295 KiB (BSD-595) | 19.11.: 319 → 281 KiB (Agenten-Werkzeuge als eigener Chunk) | `bundle-budget.mjs` |
| Erststart-JS gesamt mit Workern (gzip) | – | 1 178 kB nach Review (1 387), 3 Dateien | `ci/perf/measure.mjs` |
| Erststart-CSS (gzip) | Grenze 95 kB | 77 kB | `bundle-budget.mjs` |
| Web-Bundle gesamt (dist) | so klein wie möglich | 27,0 MB, davon 11,0 MB `ort-wasm-simd-threaded.wasm` | – |
| Kaltstart bis Seitenleiste, leerer Workspace | < 1 s | 0,69 s (0,78) | `measure.mjs` |
| Start mit 20 000 Seiten bis Seitenleiste | < 2 s | 1,0 s (1,56), längste Aufgabe < 50 ms | `e2e/startup-perf.spec.ts`, `scale-perf.spec.ts` |
| JS-Heap nach Start, leer | – | 9,6 MB (11,2) | `measure.mjs` |
| JS-Heap mit 20 000 Seiten | kein lineares Wachstum mit der Gesamtgröße | 15,9 MB (0,32 MB je 1 000 Seiten) | `measure.mjs` |
| 50× Seite wechseln (300 Blöcke): DOM-Knoten nach GC | ±0 | ±0 (vor dem Fix vom 18.11.: +259 907 Knoten, +41 MB) | `e2e/editor-leak.spec.ts` |
| 50× ⌘K: Heap nach GC | kein Wachstum | −3,6 MB, +349 Knoten (beobachten) | `measure.mjs` |
| Leerlauf: Timer-Aufrufe in 10 s | 0 | 1 (vorher 200; BSD-596: Hänger-Wächter und Sitzungs-Marke ohne Dauer-Zeitgeber), 0 Intervalle | `measure.mjs` |
| Leerlauf: CPU des Hauptthreads | 0 % | 0,1 % (nach Editor-Weg 0,9 %) | `measure.mjs` |
| Leerlauf: requestAnimationFrame, laufende Animationen | 0 | 0 | `measure.mjs` |
| Tippen auf 300-Block-Seite | keine Long Tasks | 0 Long Tasks, 6,1 ms CPU je Zeichen (10,4) | `measure.mjs`, `e2e/startup-perf.spec.ts` |
| Fehler in der Konsole auf dem Messweg | 0 | 0 | `measure.mjs` |
| WebView + Node zusammen nach Start (Mac) | < 150 MB | Mac-Test nötig | – |
| Energie im Leerlauf (Aktivitätsanzeige) | „0,0“ | Mac-Test nötig | – |

## Datenbanken (Beta-Weg 4, 18.11.2026 abends, von Hand über Playwright + CDP)

| Kennzahl | Ziel | Stand |
| --- | --- | --- |
| 5 000 Zeilen: öffnen, 10 Spaltenarten, 9 Ansichten anlegen | keine Fehler, keine Aufgabe > 200 ms | 0 Fehler; je Ansicht 113–175 ms; längste Aufgabe 173 ms (Spalte „ID“) |
| 5 000 Zeilen: 50× Ansicht wechseln, DOM-Knoten/Listener nach GC | ±0 | ±0 Knoten, ±0 Listener, Heap +0,4 MB |
| 100 000 Zeilen: Tabelle öffnen | < 2 s, keine Aufgabe > 200 ms | 1,7 s; Aufgaben 412 und 472 ms |
| 100 000 Zeilen: Spalte „ID“ hinzufügen | keine Aufgabe > 200 ms | **2 227 ms** am Stück im Hauptthread (Backlog) |
| 100 000 Zeilen: JS-Heap des Hauptthreads | nur das Sichtbare | 64 MB nach dem Öffnen, 131 MB nach 3 Spalten + 6 Ansichten, 72 MB nach Neuladen (leer: 11 MB) – wächst linear (Backlog) |
| 100 000 Zeilen: Neuladen mit offener Tabelle | < 2 s | 5,9 s |

## Datenbanken (BSD-605, gemessen 19.11.2026, Beta-Build, main c3ba1fe + BSD-604 Teil 1)

`node ci/perf/measure.mjs --only database` (Datenbank per `seedDatabase`, 100 000 Zeilen, Tabelle offen):

| Kennzahl | Ziel | Stand |
| --- | --- | --- |
| JS-Heap des Hauptthreads nach GC, Tabelle offen | < 30 MB, auch nach 6 Ansichten | 63,5 MB (leer 11 MB; ~0,53 MB je 1 000 Zeilen) |
| Längste Aufgabe beim Öffnen | < 200 ms | 318 ms (3 Long Tasks), Öffnen 1,1 s |
| Neuladen mit offener Tabelle bis zur ersten Zeile | < 2 s | 2,5 s, längste Aufgabe 212 ms |
| DOM-Knoten | wächst nicht mit den Zeilen | 684 |
| Spalte „ID“ anlegen: längste Aufgabe | < 200 ms | ~1 030 ms (vorher 2 083 ms; `e2e/database-perf.spec.ts`) |

Heap-Snapshot mit offener Tabelle (75 MB gesamt): Den Hauptteil hält die **Replik der Seite im Hauptthread**
(`PageReplica.store`, `apps/web/src/worker/client.ts`) – alle 100 000 Zeilen als Records (~414 000 Objekte, 11,6 MB
Objekte + 3,3 MB Property-Arrays + 3,6 MB Zahlen; Zeichenketten wie Typ „page“, Bearbeiter und Stempel-Knoten je
Zeile einzeln, weil `postMessage` sie nicht teilt, zusammen ~5 MB) samt `blocks`- und `childIndex`-Map. Dazu kommen
eine zweite Map mit 100 000 Einträgen in `StoreClient` (`titles`: der Worker meldet die Titel aller Seiten, auch
jeder Zeile), mehrere Kopien der Zeilenliste der Abfrage (je 0,46 MB) und die Messwerte des Virtualisierers
(Float64Array, 1,6 MB). Der Plan aus BSD-605 (Hauptthread bekommt nur ein Fenster der Zeilen, Abfragen im Worker)
trifft also die Ursache; das ist ein Umbau von Replik und Datenbank-Ansicht und kommt nach dem 23.11.

## Auf beta ausgeblendet, aber im Erststart-Chunk

Beim Start lädt der Beta-Build nur `index`, `store.worker`, `hangWatchdog.worker` und `sqlite3.wasm` – kein Chunk für
Graph, Coding, Chat, xterm, Mermaid, PDF oder onnxruntime. Chat und Agenten-Einstellungen sind seit BSD-595 eigene
Chunks. Im Erststart-Chunk stecken laut Sourcemap (19.11., roh) aber noch Echtzeit-Text (yjs, Hocuspocus, lib0 ≈ 110 kB)
und Agenten-Kerncode (`core/editor/agent.ts`, `core/whiteboard/agent.ts` ≈ 43 kB) – beides auf beta ausgeblendet –
sowie Importer (≈ 165 kB) und Whiteboard (≈ 75 kB), die erst beim Import bzw. beim ersten Board gebraucht werden
(Backlog, nach dem 23.11.). Die Küstenlinien der Karte (67 kB roh, 25 kB gzip) lädt seit dem Review vom 19.11. erst
die erste Karte; `e2e/beta-build.spec.ts` prüft das.
