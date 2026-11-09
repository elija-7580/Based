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
| [0010](0010-text-crdt.md) | *Vorgeschlagen:* Automerge als Text-CRDT pro Block (Record-Art `textState`), Loro als Alternative; LWW bis zur Integration. |

New decisions get the next number. A superseded ADR keeps its file and gets status "superseded by NNNN".
