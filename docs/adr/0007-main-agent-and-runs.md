# ADR 0007: One main agent; every run is a record; projects organise runs

- **Status:** accepted (2026-11-08, architecture review)
- **Deciders:** Elija, architecture review

## Context

Agent work in Based happens in several places (chat answers, Claude Code sessions, scheduled runs) with no
common record of what ran, why, for which goal, and at what cost. The plan is a single main agent that
delegates, organised the way Paperclip does it (goal → project → run, budget per agent, heartbeat).

## Options

1. Keep separate histories per feature.
2. A log file per run outside the workspace.
3. Runs and projects as databases in the Agent Brain workspace.

## Decision

Option 3. One **main agent** (orchestrator) delegates to sub-agents. Every run (chat answer, session,
scheduled run, sub-agent) is a record in a database "Runs" in the Agent Brain, with status, project,
parent run, engine/model and cost. Projects are a database too. Organisation follows Paperclip:
goal → project → run, a budget per agent, a heartbeat/schedule. The home screen is only a view over these
records (sun = main agent, orbits = projects and runs).

## Consequences

- Runs are visible, searchable and syncable like any other Based data, and reachable via MCP.
- Cost and budget can be enforced per agent and per project.
- The Runs schema becomes a data format: changes need migrations.
- Follow-ups: BSD-43 (Runs) → BSD-44 (Projects) → BSD-51 (Budget) → BSD-52 (main agent) → BSD-55 (home).
