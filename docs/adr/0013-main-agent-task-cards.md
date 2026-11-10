# ADR 0013: Main agent as task cards instead of a chat history (with skill selection and privacy redact)

- **Status:** accepted (2026-11-09)
- **Deciders:** Elija
- **Source:** Notion page "ADR 0013: Hauptagent als Auftragskarten statt Chat-Verlauf" (full text, options, sources)

## Context

Elija does not want to chat with the main agent but to give input into something visible: the input stays,
gets processed and lands as an agent, a project update, a task or a page. Today (Swift, BSD-52) the main agent is a
continuous chat thread with tools that decides everything in a free agent loop — flexible, but hard to predict and
not testable. Frame: TS stack (ADR 0011), runs as records (ADR 0007), structured chat events (ADR 0005), BYOK and
CLIs, privacy as the core message, setup "connect an account and done".

## Options

- **A – Chat with rich cards in the history:** least work, but it keeps scrolling up — exactly what is not wanted.
- **B – Task cards + plan schema + deterministic executor (chosen):** reliable (schema, fixed catalogue,
  fallback), testable with a golden set, cheap (a small model plans), undo everywhere, fits runs/events/permissions.
- **C – Fully generative UI:** maximally flexible, but unpredictable, breaks the design language, hard to test.

## Decision

Option B.

1. **Save the task first.** Sending creates a record in "Tasks" at once (local, offline-safe), before any model is
   asked. States: received → understanding → (question) → proposal/executing → done | failed. Every action has an
   idempotency id; after a restart the task continues at the last step. No Temporal/Inngest/DBOS: the records are the
   state machine.
2. **Plan as data.** A cheap model gets the input plus compact context (active projects, answers, personal
   corrections) and returns a plan via schema: actions from a fixed catalogue — `answer`, `create_page`,
   `create_task`, `file_to_project`, `spawn_agent`, `schedule`, `ask` — each with target, one-line reason and
   confidence. Invalid output: retry once, then file the input as a note in the Inbox. Never discard.
3. **Execute with safety levels.** Reversible and cheap → at once, with Undo (one transaction). Costs money or acts
   outside → proposal card. Unsure → question on the card with 2–3 buttons. Thresholds follow the permission modes
   and the agent's budget (within budget without confirmation, above it a proposal).
4. **Card instead of history.** The card shows each step live and flies to its target at the end; the conversation
   stays as events on the task. Server → app via an AG-UI-style event stream (run start/end, tool calls, state as
   snapshot + JSON-Patch deltas).
5. **Learn from corrections** as personal few-shot examples (deletable).
6. **Automatic skill selection** (local embeddings, top 5, chips) and 7. **privacy redact** (opt-in, before every
   external model call) follow as separate items.

## Consequences

- Easier: tests (golden set with a fake engine in CI), costs, undo, capture from Watch/shortcut (same task record).
- Harder: every new capability of the main agent needs a catalogue building block with a card; the catalogue must
  stay small.
- Implementation: BSD-195 (record, state machine, event stream), BSD-196 (plan schema, executor, undo, golden set),
  BSD-160 (runs, projects, permissions, budget), then the start page cards (BSD-162/197), skill router, redact.
