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

Unknown fields must be preserved (decode and re-encode them untouched). That lets newer clients add fields
without breaking older ones.

## Endpoints

All requests send `Authorization: Bearer <token>`.

### `GET /sync/v2/info`

```json
{ "protocol": 2, "seq": 18234 }
```

`seq` is the server's latest change number.

### `POST /sync/v2/push`

Body:

```json
{ "records": [ {"kind": "block", "data": {…}} ], "deletions": [ {"kind": "block", "id": "…"} ] }
```

Reply:

```json
{ "newer": [ {"kind": "block", "data": {…}} ], "seq": 18240 }
```

`newer` lists records where the server already had a newer version than the pushed one. The client applies
them. Push in batches of about 500 records.

### `GET /sync/v2/pull?after=<seq>&limit=<n>`

Reply:

```json
{ "records": […], "deletions": [ {"kind": "block", "id": "…"} ], "next": 18240, "more": false }
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

`based-server` (`Packages/BasedBrain/Sources/based-server`) stores the workspace in SQLite, the same as the
app. It has a `changes(seq, kind, id, deleted, local)` table with one row per record: its latest change.
`pull` reads that table by `seq`. v1 endpoints (`/sync/push`, `/sync/pull`) remain for older apps.

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
| Web / Windows / Linux UI | planned. See `docs/platforms.md`                                         |
