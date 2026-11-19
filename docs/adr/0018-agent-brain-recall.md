# ADR 0018: Agent Brain – Abruf mit Relationen und Vektoren

- **Status:** vorgeschlagen (2026-11-18, Fable mit Elija im Chat) – gebaut auf dem Branch `fable/agent-brain-recall`,
  Entscheidungen unten offen. Notion: BSD-541.
- **Maßstab (Elija, 18.11.):** langfristig so effizient, schnell und gut wie möglich; läuft leicht auf einem Server,
  braucht wenig Platz, der Agent versteht Relationen.
- **Bezug:** ADR 0017 (Speicher/Sync; „Bereiche und Agenten“: Vektoren sind abgeleitet, nie synchronisiert),
  BSD-163 (Agent Brain), BSD-231 (lokale Modelle per Opt-in), BSD-517 (Suche mit Tippfehlern), BSD-522 (Herkunft),
  `docs/mcp.md` („Agent brain“).

## Anlass

Der TypeScript-MCP-Server hatte keine Werkzeuge für Memories und „About me“ – nur Skills als Prompts. Ein Agent kam
über MCP nicht an das Agent Brain. `docs/mcp.md` beschrieb die Werkzeuge des Swift-Servers, die nie portiert wurden.
Das Embedding-Modell lief nur im Browser-Worker der App; der Server (und damit MCP) kam nicht daran.

## Entscheidung

**Drei Schichten.**

1. **Wahrheit sind normale Records.** Eine Erinnerung ist eine Zeile in der Datenbank „Memories“: Titel = die
   Tatsache in einem Satz, „Type“ (Profile, Preference, Work, People, Notes), „Status“ (Active, To review,
   Superseded). Worum es geht, steht als Erwähnung im Rumpf (`About: [Seite](based://page/<id>)`), ebenso Quelle und
   was sie ersetzt. Lesbar, editierbar, synct wie alles, trägt die Herkunft aus BSD-522.
2. **Relationen sind ein Graph über das, was schon da ist** (`RelationGraph`): Datenbank-Relationen in beide
   Richtungen (mit Spaltenname), Erwähnungen und Links, Eltern/Kind. Keine eigene Ablage; nur der Rückweg wird im
   Speicher mitgeführt und folgt dem Store inkrementell (wie der `LinkIndex`).
3. **Der Vektor-Index ist eine abgeleitete Datei** `<db>.vectors` (`VectorIndex`): nie synchronisiert, jederzeit neu
   berechenbar, nach einem Modellwechsel verworfen.

**Vektoren klein.** Je Abschnitt Vorzeichen-Bits (48 Byte) und int8 mit eigener Skala (388 Byte) statt Float32
(1 536 Byte). Suche in zwei Stufen: Hamming-Abstand der Bits über alles, dann die besten 1 000 mit int8 nachrechnen.
Kein ANN-Graph (HNSW o. ä.): bei dieser Größe unnötig, spart Speicher und einen Index, der kaputtgehen kann.

**Bits um den Mittelwert, nicht um null.** E5 legt alle Texte in dieselbe Ecke des Raums (gemessen: bei 313 von 384
Dimensionen haben über 90 % der Vektoren dasselbe Vorzeichen). Rohe Vorzeichen-Bits fanden den besten Treffer nur
62 von 68 Mal, um den Mittelwert genommen 68 von 68 Mal (5 % Vorauswahl, echte Vektoren; Fixture
`packages/brain/test/fixtures/e5-vectors.bin`). Unter 1 000 Abschnitten wird ohne Vorauswahl gerechnet.

**Abschnitte mit Kontext.** Eine Seite wird entlang ihrer Blöcke in ~800 Zeichen geteilt; vor jedem Abschnitt stehen
Seitentitel und aktuelle Überschrift. Eingebettet wird nur, was sich geändert hat (Hash je Abschnitt).

**Abruf (`Recall`).** Wortsuche (ganze Anfrage + Wort für Wort, gewichtet nach Abdeckung), Vektoren (wenn geladen;
Schwelle und Gewicht nach Kosinus, weil E5 Unverwandtes bei 0,75–0,81 einsortiert), dann ein Schritt über die Kanten
der besten Treffer. Zusammengeführt per Reciprocal Rank Fusion. Antwort als knapper Text.

**Merken (`AgentBrain.remember`).** Eine Tatsache je Zeile. Dieselbe Aussage wird nicht verdoppelt (gleich nach
Normalisieren oder ≥ 80 % gemeinsame Wortstämme); `replaces` setzt die alte auf „Superseded“ statt sie zu
überschreiben; Heikles (Gesundheit, Geld) von Agenten wird „To review“ und zählt erst nach Freigabe.

**Ein Paket, zwei Orte.** `packages/brain/src/recall/` läuft im lokalen Server der Mac-App und auf based-server
(`BrainIndex`). Laufzeit: `onnxruntime-node`, wenn installiert, sonst `onnxruntime-web` (WebAssembly, liegt dem
Sidecar-Bundle bei – keine native Datei, nichts zu signieren).

## Gemessen (18.11.2026, Linux-VM, 4 Kerne arm64)

| Was | Wert |
|---|---|
| Index 150 000 Abschnitte × 384 (synthetisch, gebündelt) | 67 MB Datei (Float32: 230 MB), Laden 30 ms, Speichern 43 ms |
| Suche darin, Vorauswahl 200–1 000 | 2,9–3,3 ms; volle int8-Rechnung 102 ms |
| Übereinstimmung der Vorauswahl mit der vollen Rechnung (synthetisch) | bester Treffer 50/50, Top 10 zu 99,6–100 % |
| Einbetten, Abschnitt ~800 Zeichen, WebAssembly | 186 ms (1 Thread), 67 ms (4 Threads) |
| Einbetten, 200 Tokens, onnxruntime-node | 45 ms (1 Thread), 16 ms (4 Threads) |
| Arbeitsspeicher des Prozesses mit Modell | ~900 MB mit WebAssembly (inkl. tsx), ~245 MB mit onnxruntime-node (nur Modell) |
| `recall` mit Modell auf kleinem Workspace | 7–15 ms je Anfrage |

Nicht gemessen: ein echter großer Workspace (20 000 Seiten), die Mac-App selbst, die Trefferqualität jenseits der
acht Probeanfragen.

## Folgen

- Erster Aufbau für einen großen Workspace dauert: 150 000 Abschnitte × 67 ms ≈ 2,8 h mit WebAssembly, ≈ 40 min mit
  onnxruntime-node. Der Index wächst im Hintergrund, Anfragen laufen währenddessen schon.
- ~900 MB Arbeitsspeicher mit WebAssembly sind für einen kleinen Server zu viel → dort `onnxruntime-node`.
- Die Schwellen für E5 (`E5_CALIBRATION`) stammen aus acht Anfragen. Sie gehören mit echten Daten nachgemessen.

## Entschieden (Elija, 18.11.)

- „To review“ für Heikles bleibt: Agenten merken Gesundheit, Geld und Ähnliches nur zur Freigabe.
- Laufzeit: Elija überlässt die Wahl; Maßstab ist gute MCP-Anbindung bei wenig Daten und Speicher. Daraus folgt:
  `onnxruntime-node` als Ziel überall (4× schneller, rund ein Viertel des Arbeitsspeichers). Auf based-server sofort
  (als Abhängigkeit des Server-Images), in der Mac-App nach der Beta, weil die native Datei mitsigniert werden muss
  und das vor dem 23.11. nicht am Mac geprüft werden kann. Bis dahin läuft die Mac-App mit WebAssembly.

## Offen (Elija)

1. Modell in der Beta einschaltbar? Der Schalter in den Einstellungen fehlt (nur die Route `/local/brain/model`).
2. Wie verbindet ein Tester Claude Code/Desktop mit Based? Es gibt keine Stelle in der App, die das zeigt.

## Später

- „Aktiv“: Zähler und Datum des letzten Abrufs je Erinnerung (abgeleitet, nicht als Record – sonst schreibt jedes
  Lesen in den Sync), Verdichten als Agentenlauf.
- Gehirn-Ansicht und Review-Queue in der App (BSD-541 Rest), Inbox-Format (BSD-539), Op-Register (BSD-538).
- Derselbe Index im Browser-Worker statt des TF-IDF-Index (`LocalSemanticIndex`), damit ⌘K und „Related pages“
  dieselbe Suche nutzen.
- Volltext über SQLite FTS5 (BSD-515) als Wort-Quelle, sobald dort entschieden ist.
