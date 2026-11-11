# ADR 0014: Database properties as records of their own (BSD-30)

- **Status:** accepted (2026-11-11), in progress on `fable/bsd-30`
- **Deciders:** Elija, architecture review (Fable)
- **Follows:** ADR 0008 (collaboration-ready model), ADR 0002 (tombstones and unknown fields)

## Context

A `database` record holds all its properties in one list. Sync merges by last-writer-wins per record, so two
devices that change different columns at the same time lose one of the changes. ADR 0008 decided to make
properties records of their own. The TypeScript model had not done that yet.

Facts the design rests on (checked in the code):

- Row values, views, formulas, relations and rollups refer to a property by its id, never by its position.
- Property ids are unique only inside one database. Every title property has the id `title`.
- About 165 places read `db.properties`; a handful write to it through `tx.update`.
- Record kinds are a closed set. An older client skips an unknown kind when pulling.

## Decision

1. **New record kind `property`.** `id` is `<databaseID>:<propertyID>`. Fields: `databaseID`, `sk` (order,
   same sort keys as blocks), `schema` (the property exactly as it stood in the list, unknown fields kept),
   `stamp`.
2. **The database record keeps everything else.** After the migration its `properties` list is empty and the
   old list stays frozen in `legacyProperties` until cleanup. That copy is the way back.
3. **Reading does not change.** The store composes `db.properties` from the property records, ordered by
   `(sk, id)`. Code that reads a database sees what it saw before.
4. **Writing does not change for callers either.** Callers keep handing the store a database with its
   property list. On commit the store diffs that list against the property records and writes only the
   records that changed or moved. The database record itself is written only when one of its own fields
   changed. This keeps the change in one place instead of in every caller.
5. **The migration is deterministic.** Ids from database id and property id, stamp equal to the database
   record's stamp, order from the list position. Two devices that migrate on their own produce the same
   records, and a later real edit always carries a newer stamp. No row record is touched.
6. **Old clients are locked out** once a workspace is migrated: sync protocol 3, and a protocol 2 client gets
   "update required" instead of data. Decided by Elija on 2026-11-11.
7. **Options of one property stay inside its record** for now. Two people editing the options of the same
   column at once still resolve by last-writer-wins. This can be refined later without another format change.
8. **Workspace lists** (favourites, teamspaces) move to finer records in the same protocol 3, as a separate
   step. Decided by Elija on 2026-11-11.

## Steps

1. Pure model, checker and dry run: `packages/core/src/model/property-records.ts`, `based check <archive>`. **Done.**
2. Store: record kind, composed view, diff on commit, remote merge per property record. Behind a switch.
3. File migration (schema 4) with a copy of the file made first, and the same step on the server.
4. Everything around it: sharing (a property has the role of its database), imports, archive format 3 with
   reading of older archives, version history (older snapshots are converted on restore), MCP, CLI.
5. Server: protocol 3 and the lock for protocol 2 clients.
6. Dry run on a copy of the real workspace (Elija runs it).
7. Switch-over with backup, server first, then devices.
8. Cleanup after two weeks at the earliest: remove `legacyProperties`.

## Consequences

- One more record per column, none per row. Size is not a concern.
- Until cleanup there are two ways back: turn the switch off and read `legacyProperties` (loses schema
  changes made since, keeps all row values), or restore the file copy.
- Version history holds snapshots in the old format. Restoring one must convert it, or it would bring the
  old list back. This needs its own test in step 4.
- The Swift app cannot read the new format. It is frozen and serves as specification only.

## What this does not solve

- Concurrent edits to the options of the same property.
- Concurrent typing in the same block. That is the text CRDT (ADR 0010).
