// BSD-196: Plan-Schema (Zod), Validierung ungültiger Modellausgaben, Golden-Set (Eingabe → erwartete Aktionen) gegen
// die Scripted-Engine (Regeln), Sicherheitsstufen, Ausführer atomar (eine Transaktion, ein Undo-Schritt) + Undo.
import { MemoryPersistence, WorkspaceStore, plainText } from "@based/core";
import { describe, expect, it } from "vitest";
import {
  AgentStore, assess, assignTargets, executePlan, extractJSON, INBOX_PAGE_ID, localBackend, parsePlan, planOnce, Permissions, RulesPlannerEngine, TaskRunner,
  undoChanges, type ValidPlan,
} from "../src/index.js";
import { fixtureText } from "./helpers.js";

interface GoldenCase { input: string; expect: string[]; project?: string; due?: string; when?: string; unsure?: boolean }
const golden = JSON.parse(fixtureText("golden-plans.json")) as { today: string; projects: { id: string; name: string }[]; cases: GoldenCase[] };

const ok = (raw: string) => {
  const r = parsePlan(raw);
  if (!r.ok) throw new Error(r.error);
  return r.plan;
};

describe("Plan-Schema", () => {
  it("liest JSON auch aus Codeblock und Fließtext; vergibt IDs; Standardwerte", () => {
    const p = ok('Here you go:\n```json\n{"actions":[{"type":"answer","text":"Hi"},{"type":"create_task","title":"x","id":"a1"},{"type":"create_task","title":"y","id":"a1"}]}\n```');
    expect(p.actions.map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    expect(p.actions[0]).toMatchObject({ reason: "", confidence: 0.8 });
    expect(extractJSON('noise {"a": "}"} tail')).toBe('{"a": "}"}');
  });

  it.each([
    ["kein JSON", "I will create a page.", "no JSON"],
    ["kaputtes JSON", '{"actions": [', "no JSON"],
    ["leere Aktionen", '{"actions": []}', "actions"],
    ["unbekannte Aktion", '{"actions": [{"type": "delete_everything"}]}', "actions.0"],
    ["Pflichtfeld fehlt", '{"actions": [{"type": "create_page"}]}', "title"],
    ["Sicherheit außerhalb 0…1", '{"actions": [{"type": "answer", "text": "x", "confidence": 3}]}', "confidence"],
    ["Rückfrage mit einer Option", '{"actions": [{"type": "ask", "question": "?", "options": ["a"]}]}', "options"],
    ["file_to_project ohne Ziel", '{"actions": [{"type": "file_to_project", "note": "x"}]}', "projectID or projectName"],
    ["Datum falsch", '{"actions": [{"type": "create_task", "title": "x", "due": "friday"}]}', "YYYY-MM-DD"],
    ["zu viele Aktionen", JSON.stringify({ actions: Array.from({ length: 9 }, () => ({ type: "answer", text: "x" })) }), "actions"],
  ])("ungültig: %s", (_name, raw, msg) => {
    const r = parsePlan(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(msg);
  });

  it("erfundene Projekt-ID ist ungültig; unlesbare Zeit im Planer ebenso", async () => {
    expect(parsePlan('{"actions":[{"type":"create_task","title":"x","projectID":"nope"}]}', { projectIDs: new Set(["p1"]) })).toMatchObject({ ok: false });
    const engine = { label: "x", async *run() { yield { type: "text" as const, text: '{"actions":[{"type":"schedule","title":"x","when":"sometime soon"}]}' }; } };
    const a = await planOnce(engine, "x", { projects: [], today: "2026-11-10" }, new AbortController().signal);
    expect(a.parse).toMatchObject({ ok: false });
  });
});

describe("Golden-Set (Scripted-Engine)", () => {
  it(`hat ~100 Eingaben DE/EN`, () => expect(golden.cases.length).toBeGreaterThanOrEqual(100));

  it.each(golden.cases.map((c) => [c.input, c] as const))("%s", async (_input, c) => {
    const engine = new RulesPlannerEngine();
    const a = await planOnce(engine, c.input, { projects: golden.projects, today: golden.today }, new AbortController().signal);
    expect(a.parse.ok, a.parse.ok ? "" : a.parse.error).toBe(true);
    if (!a.parse.ok) return;
    const p = a.parse.plan;
    expect(p.actions.map((x) => x.type)).toEqual(c.expect);
    const first = p.actions[0]!;
    if (c.project) expect("projectID" in first ? first.projectID : undefined).toBe(c.project);
    if (c.due) expect(first.type === "create_task" ? first.due : undefined).toBe(c.due);
    if (c.when) expect(first.type === "schedule" ? first.when : undefined).toBe(c.when);
    const verdict = assess(p, { mode: "free" });
    expect(verdict.next).toBe(c.unsure || first.type === "ask" ? "question" : "executing");
  });
});

describe("Sicherheitsstufen", () => {
  const plan = (actions: object[]): ValidPlan => ok(JSON.stringify({ actions }));
  it("Modus: free führt aus, askEdits fragt bei Änderungen an Bestehendem, ask schlägt alles vor", () => {
    const create = plan([{ type: "create_page", title: "x" }]);
    const file = plan([{ type: "file_to_project", projectName: "Based", note: "x" }]);
    expect(assess(create, { mode: "free" }).next).toBe("executing");
    expect(assess(create, { mode: "askEdits" }).next).toBe("executing");
    expect(assess(file, { mode: "askEdits" }).next).toBe("proposal");
    expect(assess(file, { mode: "free" }).next).toBe("executing");
    expect(assess(create, { mode: "ask" })).toMatchObject({ next: "proposal", proposal: ["Ask mode: create page"] });
    expect(assess(plan([{ type: "answer", text: "x" }]), { mode: "ask" }).next).toBe("executing");
  });

  it("Budget: innerhalb ohne Bestätigung, darüber Vorschlag (pro Auftrag und Monatsrest)", () => {
    const spawn = (e: number) => plan([{ type: "spawn_agent", title: "R", instructions: "r", estimateEUR: e }]);
    expect(assess(spawn(0.4), { mode: "askEdits", perTaskEUR: 0.5, remainingEUR: 10 }).next).toBe("executing");
    expect(assess(spawn(1.2), { mode: "askEdits", perTaskEUR: 0.5 })).toMatchObject({ next: "proposal" });
    expect(assess(spawn(0.4), { mode: "free", perTaskEUR: 0.5, remainingEUR: 0.1 }).proposal?.[0]).toContain("left of this month's budget");
    // Erlaubt-Regel hebt die Budgetgrenze nicht auf
    const rules = (p: Permissions) => (a: Parameters<NonNullable<Parameters<typeof assess>[1]["rules"]>>[0]) => p.ruleVerdict({ tool: "based." + a.type });
    expect(assess(spawn(2), { mode: "ask", perTaskEUR: 0.5, rules: rules(Permissions.from("allow based.spawn_agent")) }).next).toBe("proposal");
    expect(assess(spawn(0.1), { mode: "ask", perTaskEUR: 0.5, rules: rules(Permissions.from("allow based.spawn_agent")) }).next).toBe("executing");
  });

  it("Regeln: deny blockiert (Vorschlag ohne die Aktion), ask fragt, unsicher → Rückfrage", () => {
    const p = plan([{ type: "create_page", title: "x" }, { type: "create_task", title: "y" }]);
    const r = assess(p, { mode: "free", rules: (a) => (a.type === "create_task" ? { effect: "deny", reason: "rule “deny based.create_task”" } : undefined) });
    expect(r.decisions).toEqual({ a1: "auto", a2: "deny" });
    expect(r.next).toBe("proposal");
    const low = assess(plan([{ type: "create_page", title: "x", confidence: 0.2 }]), { mode: "free" });
    expect(low).toMatchObject({ next: "question", question: { options: ["Yes, do it", "File as note"] } });
  });
});

function store() {
  let t = 1000;
  return new WorkspaceStore({ node: "t", persistence: new MemoryPersistence(), now: () => (t += 1) });
}

describe("Ausführer", () => {
  it("ganzer Plan = eine Transaktion = ein Undo-Schritt (⌘Z nimmt alles zurück)", () => {
    const s = store();
    const agents = new AgentStore(s);
    const proj = agents.createProject("Based");
    const p = ok(JSON.stringify({ summary: "Mixed", actions: [
      { type: "create_page", title: "Launch post", markdown: "# Intro\n\nHello **world**", projectID: proj.id },
      { type: "create_task", title: "Buy milk", due: "2026-11-11" },
      { type: "file_to_project", projectName: "Publit", note: "First users" },
      { type: "spawn_agent", title: "Research", instructions: "Look around", estimateEUR: 0.3 },
      { type: "schedule", title: "Daily brief", when: "daily 06:30" },
      { type: "answer", text: "Done." },
    ] }));
    const targets = assignTargets(p);
    const before = s.revision;
    const r = executePlan(s, { taskID: "t1", input: "x", plan: p, decisions: {}, targets, confirmed: false, nowMs: Date.UTC(2026, 10, 10) });
    expect(s.revision).toBe(before + 1);
    expect(r.applied).toHaveLength(6);
    expect(r.answer).toBe("Done.");
    expect(plainText(s.blocks.get(targets.a1!)!.text)).toBe("Launch post");
    expect(agents.projects().map((x) => x.name)).toEqual(["Based", "Publit"]);
    expect(agents.runs()[0]!.data).toMatchObject({ kind: "subagent", status: "queued", budgetEUR: 0.3, taskID: "t1" });
    expect(agents.schedules()[0]!.data.when).toBe("daily 06:30");
    s.undo();
    expect(s.blocks.get(targets.a1!)).toBeUndefined();
    expect(agents.projects().map((x) => x.name)).toEqual(["Based"]);
    expect(agents.runs()).toHaveLength(0);
    expect(agents.schedules()).toHaveLength(0);
    expect(s.blocks.get(INBOX_PAGE_ID)).toBeUndefined();
  });

  it("wirft eine Aktion, bleibt nichts halb (Rollback)", () => {
    const s = store();
    const p = ok(JSON.stringify({ actions: [{ type: "create_page", title: "A" }, { type: "create_task", title: "B", projectID: "gone" }] }));
    const targets = assignTargets(p);
    expect(() => executePlan(s, { taskID: "t", input: "x", plan: p, decisions: {}, targets, confirmed: false, nowMs: 0 })).toThrow("no longer exists");
    expect(s.blocks.get(targets.a1!)).toBeUndefined();
  });

  it("idempotent: zweimal ausführen legt nichts doppelt an", () => {
    const s = store();
    const p = ok(JSON.stringify({ actions: [{ type: "create_task", title: "Once" }] }));
    const targets = assignTargets(p);
    executePlan(s, { taskID: "t", input: "x", plan: p, decisions: {}, targets, confirmed: false, nowMs: 0 });
    executePlan(s, { taskID: "t", input: "x", plan: p, decisions: {}, targets, confirmed: false, nowMs: 0 });
    expect(s.children("b:" + INBOX_PAGE_ID)).toHaveLength(1);
  });

  it("propose läuft erst nach Bestätigung, deny nie", () => {
    const s = store();
    const p = ok(JSON.stringify({ actions: [{ type: "create_task", title: "A" }, { type: "create_task", title: "B" }, { type: "create_task", title: "C" }] }));
    const targets = assignTargets(p);
    const r = executePlan(s, { taskID: "t", input: "x", plan: p, decisions: { a1: "auto", a2: "propose", a3: "deny" }, targets, confirmed: false, nowMs: 0 });
    expect(r).toMatchObject({ applied: ["a1"], skipped: ["a2", "a3"] });
    const r2 = executePlan(s, { taskID: "t", input: "x", plan: p, decisions: { a1: "auto", a2: "propose", a3: "deny" }, targets, confirmed: true, nowMs: 0 });
    expect(r2.skipped).toEqual(["a3"]);
  });

  it("Undo an der Karte: nur Unverändertes; Seite mit neuem Inhalt bleibt", () => {
    const s = store();
    const p = ok(JSON.stringify({ actions: [{ type: "create_page", title: "Keep me" }, { type: "create_page", title: "Drop me" }] }));
    const targets = assignTargets(p);
    const r = executePlan(s, { taskID: "t", input: "x", plan: p, decisions: {}, targets, confirmed: false, nowMs: 0 });
    // jemand schreibt in „Keep me“
    s.transact("edit", (tx) => tx.put({ kind: "block", data: { id: "c1", type: "text", parent: "b:" + targets.a1!, sk: "a", text: "mine", createdAt: 1, updatedAt: 1 } }));
    const u = undoChanges(s, r.undo);
    expect(u).toEqual({ restored: 1, kept: 1 });
    expect(s.blocks.get(targets.a1!)).toBeDefined();
    expect(s.blocks.get(targets.a2!)).toBeUndefined();
  });

  it("Runner: Rückfrage-Knopf → plant mit Antwort neu → Projekt gemerkt als Korrektur-Beispiel", async () => {
    const s = store();
    const agents = new AgentStore(s);
    agents.createProject("Based");
    agents.createProject("Publit");
    agents.saveMain((d) => { d.permissions.mode = "free"; });
    const engine = new RulesPlannerEngine();
    const r = new TaskRunner({ backend: localBackend(agents), engine: () => engine, today: () => "2026-11-10" });
    const t = await r.submit("Add this to the project: swipe view for tasks");
    await r.idle();
    expect(agents.task(t.id).data).toMatchObject({ state: "question", question: { text: "Which project?", options: ["Based", "Publit", "New project"] } });
    await r.answer(t.id, "Publit");
    const d = agents.task(t.id).data;
    expect(d.state).toBe("done");
    expect(d.projectID).toBe(agents.projects().find((p) => p.name === "Publit")!.id);
    expect(agents.planningContext().examples[0]!.correction).toBe("Which project? → Publit");
    expect(engine.requests.at(-1)!.prompt).toContain('ANSWERS TO YOUR QUESTIONS: ["Publit"]');
    expect(engine.requests.at(-1)!.prompt).toContain("CORRECTIONS");
    void (await r.submit("x"));
  });

  it("Runner: unsichere Aktion → „Yes, do it“ führt denselben Plan aus; Vorschlag → bestätigen; verwerfen → Notiz", async () => {
    const s = store();
    const agents = new AgentStore(s);
    const r = new TaskRunner({ backend: localBackend(agents), engine: () => new RulesPlannerEngine(), today: () => "2026-11-10" });
    const t = await r.submit("Lemons");
    await r.idle();
    expect(agents.task(t.id).data.state).toBe("question");
    await r.answer(t.id, "Yes, do it");
    expect(agents.task(t.id).data.state).toBe("done");

    agents.saveMain((d) => { d.permissions.mode = "ask"; });
    const t2 = await r.submit("Write a page about tea");
    await r.idle();
    expect(agents.task(t2.id).data.state).toBe("proposal");
    await r.confirm(t2.id);
    expect(agents.task(t2.id).data.state).toBe("done");
    await r.undo(t2.id);
    expect(agents.task(t2.id).data.state).toBe("undone");

    const t3 = await r.submit("Write a page about coffee");
    await r.idle();
    await r.dismiss(t3.id);
    expect(agents.task(t3.id).data.state).toBe("filed");
  });
});
