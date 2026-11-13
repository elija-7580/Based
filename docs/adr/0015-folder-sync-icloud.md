# ADR 0015: Sync over a shared folder (iCloud Drive) as an option (BSD-296)

- **Status:** proposed (2026-11-12), spike behind a switch (default off) in `packages/sync/src/folder.ts`
- **Deciders:** Elija (decision on BSD-273: local storage + backups for the beta, iCloud sync in addition)
- **Follows:** ADR 0011 (TypeScript stack, no CloudKit), ADR 0002 (tombstones), sync protocol v2, BSD-271 (data-loss rules),
  BSD-274 (local backups)

## Context

The website promises "Mac app with local storage and iCloud sync". The Swift app used CloudKit; the TypeScript stack
(Tauri) has no CloudKit, and Sync v2 needs a based-server. Many beta testers have iCloud Drive but no server.

iCloud Drive syncs *files* in a folder. It gives no transactions, no ordering between files, and no notification of
partial uploads. Files can be placeholders (`.name.icloud`, not downloaded), half written while uploading, or duplicated
as conflict copies (`name 2.ext`) when two Macs write the same file.

## Decision

1. **One writer per file.** Every device writes only into `devices/<device-id>/` in the sync folder. There is no file
   two devices change, so iCloud never has to merge or create conflict copies of our data.
2. **Append-only segments with a completeness marker.** A device writes its local changes as numbered segments
   (`000000000007.jsonl`): a header line (format, version, device, seq, count), one line per change — the full record
   (`put`, the wire form of Sync v2 with its HLC stamp) or a deletion with its tombstone stamp (`del`) — and an end line
   with the count. Files are written atomically (temp file + rename).
3. **Readers merge with the server's rule.** Other devices read segments in order and apply them with
   `WorkspaceStore.applyRemote` — the same last-writer-wins by HLC stamp, the same tombstone rule ("deleted after this
   version was made stays deleted") as the server. Concurrent edits of different records always merge; of the same
   record, the later stamp wins, exactly as with a server.
4. **Never guess.** A segment without its end line, with a wrong count, with undecodable JSON or a record that does not
   parse is "not there yet": it is skipped and read again in the next round, and later segments of that device wait
   (order matters). Nothing undecodable is ever read as a deletion (BSD-271). Names that do not match the pattern
   (conflict copies, placeholders) are ignored and reported.
5. **Echoes are not written back.** Changes that arrived from the folder have origin `remote` and are not pushed again.
6. **One channel at a time.** Like the Swift app, a workspace syncs either with a based-server or through a folder,
   never both (both would echo each other's changes with different cursors). Switching is an explicit action.
7. **Attachments** are content-addressed (BSD-78); they go into `assets/<hash>` in the same folder, written once,
   never changed — the same layout as the backups (BSD-274), so a missing file is a placeholder, not an error.
8. **Compaction.** Each device may replace its own old segments with one snapshot segment (all current records it
   wrote last) once every other device has read past them (their cursors are visible as `devices/<id>/cursor.json`);
   until then nothing is removed. Implemented in BSD-334 (`FolderSync.compact`, `snapshot-<N>.jsonl`, `cursor.json`; a device without a cursor blocks compaction, a target without `remove` never compacts; a new device reads the latest snapshot and continues at N+1).

## Consequences

- No server, no account, no Apple-specific code: the transport is a folder; the Desktop shell only has to pick the
  folder (security-scoped access on macOS) and run a round every few seconds and on file-system events.
- The folder grows with every change until compaction exists; one segment per push (every ~1.5 s while typing) is
  small (only changed records), but compaction is required before a non-beta release.
- Clock skew matters as with the server (BSD-286): HLC stamps keep causality per device, wall-clock skew between Macs
  decides concurrent edits of the same record.
- Live collaboration on the same text (Yjs, BSD-220) is not part of folder sync; text edits merge per block record.

## Spike (this ADR)

`FolderSync` in `packages/sync/src/folder.ts` with an injectable folder (`FolderTarget`), switch `enabled` (default
off: nothing is observed, read or written). Tests (`packages/sync/test/folder.test.ts`): two simulated devices with
concurrent changes to different pages, a deletion, a half-uploaded segment that is skipped and read later, conflict
copies and placeholders ignored, broken segments never treated as deletions, switch off changes nothing.

## Follow-ups

- **Where it runs (BSD-334, 13.11.):** in the based-server, i.e. the desktop app's local sidecar (`--local`), with
  `--folder-sync <dir>`. The sidecar has file access (no WebView/worker file bridge needed) and the app keeps syncing
  with it over Sync v2; changes of its clients arrive there as origin `remote` and are exported (`exportRemote`).
- Desktop shell: choose the folder (default `~/Library/Mobile Documents/com~apple~CloudDocs/Based`), keep access,
  start the sidecar with `--folder-sync`; Settings → Sync & server: "Sync through iCloud Drive" (exclusive with a remote server).
- Compaction and per-device cursors; assets in the folder; Mac test with two Macs and one iCloud account.
