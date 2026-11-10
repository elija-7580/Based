# Based sync protocol (v2)

The protocol every Based client speaks with a `based-server`: the macOS/iOS app today, a web, Windows or
Linux client tomorrow. It is plain JSON over HTTPS, so any language can implement it.

## Data model

A workspace is a set of **records**. Each has a kind, an id and a JSON payload:

| kind        | what it is                                                                      |
|-------------|---------------------------------------------------------------------------------|
| `workspace` | one per workspace: name, icon, teamspaces, settings                             |
| `block`     | every page, database row, paragraph, heading, list item, image …                |
| `database`  | the schema of a database (properties, options, formulas)                         |
| `view`      | a database view (table, board, calendar …) with filters, sorts and grouping      |

On the wire a record is `{"kind": "block", "data": { … }}`. A record key is `{"kind": "block", "id": "…"}`.

Fields every payload has:

- `id`: UUID string.
- `stamp`: `{"millis": 1793974300424, "counter": 201, "node": "3c8ed7c0"}`, a hybrid logical clock (HLC)
  stamp. It orders versions of the same record. Compare `millis`, then `counter`, then `node`.
- Blocks also have `parent` (`"w"` for top-level pages, `"b:<blockID>"`, `"d:<databaseID>"` for rows) and
  `sk`, a fractional-index sort key. Children of a parent are ordered by `(sk, id)`. Inserting between
  two siblings means picking a key between theirs; nothing else gets renumbered.

**Merge rule:** last writer wins per record, by `stamp`. A client applies an incoming record only when its
stamp is greater than the local copy's. Clients must advance their own clock past every stamp they see, so
their next local edit wins.

**Deletions are stamped tombstones** (ADR 0002, since format v3 / BSD-24): a deletion on the wire is
`{"kind": "block", "id": "…", "stamp": {…}}`, where `stamp` is the HLC stamp of the delete. The same rule
applies in both directions:

- A deletion removes a copy only if that copy's `stamp` is **older** than the deletion's. A newer edit or
  restore wins; the receiver keeps its copy (the server sends it back in `newer`).
- A record whose key has a **newer** tombstone stays deleted (no resurrection of a block edited offline on a
  page that was deleted later).
- `stamp` is optional, so older clients keep working: the server stamps an unstamped pushed deletion with its
  own clock on receipt. A deletion that arrives at a client without a stamp (older server, or a visibility
  removal for a share guest) is applied unconditionally, as before.
- Restoring a page from the Trash re-stamps everything inside it (blocks, rows, databases, views), so a restore
  wins over an older "Delete forever" on another device with all its content, not as an empty page.
- **Orphans** (BSD-104): a block edited after its page was deleted forever wins against the tombstone, its page
  doesn't come back. After each pull the client checks the arriving blocks and the children of arriving
  deletions; a block whose parent block/database is missing goes to the Trash instead of staying invisible
  (`WorkspaceStore.rescueOrphans`): pages and rows move to the top level and into the Trash, other blocks move
  into one page "Recovered blocks" (ID `recovered-blocks`) that sits in the Trash. Not undoable, logged as a
  local change (other devices get the same state). Nothing is deleted.

Unknown fields must be preserved (decode and re-encode them untouched). That lets newer clients add fields
without breaking older ones. Since BSD-25 the Swift clients do this:

- Block (top level and `props`), Database, each property schema, DatabaseView and Workspace keep keys they
  don't know in `extra` and write them back unchanged (`BasedCore/Model/ForwardCompatibility.swift`).
- An unknown block `type`, property `type` or view `type` decodes as `.unknown`; the original string is kept
  and written back. The app shows such a block as a grey read-only line ("needs a newer version of Based"),
  it can't be turned into another type; unknown views render as a table.
- Received record lists (`records` of a pull page, `newer` of a push reply) are decoded record by record: one
  that still can't be read (broken JSON, unknown record kind) is skipped and logged, the rest is applied.
  Pushes are decoded strictly, so a server never silently drops what a client sent.
- Not covered yet: unknown cases of nested enums (property values, filter operators, …) still fail the
  record; such rows are kept raw and never deleted (BSD-16).

## Endpoints

All requests send `Authorization: Bearer <token>`.

### `GET /sync/v2/info`

```json
{ "protocol": 2, "seq": 18234, "oldestSeq": 9120 }
```

`seq` is the server's latest change number. `oldestSeq` (BSD-104, 0 or missing = nothing compacted): tombstones
up to this number may have been removed. A client whose `pulled` is above 0 but below `oldestSeq` pulls everything
again (`after=0`) after pushing its own changes, and then deletes the records the server no longer has (except
ones changed locally during that sync and rows it can't decode). Clients treat a failing `info` as `oldestSeq = 0`.

### `POST /sync/v2/push`

Body:

```json
{ "records": [ {"kind": "block", "data": {…}} ], "deletions": [ {"kind": "block", "id": "…", "stamp": {…}} ] }
```

Reply:

```json
{ "newer": [ {"kind": "block", "data": {…}} ], "seq": 18240, "deleted": [ {"kind": "block", "id": "…", "stamp": {…}} ] }
```

`newer` lists records where the server already had a newer version than the pushed one (also when a pushed
deletion lost against a newer edit). `deleted` (optional, may be missing from older servers) lists pushed
records the server keeps deleted because its tombstone is newer. The client applies both. Push in batches of about 500 records.

### `GET /sync/v2/pull?after=<seq>&limit=<n>`

Reply:

```json
{ "records": […], "deletions": [ {"kind": "block", "id": "…", "stamp": {…}} ], "next": 18240, "more": false }
```

This returns every record changed after server change number `after`, oldest first. Each record appears
at most once, in its current version. Pass `next` as `after` for the next page, and repeat while `more`
is `true`. Start with `after=0` for a full download.

### `GET /sync/v2/wait?after=<seq>&timeout=<seconds>`

```json
{ "seq": 18241 }
```

Long poll. It answers as soon as the server has a change after `after`, or after `timeout` seconds (at most
55). Clients loop on it and run a sync round when `seq > pulled`, so changes from other devices arrive within
about a second without constant polling.

## Assets (files and images, BSD-78)

Bytes of images and attachments don't travel in records. A record only carries an `AssetRef`
(`{"id", "name", "size"?, "mime"?}`, e.g. in `props.asset` of an image block); the bytes are a **blob addressed by
its SHA-256**. For files added in Based Next, `AssetRef.id` is that hash (64 lowercase hex characters), so the same
file is stored and uploaded once, whatever its name. No new record field, no change to push/pull.

`GET /sync/v2/info` additionally returns `"assets": {"maxBytes": 104857600, "chunkBytes": 8388608}` on servers that
store files. A server without that field (the Swift `based-server`) doesn't; clients then keep uploads queued.

| request | reply |
|---|---|
| `GET /sync/v2/asset/<sha256>/status` | `{"complete": false, "received": 2097152}` or `{"complete": true, "received": n, "size": n}` |
| `PUT /sync/v2/asset/<sha256>?offset=<n>&total=<size>` (body: raw bytes of one chunk, at most `chunkBytes`) | `202 {"complete": false, "received": n}`; with the last chunk `200 {"complete": true, …}` |
| `GET /sync/v2/asset/<sha256>` (optional `Range: bytes=a-b`) | `200`/`206` `application/octet-stream`; `404` until the upload is complete |
| `HEAD /sync/v2/asset/<sha256>` | `200` with `Content-Length`, or `404` |

- **Upload, resumable:** ask `status`, continue at `received`, send chunks in order. `offset` must equal what the
  server has (`409 {"received": n}` otherwise: continue there); `offset=0` starts over. Without query parameters a
  `PUT` is a whole small file. An existing blob answers `complete` at once (idempotent, deduplication across devices).
- **Verification:** with the last chunk the server hashes the file; if it isn't `<sha256>`: `422`, partial upload
  dropped. Clients verify downloads the same way.
- **Limits and errors:** `total` above `maxBytes` (default 100 MiB, `--max-asset-mb`) → `413 {"error": "asset too
  large", "limit": n}`; a chunk above `chunkBytes` → `413`; malformed id → `400`; no or wrong token → `401` (same
  auth middleware as every route, ADR 0006).
- **Client:** new files go into the device's blob store and a persistent upload queue (`meta assets.uploads`). Each
  sync round uploads queued files before pushing records; offline or failing uploads are retried with backoff
  (2 s … 5 min), a file above the limit is marked failed and not retried. Other devices download a blob only when a
  block showing it is opened (ranged requests of 1 MiB, an interrupted download continues); until then the block is a
  placeholder. `404`/incomplete means the device that added the file hasn't uploaded it yet: retry later.
- **Cleanup:** hourly (with the tombstone GC) the server marks blobs no record references and deletes one only after
  it has been unreferenced for 90 days in a row, the tombstone retention; unfinished uploads without progress go
  after 7 days. Clients don't delete local blobs yet.
- **Swift app:** its `AssetRef.id` is a UUID and its files travel only through CloudKit; such files are not on the
  server and show as "only stored on the device it was added on" in Based Next. Files from Based Next reach the
  Swift app as records whose bytes it can't fetch until it implements these routes.
- Logs carry counts and sizes only: no names, no hashes (route paths are logged as `/sync/v2/asset/:hash`).

## Client algorithm

The client keeps a **local change log**: every local write gets an increasing local sequence number, plus a
flag for whether it was made on this device or received from sync. It also stores two numbers:

- `pushed`: local sequence up to which local changes are uploaded.
- `pulled`: server sequence up to which changes are downloaded.

Each sync round:

1. **Push:** read log entries after `pushed` in pages and upload the local ones (deleted entries as
   `deletions`). Apply `newer` from the reply. Set `pushed` to the last entry of the page.
2. **Pull:** call `pull?after=pulled` until `more` is false. Apply records (last writer wins) and deletions,
   logging them as *not local* so they are never pushed back. Set `pulled = next` after every page.

Besides the rounds, the client runs `wait` in a loop and syncs when it reports a change. It also pushes
about 1.5 s after a local edit pauses, so it doesn't wait for the next timer tick (20 s).

Both numbers live in the local database, not in memory. A crash or quit between two rounds therefore loses
nothing: the next round pushes everything after `pushed` again.

### Why not use the HLC stamp as the cursor (v1)?

v1 pulled "everything with a stamp greater than the last stamp I saw". A device that was offline writes with
stamps from its past. When it later uploads, other clients have already moved their cursor past those
stamps and never download the changes. v2's cursor is the **server's** own change number, which always
grows in arrival order.

## Server

`based-server` (`Swift/BasedBrain/Sources/based-server`) stores the workspace in SQLite, the same as the
app. It has a `changes(seq, kind, id, deleted, local, deleted_stamp)` table with one row per record: its latest
change. `pull` reads that table by `seq`. A row with `deleted = 1` is the record's tombstone; `deleted_stamp`
(JSON stamp, NULL for deletions logged before format v3) is what pushes are compared against, so the change
log doubles as the tombstone table (client and server use the same code). **Tombstone GC** (BSD-104): at start
and then hourly the server removes deletion rows whose stamp is older than 90 days
(`SyncServer.compactTombstones`; records are never touched, unstamped pre-v3 rows stay) and raises
`meta sync.oldestSeq` to the highest removed `seq`; a device offline for longer does a full pull (see
`/sync/v2/info`). Share guests (`ShareService` pulls) don't check `oldestSeq` yet; clients don't compact their own
logs. v1 endpoints (`/sync/push`, `/sync/pull`) remain for older apps. The TypeScript server (`apps/server`, `docs/server.md`) implements the same endpoints and rules.

## Channels

Based has two sync channels, and they don't forward to each other:

- **Based server (sync v2, this document)** — the main channel (ADR 0001). Pushes every change from the
  local change log with `local=1`.
- **iCloud / CloudKit** — experimental, off by default (Settings → Sync & server → iCloud (experimental)).
  Changes that arrive through CloudKit are logged with `local=0`, so they are never pushed to a server;
  changes pulled from a server don't reach CloudKit either.

A device that uses only one channel therefore never sees edits made through the other: use one channel on
all devices. The app decides which channels run with `SyncChannelPolicy.active(serverConfigured:
cloudKitSetting:buildHasContainer:usedCloudKitBefore:)` in BasedBrain: iCloud runs only when the switch is
on and the build has a container; a workspace that already synced through iCloud and has no server keeps
iCloud once after updating. With both on, Settings and the log show a warning. The sidebar shows the active
channel ("Server", "iCloud", "Server + iCloud", "Local only").

## Implementations

| client                 | status                                                                   |
|------------------------|--------------------------------------------------------------------------|
| macOS / iOS (Swift)    | `ServerSync` in BasedBrain; v2 with automatic fallback to v1               |
| Linux (Swift)          | BasedCore + BasedBrain build and test on Linux; `based-server` runs there |
| TypeScript (`packages/sync`) | v2 only (BSD-152): `SqlitePersistence` (same file format and migrations as the Swift app), `SyncClient`; drivers `@based/sync/node` (node:sqlite) and `@based/sync/wasm` (SQLite-WASM + OPFS in a worker). Tested against an in-process server and, with `BASED_SERVER_BIN`, the Swift `based-server`. Orphan rescue (BSD-104) not ported yet |
| TypeScript server (`apps/server`) | v2 + v1 (BSD-158) on the same file format; assets (BSD-78); long poll event-driven; tested with `SyncClient` and the unchanged Swift `ServerSync` (`ci/server/swift-client-compat.sh`). See `docs/server.md` |
| Web / Windows / Linux UI | planned. See `docs/platforms.md`                                         |
