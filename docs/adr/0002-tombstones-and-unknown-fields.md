# ADR 0002: Stamped tombstones; unknown fields and block types survive decoding

- **Status:** accepted (2026-11-08, architecture review)
- **Deciders:** Elija, architecture review

## Context

Deletions are currently applied without a stamp. A restore can lose against an older "empty trash", and
a deleted block can reappear when an older copy arrives. Separately, a client decodes records into fixed
Swift types: fields or block types it does not know are dropped, and records it cannot decode at all are
treated like deletions. An older client therefore destroys data written by a newer one (web, Windows,
a later app version).

## Options

1. Keep unstamped deletes; forbid schema changes across versions.
2. Stamped tombstones plus a catch-all for unknown content.
3. Move to a full CRDT for every record now.

## Decision

Option 2.

- A deletion is a tombstone carrying an HLC stamp. It is applied only when its stamp is newer than the
  local copy's; a newer edit or restore wins over an older delete.
- Unknown JSON fields are kept in a catch-all and written back unchanged on encode.
- Unknown block types decode into a placeholder that keeps the raw payload and renders read-only.
- A record that cannot be decoded is never synced as a deletion; it is kept raw and reported.

## Consequences

- Payloads grow slightly (unknown fields round-trip). The on-disk format changes need a migration and a
  test that reads old data (house rule).
- Old and new clients can coexist on one server without data loss.
- Follow-ups: BSD-16 (undecodable ≠ deleted), BSD-24 (tombstones), BSD-25 (unknown fields).
