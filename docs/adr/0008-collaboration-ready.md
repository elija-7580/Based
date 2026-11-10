# ADR 0008: Prepare the data model for real-time collaboration; CRDT chosen by spike

- **Status:** accepted (2026-11-08, architecture review)
- **Deciders:** Elija, architecture review

## Context

Real-time multi-user editing like Notion is a goal, but not now. Today the merge rule is last-writer-wins
per record, and some records are coarse: a database schema holds all its properties, so two people editing
different properties overwrite each other. Rich text is a single value per block.

## Options

1. Build collaboration later and change the model then.
2. Adopt a CRDT library for everything now.
3. Make records finer now, keep LWW per record, and pick a text CRDT through a time-boxed spike.

## Decision

Option 3. Database properties become records of their own, so concurrent edits to different properties
do not collide. Rich text stays LWW per block until a spike picks a text CRDT (candidates: Automerge,
Loro, y-crdt, an in-house sequence CRDT). Criteria: testable on Linux, a JavaScript counterpart for the
web client, acceptable size and performance on large pages.

## Consequences

- Finer records mean more rows to sync, and a data-format change with migration.
- The collaboration step later is mostly the text layer, not a rewrite.
- Until then, concurrent edits to the same block still resolve by LWW.
- Follow-ups: BSD-29 (CRDT spike), BSD-30 (properties as records).

## Note (2026-11-10)

Sharing on the TS server (roles, filtered sync, publish to web) works on top of LWW per record and does not
depend on the text CRDT: guests sync like any device, with records filtered by role. Real-time multi-user editing
stays out of scope until the `/collab` path materialises Y changes into records (docs/server.md).
