# CRDT-Spike (BSD-29) – Wegwerf-Code

Ergebnis und Empfehlung: [docs/adr/0010-text-crdt.md](../../docs/adr/0010-text-crdt.md).
Dieser Ordner gehört **nicht** zur App: kein Paket hängt davon ab, CI baut ihn nicht, `make`/`ci/` kennen ihn nicht.
Er darf gelöscht werden, sobald die Integration (eigener Eintrag) entschieden ist.

| Ordner | Was | Aufruf |
| --- | --- | --- |
| `js/` | Automerge, Loro, Yjs (die JS-Pendants für einen Web-Client) im selben Szenario | `cd js && npm install && node bench.mjs` |
| `swift-rga/` | Eigenes RGA-Text-CRDT mit Marks in reinem Swift (~200 Zeilen) + Tests/Benchmark | `cd swift-rga && swift test` (Benchmark: `swift test -c release --filter benchmark`) |
| `automerge-linux/` | Läuft `automerge-swift` unter Linux mit SwiftPM? | siehe unten |

Szenario überall gleich: Absatz „Der schnelle braune Fuchs springt über den faulen Hund.“ auf zwei Replikaten;
A tippt 500 Zeichen in der Mitte, B tippt 500 Zeichen am Ende und setzt „fett“ (0–9) und einen Link (20–30);
dann Merge in beide Richtungen (= 1000 Ops). Zusätzlich tippen beide „abc“/„xyz“ an derselben Stelle (Interleaving-Test).

## automerge-swift unter Linux

`automerge-swift` (0.7.x) lädt auf Apple-Plattformen ein XCFramework; unter Linux verlinkt es eine System-Bibliothek
`_CAutomergeUniffi`, die man selbst bauen muss. Zusätzlich bricht der Build unter Linux absichtlich mit `#error` ab
(`Sources/Automerge/_AutomergeLinux.swift`). Vorgehen im Spike:

```bash
git clone --depth 1 https://github.com/automerge/automerge-swift ../automerge-swift   # neben automerge-linux/
rm ../automerge-swift/Sources/Automerge/_AutomergeLinux.swift                        # #error-Sperre entfernen
(cd ../automerge-swift/rust && cargo build --release)                                 # ~3 min auf 1 Kern
cd automerge-linux
swift run -c release -Xlinker -L../automerge-swift/rust/target/release -Xlinker -luniffi_automerge
```

## Loro unter Linux

`loro-swift` (1.17.x) hat **keinen** Linux-Pfad: das Binary-Target ist unbedingt ein XCFramework. Für Linux müsste man
das Crate `loro-swift/loro-swift` selbst bauen und ein eigenes `systemLibrary`-Target samt Modulemap ergänzen (Fork).
Messwerte für Loro deshalb nur aus `js/`.
