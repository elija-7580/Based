# ADR 0005: One ChatEvent stream for every engine; ChatEngine lives in BasedBrain

- **Status:** accepted (2026-11-08, architecture review)
- **Deciders:** Elija, architecture review

## Context

Based talks to several engines: the Anthropic/OpenAI APIs, Claude Code, Codex, Gemini CLI, OpenCode and
on-device models. Each path reports progress in its own shape, and the orchestration of a chat turn
(`BrainModel.ask`) lives in the app target, where it cannot be tested on Linux. `ChatEvent`
(`BasedBrain/Agent/ChatStream.swift`) already exists for part of this.

## Options

1. Keep per-engine handling in the app.
2. One event type, but each view consumes engines directly.
3. Every engine emits the same `ChatEvent` stream; a `ChatEngine` in BasedBrain orchestrates turns.

## Decision

Option 3. All engines deliver the same `ChatEvent` values over a serial `AsyncStream` (text deltas, tool
calls and results, permission requests, usage/cost, done/error). Chat orchestration (history, tools,
permissions, retries, routing) lives in `ChatEngine` in BasedBrain. The app only renders events and sends
user input.

## Consequences

- Chat logic becomes testable on Linux with fake engines.
- Adding an engine means writing one adapter to `ChatEvent`, nothing in the UI.
- The serial stream keeps event order deterministic; adapters must not emit from several tasks at once.
- Follow-ups: BSD-45 (ChatEngine) and the engine adapters after it.
