// BSD-195: Auftrag zuerst gespeichert, Zustandsmaschine (alle Übergänge), Neustart mitten im Auftrag ohne doppelte
// Aktion, offline → wartet → läuft weiter, ungültige Ausgabe/Fehler → Retry → Notiz, Lease, Event-Strom.
import { MemoryPersistence, WorkspaceStore, plainText } from "@based/core";
import { describe, expect, it } from "vitest";
import {
  AgentStore, applyPatch, canTransition, diff, INBOX_PAGE_ID, localBackend, newTask, RulesPlannerEngine, ScriptedEngine, TaskRunner, TaskStream,
  TASK_STATES, transition, TransitionError, type ChatEngine, type TaskData, type TaskEvent,
} from "../src/index.js";

function setup(persistence = new MemoryPersistence()) {
  let t = 1000;
  const store = new WorkspaceStore({ node: "t", persistence, now: () => (t += 1) });
  const agents = new AgentStore(store, () => Date.UTC(2026, 10, 10, 12));
  return { store, agents, persistence, backend: localBackend(agents) };
}

const runner = (backend: ReturnType<typeof localBackend>, engine: ChatEngine | undefined, more: Partial<ConstructorParameters<typeof TaskRunner>[0]> = {}) =>
  new TaskRunner({ backend, engine: () => engine, today: () => "2026-11-10", owner: "tab-a", ...more });

const plan = (actions: object[]) => ({ summary: "x", actions });
const jsonEngine = (...replies: string[]) => new ScriptedEngine({ script: (_r, n) => [{ text: replies[Math.min(n, replies.length - 1)]! }] });

describe("Zustandsmaschine", () => {
  const base = newTask("hello", 1);
  const sample: Record<TaskEvent["type"], TaskEvent> = {
    understand: { type: "understand" },
    wait: { type: "wait", reason: "offline" },
    planned: { type: "planned", plan: { actions: [{ type: "answer", id: "a1", text: "x", reason: "", confidence: 1 }] }, decisions: { a1: "auto" }, next: "executing" },
    planInvalid: { type: "planInvalid", error: "bad" },
    filed: { type: "filed", noteID: "n", reason: "r" },
    answer: { type: "answer", option: "A" },
    confirm: { type: "confirm" },
    dismiss: { type: "dismiss", noteID: "n" },
    executed: { type: "executed", applied: ["a1"], undo: [], result: "ok" },
    fail: { type: "fail", error: "boom" },
    undo: { type: "undo", result: "Undone" },
    retry: { type: "retry" },
  };

  it("jeder Übergang: erlaubt → neuer Zustand, sonst TransitionError; Eingabe bleibt immer erhalten", () => {
    const expected: Record<string, Record<string, string>> = {
      received: { understand: "understanding", wait: "received", filed: "filed", fail: "failed" },
      understanding: { understand: "understanding", wait: "received", planned: "executing", planInvalid: "understanding", filed: "filed", fail: "failed" },
      question: { planned: "executing", answer: "understanding", dismiss: "filed", fail: "failed" },
      proposal: { confirm: "executing", dismiss: "filed", fail: "failed" },
      executing: { executed: "done", fail: "failed" },
      done: { undo: "undone" },
      failed: { retry: "received" },
      filed: { retry: "received" },
      undone: { retry: "received" },
    };
    for (const from of TASK_STATES) {
      const task: TaskData = { ...base, state: from };
      for (const [type, ev] of Object.entries(sample)) {
        const want = expected[from]![type];
        expect(canTransition(from, type as TaskEvent["type"])).toBe(want !== undefined);
        if (want) {
          const next = transition(task, ev, 5);
          expect(next.state, `${from} --${type}`).toBe(want);
          expect(next.input).toBe("hello");
          expect(next.updatedAt).toBe(5);
          expect(task.state).toBe(from); // rein
        } else expect(() => transition(task, ev, 5)).toThrow(TransitionError);
      }
    }
  });

  it("Retry setzt Plan, Ziele und Versuche zurück; Antwort plant neu mit der Antwort", () => {
    let t = transition({ ...base, state: "understanding" }, { type: "planInvalid", error: "x" }, 2);
    expect(t.attempts).toBe(1);
    t = transition({ ...t, state: "failed", targets: { a: "b" } }, { type: "retry" }, 3);
    expect(t).toMatchObject({ state: "received", attempts: 0 });
    expect(t.targets).toBeUndefined();
    const q = transition({ ...base, state: "question", question: { text: "Which?", options: ["A", "B"] } }, { type: "answer", option: "B" }, 4);
    expect(q.answers).toEqual(["B"]);
    expect(q.question).toBeUndefined();
  });
});

describe("Auftrag zuerst speichern", () => {
  it("ohne Modell: Record steht sofort, wartet in received mit Grund", async () => {
    const { agents, backend } = setup();
    const r = runner(backend, undefined);
    const t = await r.submit("Buy milk tomorrow");
    expect(agents.task(t.id).data.input).toBe("Buy milk tomorrow");
    await r.idle();
    expect(agents.task(t.id).data).toMatchObject({ state: "received", waiting: "no model set up" });
  });

  it("offline gespeichert → Verbindung zurück → resume plant und führt aus", async () => {
    const { agents, backend, store } = setup();
    let online = false;
    const r = runner(backend, new RulesPlannerEngine(), { online: () => online });
    const t = await r.submit("Buy milk tomorrow");
    await r.idle();
    expect(agents.task(t.id).data).toMatchObject({ state: "received", waiting: "offline" });
    online = true;
    await r.resume();
    const done = agents.task(t.id).data;
    expect(done.state).toBe("done");
    expect(done.waiting).toBeUndefined();
    const todo = store.children("b:" + INBOX_PAGE_ID).map((id) => store.blocks.get(id)!).find((b) => b.type === "todo");
    expect(plainText(todo!.text)).toBe("Buy milk tomorrow — due 2026-11-11");
    // Run des Hauptagenten zum Auftrag
    expect(agents.runs().find((x) => x.data.taskID === t.id)?.data).toMatchObject({ kind: "main", status: "done" });
  });

  it("Neustart mitten im Ausführen: läuft weiter, keine doppelte Aktion", async () => {
    const a = setup();
    const r = runner(a.backend, new RulesPlannerEngine());
    const t = await a.backend.createTask("Write a page with ideas for the trip");
    // bis „executing“ laufen, dann „abstürzen“, nachdem der Plan schon geschrieben wurde
    await a.backend.apply(t.id, { type: "understand" });
    const engine = new RulesPlannerEngine();
    const { planOnce } = await import("../src/agents/planner.js");
    const p = await planOnce(engine, "Write a page with ideas for the trip", { projects: [], today: "2026-11-10" }, new AbortController().signal);
    expect(p.parse.ok).toBe(true);
    if (!p.parse.ok) return;
    await a.backend.apply(t.id, { type: "planned", plan: p.parse.plan, decisions: { a1: "auto" }, next: "executing" });
    a.agents.execute(t.id); // Plan lief …
    // … aber der Zustand ging verloren: wieder „executing“ (Absturz zwischen den Transaktionen nachgestellt)
    const lost = a.agents.task(t.id).data;
    a.store.transact("crash", (tx) => tx.update(t.id, (b) => { (b.props as { task: TaskData }).task = { ...lost, state: "executing", applied: [], undo: [] } as TaskData; }), { undoable: false });
    // Neustart: neuer Store aus derselben Persistenz
    const b = setup(a.persistence);
    const r2 = runner(b.backend, new RulesPlannerEngine());
    await r2.resume();
    expect(b.agents.task(t.id).data.state).toBe("done");
    const pages = [...b.store.blocks.values()].filter((x) => x.type === "page" && plainText(x.text) === "Write a page with ideas for the trip");
    expect(pages).toHaveLength(1);
    // Undo nach dem Neustart entfernt die Seite trotzdem
    b.agents.undo(t.id);
    expect([...b.store.blocks.values()].filter((x) => x.type === "page" && plainText(x.text) === "Write a page with ideas for the trip")).toHaveLength(0);
    void r;
  });

  it("Neustart während des Planens: plant neu (keine Seiteneffekte), Ergebnis einmal", async () => {
    const a = setup();
    const t = await a.backend.createTask("Write a page about tea");
    await a.backend.apply(t.id, { type: "understand" });
    const b = setup(a.persistence);
    await runner(b.backend, new RulesPlannerEngine()).resume();
    expect(b.agents.task(t.id).data.state).toBe("done");
    expect([...b.store.blocks.values()].filter((x) => x.type === "page" && plainText(x.text) === "Write a page about tea")).toHaveLength(1);
  });

  it("ungültige Ausgabe → ein Retry mit Fehlerhinweis → gültig", async () => {
    const { agents, backend } = setup();
    const engine = jsonEngine("no json here", JSON.stringify(plan([{ type: "answer", text: "42", reason: "q", confidence: 0.9 }])));
    const r = runner(backend, engine);
    const t = await r.submit("What is the answer?");
    await r.idle();
    expect(agents.task(t.id).data).toMatchObject({ state: "done", answer: "42" });
    expect(engine.requests[1]!.prompt).toContain("YOUR LAST REPLY WAS INVALID: no JSON object found");
  });

  it("zweimal ungültig → als Notiz in der Inbox, nie verloren; Try again plant neu", async () => {
    const { agents, backend, store } = setup();
    const engine = jsonEngine('{"actions": []}', '{"actions": [{"type": "fly"}]}', JSON.stringify(plan([{ type: "create_page", title: "Notes", reason: "", confidence: 0.9 }])));
    const r = runner(backend, engine);
    const t = await r.submit("Some random thought");
    await r.idle();
    const d = agents.task(t.id).data;
    expect(d.state).toBe("filed");
    expect(plainText(store.blocks.get(d.noteID!)!.text)).toBe("Some random thought");
    expect(store.blocks.get(d.noteID!)!.parent).toBe("b:" + INBOX_PAGE_ID);
    await r.retry(t.id);
    expect(agents.task(t.id).data.state).toBe("done");
  });

  it("Engine-Fehler (Schlüssel, 500) → Retry → Notiz; Netzfehler → wartet", async () => {
    const { agents, backend } = setup();
    const failing = new ScriptedEngine({ script: [{ fail: "401 invalid key" }] });
    const r = runner(backend, failing);
    const t = await r.submit("hello there");
    await r.idle();
    expect(agents.task(t.id).data.state).toBe("filed");
    expect(agents.task(t.id).data.log.some((l) => l.text.includes("401 invalid key"))).toBe(true);

    const offline: ChatEngine = { label: "x", run: () => { throw new TypeError("Failed to fetch"); } };
    const r2 = runner(backend, offline);
    const t2 = await r2.submit("hello again");
    await r2.idle();
    expect(agents.task(t2.id).data).toMatchObject({ state: "received", waiting: "offline" });
  });

  it("Lease: ein zweiter Tab bearbeitet denselben Auftrag nicht gleichzeitig", async () => {
    const { agents } = setup();
    const t = agents.createTask("x");
    expect(agents.claim(t.id, "a")).toBe(true);
    expect(agents.claim(t.id, "b")).toBe(false);
    agents.release(t.id, "a");
    expect(agents.claim(t.id, "b")).toBe(true);
  });

  it("createTask mit derselben ID ist idempotent (Wiederholen nach verlorener Antwort)", () => {
    const { agents } = setup();
    const a = agents.createTask("x", { id: "11111111-1111-4111-8111-111111111111" });
    const b = agents.createTask("x", { id: "11111111-1111-4111-8111-111111111111" });
    expect(b.id).toBe(a.id);
    expect(agents.tasks()).toHaveLength(1);
  });
});

describe("Event-Strom (AG-UI-Stil)", () => {
  it("diff/applyPatch sind invers", () => {
    const a = { x: 1, y: { z: [1, 2], w: "a" }, gone: true };
    const b = { x: 2, y: { z: [1, 3], w: "a", n: null }, added: { k: 1 } };
    const ops = diff(a, b);
    expect(applyPatch(a, ops)).toEqual(b);
    expect(ops.some((o) => o.op === "remove" && o.path === "/gone")).toBe(true);
    expect(applyPatch({ a: ["x"] }, [{ op: "add", path: "/a/-", value: "y" }])).toEqual({ a: ["x", "y"] });
  });

  it("Snapshot, dann Deltas + Run-Ereignisse; Abonnent kann den Stand aus Deltas nachbauen", async () => {
    const { agents, backend } = setup();
    const stream = new TaskStream();
    const events: string[] = [];
    let mirror: unknown;
    stream.subscribe((e) => {
      events.push(e.type);
      if (e.type === "STATE_SNAPSHOT") mirror = e.snapshot;
      if (e.type === "STATE_DELTA") mirror = applyPatch(mirror, e.delta);
    });
    stream.update(agents.tasks());
    const r = runner(backend, new RulesPlannerEngine());
    const t = await r.submit("Write a page about tea");
    stream.update(agents.tasks());
    await r.idle();
    stream.update(agents.tasks());
    expect(events[0]).toBe("STATE_SNAPSHOT");
    expect(events).toContain("STATE_DELTA");
    expect(events).toContain("RUN_STARTED");
    expect(events).toContain("TOOL_CALL_END");
    expect(events).toContain("RUN_FINISHED");
    expect((mirror as Record<string, { state: string }>)[t.id]!.state).toBe("done");
    expect(stream.update(agents.tasks())).toEqual([]);
  });
});
