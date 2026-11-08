# ADR 0003: Persistence runs off the main thread through a writer actor

- **Status:** accepted (2026-11-08, architecture review)
- **Deciders:** Elija, architecture review

## Context

`WorkspaceStore` is `@MainActor` and writes to SQLite synchronously inside every transaction, i.e. on
every keystroke. On large workspaces (50k+ blocks) this shows up as typing latency and hangs. Write errors
are also swallowed and the store silently falls back to RAM.

## Options

1. Keep synchronous writes, optimise SQL.
2. Make the whole store an actor (large API break, every view becomes async).
3. Keep the store `@MainActor` and its API; hand changed records to a dedicated persistence actor with a
   queue.

## Decision

Option 3. `WorkspaceStore` stays `@MainActor` with an unchanged public API. Transactions enqueue the
changed records to a `PersistenceWriter` actor that batches and writes them to SQLite off the main thread.
The queue is flushed when the app quits or goes to the background, and on demand (tests, export, sync).
Write errors are surfaced to the user, never swallowed.

## Consequences

- The main thread no longer blocks on disk I/O.
- There is a short window where data is in memory but not yet on disk; the flush points bound it. A crash
  inside that window loses at most the queued batch.
- Tests need an explicit `flush()` before reading the database back.
- Follow-ups: BSD-15 (visible write errors), BSD-42 (writer actor).
