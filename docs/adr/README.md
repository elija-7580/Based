# Architecture decision records

Short records of architecture decisions for Based. Each file has: title, status, context, options,
decision, consequences. Source: the architecture review of 2026-11-08.

| ADR | Decision |
| --- | --- |
| [0001](0001-server-sync-primary.md) | Server sync v2 is the primary channel; CloudKit stays in the code but is off by default. |
| [0002](0002-tombstones-and-unknown-fields.md) | Deletions are stamped tombstones; unknown fields and block types survive decoding. |
| [0003](0003-persistence-off-main.md) | SQLite writes go through a persistence actor off the main thread, flushed on quit/background. |
| [0004](0004-swift-testing.md) | Swift 6.2 is pinned; package tests use Swift Testing only, no `@MainActor` XCTestCase. |
| [0005](0005-one-chat-event-stream.md) | Every engine emits one `ChatEvent` stream; chat orchestration lives in `ChatEngine` in BasedBrain. |
| [0006](0006-server-router.md) | based-server gets a router with auth middleware, limits and timeouts; no open start without token. |
| [0007](0007-main-agent-and-runs.md) | One main agent delegates; every run is a record in "Runs"; projects organise runs (Paperclip-style). |
| [0008](0008-collaboration-ready.md) | Prepare for multi-user: properties become records, text CRDT chosen by spike, LWW until then. |
| [0009](0009-design-tokens.md) | Colours, spacing, fonts, radii and motion come only from `DS`/`Theme`. |
| [0010](0010-text-crdt.md) | *Superseded by 0011:* Automerge als Text-CRDT pro Block vorgeschlagen; der Spike bleibt als Messgrundlage. |
| [0011](0011-typescript-stack.md) | Neustart: TypeScript-Kern, BlockNote + Yjs, Tauri 2 (Desktop), Tauri Mobile/Capacitor, Watch nativ; Migration über Fixtures und Sync v2. *Umgesetzt 11.11.2026 (BSD-168): Swift-Code in `legacy/`.* |
| [0012](0012-design-language.md) | Designsprache „Based Default“: leiser Standard, Agent-Marker als einziges Signal, Theme „Bold“; Werte im Paket `@based/design-tokens`. |
| [0013](0013-main-agent-task-cards.md) | Hauptagent als Auftragskarten: Auftrag zuerst gespeichert, Plan per Schema aus festem Aktionskatalog, deterministischer Ausführer mit Undo und Sicherheitsstufen. |
| [0014](0014-properties-as-records.md) | Datenbank-Properties als eigene Records: Record-Art `property`, Sicht im Store, deterministische Migration, alte Clients gesperrt (BSD-30). |
| [0015](0015-folder-sync-icloud.md) | *Vorgeschlagen:* Sync über einen geteilten Ordner (iCloud Drive) – ein Schreiber je Datei, Segmente mit Endmarke, LWW wie der Server; Spike hinter Schalter (BSD-296). |
| [0016](0016-block-editor.md) | Eigener Block-Editor nach dem Anytype-Prinzip (Clean-Room, kein Code übernommen): ein Modell (Block-Records), Befehle im Kern, ein Textfeld pro Block, Fokus-Manager, Auswahl- und Zieh-Schicht; BlockNote hinter Schalter bis Parität (Phasen E0–E8). |
| [0017](0017-storage-and-sync-efficiency.md) | Speicher und Sync für große Workspaces: SQLite als eine Quelle, im Speicher nur Gerüst und Offenes (Schema v4); jedes Gerät hält alles offline; Protokoll v4 mit geordnetem Pull, kompakten Records und E2E-Umschlag; Server ohne Store im Speicher; Messungen in `spikes/storage-bench`. |
| [0018](0018-agent-brain-recall.md) | *Vorgeschlagen:* Agent Brain über MCP – Erinnerungen als Zeilen, Relationen als Graph über vorhandene Kanten, kleiner Vektor-Index (Bits + int8, eine abgeleitete Datei), `recall` führt Wörter, Bedeutung und Nachbarn zusammen. |

New decisions get the next number. A superseded ADR keeps its file and gets status "superseded by NNNN".
