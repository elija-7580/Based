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

1. **New record kind `property`.** `id` is `<databaseID>/<propertyID>`. Fields: `databaseID`, `sk` (order,
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
2. Store: record kind, composed view (`store.databases`), diff on commit, remote merge per property record.
   Behind the switch `propertyRecords` (off by default). **Done.**
3. File migration: schema version 4 (`enablePropertyRecords`). Before anything is rewritten, the database
   records are copied into the table `property_migration_backup` inside the same file; on Node the whole file is
   copied as well. A file at version 4 always opens in the new format. The server runs the same step. **Done.**
4. Everything around it. **Done:** sharing (a property record has the role of its database), search, the page
   replica in the web app, MCP and CLI (they read the composed view). Archives stay in the portable old format
   (version 2): `store.exportRecords()` writes databases with their property list, so older builds and the
   importer keep working and no archive format 3 is needed. Version history stores blocks only and is not
   affected.
5. Server: protocol 3. Every sync request carries `X-Based-Protocol`. A protocol 2 client gets `426` from a
   converted server, a protocol 3 client gets `409` from a server that is not converted yet. **Done.**
6. Dry run on an export of the real workspace: `based check <export.based.zip>` (Elija runs it).
7. Switch-over, server first (`based-server --property-records`), then each device (Settings → Sync & server →
   Database columns → Convert…). Guests follow the server.
8. Cleanup after two weeks at the earliest: remove `legacyProperties` and the backup table.
9. Workspace lists (favourites, teamspaces) as finer records. **Open**, see decision 8.

## Consequences

- One more record per column, none per row. Size is not a concern.
- The way back until cleanup: `based-server --revert-property-records` (in code: `revertPropertyRecords(db)`)
  joins the property records back into their databases and sets the file to version 3. Schema changes made
  since the switch are kept. The backup table and the file copy are the second line.
- CI runs the unit tests twice, once per format (`BASED_PROPERTY_RECORDS=1`), until the old format is removed.
- Tests that pin the old wire format on purpose (golden fixtures, client compatibility) set the switch off
  themselves.
- The Swift app cannot read the new format. It is frozen and serves as specification only.

## What this does not solve

- Concurrent edits to the options of the same property.
- Concurrent typing in the same block. That is the text CRDT (ADR 0010).
