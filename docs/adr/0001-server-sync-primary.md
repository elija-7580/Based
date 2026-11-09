# ADR 0001: Server sync v2 is the primary sync channel

- **Status:** accepted (2026-11-08, architecture review)
- **Deciders:** Elija, architecture review

## Context

Based has two sync paths: CloudKit (`BasedCore/Sync/CloudSync.swift`, `CKSyncEngine`) and the
`based-server` protocol v2 (`docs/sync-protocol.md`, `BasedBrain/Sync`). They do not bridge: a change
that arrives through CloudKit is never pushed to the server and vice versa. A device that uses both can
diverge silently. CloudKit also needs a paid Apple Developer team and cannot run on the web, Windows or
Linux clients that are planned on top of the server.

## Options

1. Keep both channels on and build a bridge between them.
2. CloudKit primary, server only for web/publish.
3. Server sync v2 primary; CloudKit stays in the code but is off by default.

## Decision

Option 3. Server sync v2 is the one channel every client speaks. CloudKit remains compiled in, behind a
build flag/setting that defaults to **off**, until an Apple Developer team exists and someone decides to
revive it. When it comes back it must go through the same record pipeline, never as a second, parallel
source of truth.

## Consequences

- One merge rule (LWW per record by HLC stamp) to test and reason about; it is testable on Linux.
- Sync needs a running `based-server` (self-hosted or Docker). Without one, Based is local-only.
- Assets (images, files) must move into server sync, since CloudKit no longer carries them.
- Follow-up: the CloudKit-off switch is its own backlog entry (BSD-28).
