# Platforms: macOS, iOS, Linux, Web, Windows

Goal: one workspace on every device, in sync, with Based feeling native wherever it runs.

## What is portable today

| layer | language | runs on |
|---|---|---|
| **BasedCore**: model, store, transactions, undo, query and formula engine, import/export, search | Swift + Foundation + SQLite | macOS, iOS, **Linux** (tested), Windows (Swift toolchain; SQLite via vcpkg) |
| **BasedBrain**: AI providers, agent runtime, MCP server, sync server and client, Notion API import | Swift + Foundation | macOS, iOS, Linux |
| **based-server**: sync, MCP, scheduled agents, coding-agent daemon | Swift executable | Linux (Docker: `deploy/`), macOS |
| **App UI** | SwiftUI + AppKit/UIKit | macOS, iOS, iPadOS |

The data format and the sync protocol (`docs/sync-protocol.md`) are plain JSON with no Apple-only parts.
CloudKit sync is an optional second channel. The `based-server` channel works everywhere.

## Moving data between systems

- **Based archive** (`*.based.jsonl`, Settings → Export all → Based archive; File → Import reads it): one header line,
  then one record per line in the sync-protocol shape (`{"kind": …, "data": …}`). Lossless — pages, order, databases
  with views/filters/formulas, formatting, stamps. Verified on a 71,578-record workspace: export 30 MB, import into an
  empty workspace in 1.6 s with nothing skipped. Any client that speaks the sync protocol can read it.
- Markdown + CSV and HTML exports for other tools; Notion import (API or HTML export) for the way in.

## Recommended route to Web, Windows and Linux

1. **Web client** served by `based-server` at `/app`. A first read-only version exists
   (`Sources/based-server/WebApp.swift`, one HTML file with no build step): you enter the token, it pages through
   `/sync/v2/pull`, then shows the page tree and renders pages (text, headings, lists, to-dos, toggles, quotes, callouts,
   code, tables, columns, images, page links), updates live, and lets you edit text blocks without inline formatting
   (written back with a newer HLC stamp through `/sync/v2/push`). Next is the full client:
   - Data layer: an IndexedDB record store with the same records and the same change-log semantics as
     `SQLitePersistence` (one log row per record, local / remote flag), plus the sync v2 client loop.
   - Editor: a block editor with the same block types, `sk` ordering and Markdown shortcuts. The rules
     already live in BasedCore (`MarkdownShortcuts`, `SlashCommands`, `FractionalIndex`). They are
     small enough to port with shared test vectors (JSON fixtures exported from the Swift tests).
   - The query and formula engine runs server-side first (`POST /query`) and is ported later.
2. **Windows and Linux desktop**: the web client in a thin native shell (Tauri), with offline storage and
   the system keychain. This gives one UI codebase for three platforms. Mac and iPhone stay native SwiftUI.
3. **Alternative:** BasedCore compiled to WebAssembly (SwiftWasm) as the web data layer. It keeps one
   implementation of the store and query engine, but bundles are large and tooling is younger. Evaluate
   after step 1.

## Performance budget for large workspaces

Measured on a real workspace (71,373 records, 40 MB SQLite, release build):

| step | before | now |
|---|---|---|
| read + decode records | 525 ms | 194 ms (parallel JSON decoding) |
| build indexes | 273 ms | 122 ms (bulk child index) |
| open in app (debug build) | 866 ms | 407 ms |
| app memory after open | 302 MB | 164 MB (`Block.props` copy-on-write, shared when empty) |

Next steps, in order of payoff:

1. **Lazy page content.** Keep the page tree, databases and rows in memory, and load a page's block
   subtree on first open. This needs `parent` as an indexed SQLite column (`records(kind, id, parent, data)`).
   It turns startup into O(pages) instead of O(blocks).
2. **Compact payloads.** Of 28 MB of block JSON, only about 20 % is text. The rest is `stamp`
   (4.5 MB), ids, parents and timestamps written as fractional seconds. A compact encoding (integer
   milliseconds, a stamp string `millis:counter:node`, dropping default `createdBy`/`updatedBy`) saves
   about 40 %. Do it together with a protocol version bump, so older clients keep decoding.
3. **Server-side queries** for databases with 100k+ rows (`POST /query` paging).

## Sync in the background

- The macOS app syncs every 20 s and on changes, through `ServerSync` (v2: paged, resumable, nothing lost on
  quit) and optionally CloudKit.
- `based-server` runs on a VPS (`deploy/`). It is the always-on hub: it accepts pushes from every client, runs
  scheduled agents and serves MCP to Claude Desktop, ChatGPT and Cursor.
- Changes from other devices arrive within about a second (`GET /sync/v2/wait` long poll), and local edits are
  pushed about 1.5 s after typing pauses.
