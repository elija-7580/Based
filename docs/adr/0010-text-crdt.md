# ADR 0010: Text-CRDT für Echtzeit-Zusammenarbeit – Automerge (vorgeschlagen)

- **Status:** superseded by 0011 (2026-11-09) – ursprünglich vorgeschlagen (Spike BSD-29, Nachtlauf); mit dem TypeScript-Stack wird Yjs verwendet
- **Bezug:** ADR 0008 (Kollaboration vorbereiten, LWW bis zum Spike), `docs/sync-protocol.md`, `Model/RichText.swift`
- **Spike-Code:** `spikes/crdt/` (nicht in Pakete oder CI eingebunden, siehe README dort)

## Kontext

Heute ist ein Absatz ein `block`-Record mit `RichText` (Runs mit `Marks`, Mentions und Gleichungen als atomare
Runs, Offsets in UTF-16). Der Sync mergt per Last-Writer-Wins pro Record (HLC-Stempel). Bearbeiten zwei Personen
denselben Absatz, verliert eine von beiden ihre Änderung. Für Echtzeit-Multiuser wie in Notion braucht der Text
eines Blocks ein CRDT. Gesucht ist eines, das

1. unter Linux mit `swift test` läuft (CI, und vor allem **based-server läuft auf Linux** und muss Textzustände
   mergen oder wenigstens speichern und materialisieren können),
2. ein JS-Pendant für einen späteren Web-Client hat (gleiches Binärformat),
3. MIT/Apache-lizenziert ist,
4. Formatierung (Marks: fett, kursiv, Farbe, Link …) mit sinnvoller Erweiterungs-Semantik kann,
5. pro Absatz wenig Speicher braucht und 1000 Ops schnell mergt,
6. sich in das Record-Modell einfügen lässt.

## Optionen und Messungen

Szenario (identisch in allen Programmen, `spikes/crdt/`): Absatz mit 55 Zeichen auf zwei Replikaten; A tippt 500
Zeichen einzeln in der Mitte, B tippt 500 Zeichen am Ende und setzt „fett“ (0–9) und einen Link (20–30); danach
Merge in beide Richtungen (1000 Ops). Interleaving-Test: beide tippen „abc“ bzw. „xyz“ an derselben Stelle.
Gemessen am 2026-11-09 auf der Nachtlauf-VM (Linux x86_64, 2 CPUs, parallel lief ein zweiter Build), Node 22,
Swift 6.2. Zahlen sind Größenordnungen, keine sauberen Benchmarks.

| | Automerge | Loro | Yjs / Yrs | Eigenes RGA (Swift) |
| --- | --- | --- | --- | --- |
| Version geprüft | automerge-swift 0.7.2 (Rust-Kern 0.12), `@automerge/automerge` 3.5.0 | loro-swift 1.17.1, `loro-crdt` 1.17.1 | yswift 0.2.1 (y-uniffi), `yjs` 13.6.33 | Spike, ~200 Zeilen |
| Lizenz | MIT | MIT | MIT | – |
| Swift-Paket gepflegt? | ja (letzter Commit Okt 2026) | ja (letzter Commit Okt 2026) | nein (letzter Commit Jul 2024, 0.2.1) | – |
| **Linux mit SwiftPM** | **ja, verifiziert**: Package.swift hat einen Linux-Pfad (`systemLibrary _CAutomergeUniffi`), Rust-Staticlib selbst bauen (`cargo build --release`, ~3 min auf 1 Kern), eine `#error`-Sperrdatei entfernen → `swift run` läuft | nein ohne Fork: Binary-Target nur als XCFramework, kein Linux-Pfad; Crate selbst bauen + eigenes `systemLibrary`-Target nötig | nein ohne Fork: nur XCFramework | ja, trivial |
| JS-Pendant | `@automerge/automerge` (WASM, 3,6 MB) | `loro-crdt` (WASM, 3,6 MB) | `yjs` (reines JS, 2,6 MB entpackt) – größtes Editor-Ökosystem | müsste nachgebaut werden |
| Marks / Rich Text | ja: `mark(range, name, value, expand)` (Peritext), dazu Block-Marker | ja: `mark` mit `configTextStyle` (`expand`), Peritext-artig; außerdem Movable Tree | ja: `format(attrs)` auf `Y.Text` (Attribute, keine Expand-Semantik pro Mark) | ja, vereinfacht (neueste Op gewinnt, Bereich inklusive) |
| Text-Offsets | wählbar (`TextEncoding.utf16` passt zu `RichText`) | Unicode/UTF-8/UTF-16-APIs | UTF-16 (JS) | Zeichen |
| Edit 1000 Ops (JS) | 380–460 ms (ein `change` pro Tastendruck) | 16–41 ms | 18–23 ms | – |
| Merge 1000 Ops (JS) | 137–146 ms (inkl. `clone`) | 11–18 ms | 1–2 ms | – |
| Edit / Merge (Swift, Linux, release) | **13 ms / 2,9 ms** | – (nicht gebaut) | – | 9 ms / 13 ms |
| Größe nach Merge (1055 Zeichen, 2 Marks) | **482 B** (Swift `save`), 519 B (JS) | 735 B (Snapshot) | 1172 B (Update) | 91,7 KB (Op-Log als JSON, unkomprimiert) |
| Konvergenz Text + Marks | ja | ja | ja | ja (inkl. 20 Zufalls-Seeds mit 3 Replikaten) |
| Interleaving „abc“/„xyz“ | kein Verzahnen (`Halloxyzabc Welt`) | kein Verzahnen (Fugue) | kein Verzahnen | kein Verzahnen bei Vorwärts-Tippen (RGA; rückwärts möglich) |

### Bewertung

- **Automerge** erfüllt alle Kriterien und ist als einzige Bibliothek im Spike unter Linux mit SwiftPM tatsächlich
  gelaufen. Kleinstes Format, schnellster nativer Merge. Schwächen: JS-Edits pro Tastendruck sind langsam, wenn
  jede Taste ein eigener `change` ist (im Web-Client Tastendrücke bündeln); für Linux muss die Rust-Staticlib im
  Build erzeugt werden (Rust-Toolchain in CI und im Server-Image) und die `#error`-Sperre umgangen werden
  (Upstream-PR oder kleiner Fork/Patch).
- **Loro** ist am schnellsten im JS und hat das modernste Text-Verfahren (Fugue, minimales Interleaving) plus
  einen Movable Tree, der später auch Block-Hierarchien tragen könnte. Aber das Swift-Paket hat keinen Linux-Weg;
  wir müssten den Linux-Teil selbst pflegen. Gute Zweitwahl.
- **Yjs/Yrs** hat das größte JS-Ökosystem (ProseMirror/TipTap/CodeMirror-Bindings) und den schnellsten JS-Merge,
  aber das Swift-Binding ist seit 2024 still; wir müssten eigene UniFFI-Bindings auf Yrs bauen. Formatierung ohne
  Expand-Semantik pro Mark (Links „wachsen“ beim Weitertippen mit, wenn man nicht aufpasst).
- **Eigenes RGA** ist klein und läuft überall, aber: kein kompaktes Format (Op-Log 190× größer als Automerge),
  kein GC, vereinfachte Mark-Semantik (Peritext-Grenzfälle offen), und der Web-Client bräuchte eine zweite,
  exakt gleiche Implementierung in JS. Aufwand für ein produktionsreifes Niveau eher 1500–3000 Zeilen plus Tests.
  Nur als Rückfall, falls Rust im Build ausgeschlossen wird.

## Empfehlung (vorgeschlagen)

**Automerge** als Text-CRDT pro Block, Loro als dokumentierte Alternative.

Integration (eigener, nicht autonomer Eintrag; hier nur der Vorschlag):

1. **Eigener Record-Typ `textState`** (Schlüssel = Block-ID) mit dem Automerge-Dokument des Absatzes
   (`save()`-Bytes, Base64 im JSON). Nicht als Feld im `block`-Record: der Block bleibt LWW (Typ, Eltern,
   Sortierschlüssel, Farbe …), nur der Text wird gemergt, und der Server kann `textState` mergen statt
   überschreiben, ohne Block-Logik zu kennen.
2. `RichText` im Block bleibt als **materialisierte Ansicht** erhalten (alte Clients, Suche, Export, Agenten).
   Wer `textState` schreibt, aktualisiert `richText` in derselben Transaktion. Alte Clients ohne CRDT schreiben nur
   `richText`; ein neuer Client übersetzt so eine Änderung per Diff in Splice-Ops (Migration ohne Datenverlust).
3. Abbildung: Text mit `TextEncoding.utf16` (gleiche Offsets wie `RichText`), `Marks` → Automerge-Marks
   (`b,i,u,s,c,color,link`; `expand: after` für Stil, `none` für Link/Code), Mentions und Gleichungen als ein
   Zeichen U+FFFC mit Mark `mention`/`equation` (JSON-Wert).
4. Sync-Protokoll: neue Record-Art `textState`, Merge-Regel „CRDT-Merge“ statt LWW; Tombstones wie bei Blöcken.
   Für Echtzeit später inkrementelle Änderungen (`saveIncremental`/Sync-Messages) statt ganzer Zustände.
5. Build: Rust-Staticlib per Skript bauen (Linux: CI und Server-Image; Apple: das gepflegte XCFramework).
   Die `#error`-Sperre per Upstream-PR lösen oder das Paket mit einem Patch vendoren.

## Konsequenzen

- Neue Build-Abhängigkeit Rust (nur Linux/CI/Server), ein WASM-Modul (~3,6 MB) für einen Web-Client.
- Datenformat-Änderung (neue Record-Art) → Migration + Test mit alten Daten, wie in ADR 0002/0008 vorgesehen.
- Bis zur Integration bleibt LWW pro Block (ADR 0008 unverändert).
- Offene Fragen für die Integration: Speicher bei sehr langen Code-Blöcken (Automerge-Historie wächst; ggf.
  periodisch kompaktieren), Undo pro Nutzer über CRDT-Ops statt Record-Snapshots, Cursor/Präsenz (ephemer, nicht
  im CRDT).

## Quellen

- github.com/automerge/automerge-swift (Package.swift, `Sources/Automerge/_AutomergeLinux.swift`, `rust/`), automerge.org Doku (Rich Text, Marks)
- github.com/loro-dev/loro-swift (Package.swift, `loro-swift/Cargo.toml`), loro.dev Doku (Text, `configTextStyle`, Fugue)
- github.com/y-crdt/y-uniffi (yswift 0.2.1), docs.yjs.dev (`Y.Text.format`)
- Peritext (Litt, Lim, Kleppmann, van Hardenberg, 2022), Fugue (Weidner, Gentle, Kleppmann, 2023)
