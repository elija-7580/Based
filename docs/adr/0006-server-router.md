# ADR 0006: based-server gets a router with auth middleware and limits

- **Status:** accepted (2026-11-08, architecture review)
- **Deciders:** Elija, architecture review

## Context

`based-server`'s `main.swift` dispatches ~40 routes by hand. Authentication is checked per route, the
server starts without a token and is then open to anyone who can reach it, there are no body limits or
timeouts, and handlers hop to the main actor through a semaphore. This is not safe for a public
deployment.

## Options

1. Keep hand dispatch and add checks to every route.
2. Adopt a third-party web framework.
3. A small in-house router with a middleware chain.

## Decision

Option 3. Routes are registered on a router; every request passes through middleware for authentication
(bearer token, sharing roles from `docs/sharing.md`), body size limits and timeouts before reaching a
handler. Routes declare the role they need; the default is "authenticated". The server refuses to start
without a token unless it binds only to loopback.

## Consequences

- Auth is enforced in one place and cannot be forgotten on a new route.
- No new dependency; the router stays small enough to test on Linux.
- Existing clients keep working as long as they already send the token.
- The server must not be deployed publicly before this and the related security entries are done.
- Follow-up: BSD-34 (router), with BSD-33 and BSD-35.
