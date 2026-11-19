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
Tippen auf einer 300-Block-Seite und den Start mit 20 000 Seiten. `BASED_PERF_CHROME=<pfad>` nimmt ein vorhandenes
Chromium. Die Werte jedes Abends stehen in `perf-history.csv`. Alle Zahlen stammen aus dem Linux-Container
(Chromium headless); Mac-Werte (WKWebView, Energie, DMG) brauchen einen Mac-Test.

## Zielwerte und Stand (18.11.2026, Beta-Build, main efed361e)

| Kennzahl | Ziel | Stand | Wächter |
| --- | --- | --- | --- |
| Erststart-JS (index-*.js, gzip) | so klein wie möglich; Grenze 965 KiB (BSD-595) | 1 038 kB (roh 3 197 kB); 19.11. nach BSD-595: 918 KiB (Chat, Agenten, Anbieter als eigene Chunks) | `apps/web/scripts/bundle-budget.mjs` |
| Store-Worker (store.worker-*.js, gzip) | Grenze 295 KiB (BSD-595) | 19.11.: 319 → 281 KiB (Agenten-Werkzeuge als eigener Chunk) | `bundle-budget.mjs` |
| Erststart-JS gesamt mit Workern (gzip) | – | 1 301 kB, 3 Dateien | `ci/perf/measure.mjs` |
| Erststart-CSS (gzip) | Grenze 95 kB | 77 kB | `bundle-budget.mjs` |
| Web-Bundle gesamt (dist) | so klein wie möglich | 26,7 MB, davon 11,0 MB `ort-wasm-simd-threaded.wasm` | – |
| Kaltstart bis Seitenleiste, leerer Workspace | < 1 s | 0,85–1,0 s | `measure.mjs` |
| Start mit 20 000 Seiten bis Seitenleiste | < 2 s | 1,4–1,6 s, längste Aufgabe 58–74 ms | `e2e/startup-perf.spec.ts`, `scale-perf.spec.ts` |
| JS-Heap nach Start, leer | – | 11,1 MB | `measure.mjs` |
| JS-Heap mit 20 000 Seiten | kein lineares Wachstum mit der Gesamtgröße | 18,0 MB (0,35 MB je 1 000 Seiten) | `measure.mjs` |
| 50× Seite wechseln (300 Blöcke): DOM-Knoten nach GC | ±0 | ±0 (vor dem Fix vom 18.11.: +259 907 Knoten, +41 MB) | `e2e/editor-leak.spec.ts` |
| 50× ⌘K: Heap nach GC | kein Wachstum | −3,6 MB, +349 Knoten (beobachten) | `measure.mjs` |
| Leerlauf: Timer-Aufrufe in 10 s | 0 | 200 (Hänger-Wächter, 50-ms-Takt) + 1 (Sitzungs-Marke alle 10 s) | offen, siehe Backlog |
| Leerlauf: CPU des Hauptthreads | 0 % | 0,3 % (nach Editor-Weg 1,0 %) | `measure.mjs` |
| Leerlauf: requestAnimationFrame, laufende Animationen | 0 | 0 | `measure.mjs` |
| Tippen auf 300-Block-Seite | keine Long Tasks | 0 Long Tasks, 12–14 ms CPU je Zeichen | `measure.mjs`, `e2e/startup-perf.spec.ts` |
| Fehler in der Konsole auf dem Messweg | 0 | 0 | `measure.mjs` |
| WebView + Node zusammen nach Start (Mac) | < 150 MB | Mac-Test nötig | – |
| Energie im Leerlauf (Aktivitätsanzeige) | „0,0“ | Mac-Test nötig | – |

## Auf beta ausgeblendet, aber im Erststart-Chunk

Beim Start lädt der Beta-Build nur `index`, `store.worker`, `hangWatchdog.worker` und `sqlite3.wasm` – kein Chunk für
Graph, Coding, Chat, xterm, Mermaid, PDF oder onnxruntime. Der Erststart-Chunk selbst enthält aber AI-/Chat-Code
(`App.tsx` importiert `chat/ChatDock`, `tasks/AgentSettingsSection` statisch). Das ist ein Effizienz-Fund (Backlog).
