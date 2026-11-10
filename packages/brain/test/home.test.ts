// BSD-162/197/133: Zeitbogen (Lage aus Zeit, Kollisionen, Ring-Belegung, Zeitmarken) und Abbildung der Records auf
// die Startseite (Auftragskarte in ihren Zuständen, welcher Auftrag am Composer steht, Bogen-Buckets, Kosten,
// Begrüßungssatz, Agent-/Projekt-Detail).
import { MemoryPersistence, WorkspaceStore } from "@based/core";
import { describe, expect, it } from "vitest";
import { AgentStore, fromMs, MAIN_AGENT_ID, type AgentSnapshot, type Rec, type RunData, type ScheduleData, type TaskData, type TaskView } from "../src/index.js";
import {
  agentDetail, arcGeometry, arcPath, arcPoint, arcTicks, composerTask, costLine, frameStart, greetingSentence, homeModel, overlaps, placeSide,
  projectDetail, ringLayout, taskCard, timeToT, visibleTicks, type HomeModel,
} from "../src/home/index.js";

const NOW = new Date(2026, 10, 10, 18, 0).getTime();
const min = 60_000, hour = 60 * min;
const sw = (ms: number) => fromMs(ms);

function task(id: string, patch: Partial<TaskData> & { at?: number } = {}): TaskView {
  const at = sw(patch.at ?? NOW - 10 * min);
  const { at: _a, ...rest } = patch;
  return { id, title: rest.input ?? id, data: { v: 1, state: "received", input: id, createdAt: at, updatedAt: at, attempts: 0, log: [{ at, text: "Received" }], ...rest } };
}

function run(id: string, patch: Partial<RunData> & { startMs?: number; endMs?: number } = {}): Rec<RunData> {
  const { startMs = NOW - 20 * min, endMs, ...rest } = patch;
  const data: RunData = { v: 1, kind: "subagent", status: "running", agentID: MAIN_AGENT_ID, title: id, startedAt: sw(startMs), usage: { inputTokens: 100, outputTokens: 20, costUSD: 0 }, costEUR: 0, ...rest };
  if (endMs !== undefined) data.endedAt = sw(endMs);
  return { id, name: data.title, data, createdAt: data.startedAt, updatedAt: data.startedAt };
}

function schedule(id: string, nextMs: number, when = "daily 06:30"): Rec<ScheduleData> {
  return { id, name: id, data: { v: 1, when, prompt: id, agentID: MAIN_AGENT_ID, enabled: true, nextAt: sw(nextMs) }, createdAt: 0, updatedAt: 0 };
}

function snap(p: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return { tasks: [], runs: [], projects: [], schedules: [], main: { v: 1, kind: "main", permissions: { mode: "askEdits", rules: "" } }, spentEUR: 0, ...p };
}

const CARD = { w: 220, h: 72 }, APEX = { w: 300, h: 128 }, RING = { w: 200, h: 80 };

describe("Zeitbogen: Geometrie", () => {
  const g = arcGeometry(CARD, APEX, RING);

  it("Zeit → Lage: Enden des Zeitrahmens, now oben", () => {
    expect(timeToT(NOW, NOW, "today")).toBe(0.5);
    expect(timeToT(NOW - 6 * hour, NOW, "today")).toBe(0);
    expect(timeToT(NOW + 6 * hour, NOW, "today")).toBe(1);
    expect(timeToT(NOW - 6 * hour, NOW, "week")).toBeGreaterThan(0.4);
    const top = arcPoint(g, 0.5);
    expect(top.x).toBeCloseTo(g.cx);
    expect(top.y).toBeCloseTo(g.cy - g.r);
    expect(arcPoint(g, 0).y).toBeCloseTo(g.cy);
    expect(arcPoint(g, 0).x).toBeLessThan(arcPoint(g, 1).x);
  });

  it("Bogen passt in die Breite; innerer Ring liegt unter der Scheitel-Karte", () => {
    expect(g.cx - g.r - CARD.w / 2).toBeGreaterThanOrEqual(0);
    expect(g.cy - g.r - APEX.h / 2).toBeGreaterThanOrEqual(0);
    const apex = { x: g.cx, y: g.cy - g.r, ...APEX };
    const ringTop = { ...arcPoint(g, 0.5, g.innerR), ...RING };
    expect(overlaps(apex, ringTop)).toBe(false);
    expect(arcPath(g)).toMatch(/^M [\d.]+ [\d.]+ A /);
  });

  it("Karten einer Seite überdecken sich nie, bleiben in Zeitfolge, Überlauf wird gezählt", () => {
    const apex = { x: g.cx, y: g.cy - g.r, ...APEX };
    // zehn Karten im Abstand von 5 Minuten: drängen sich vor dem Scheitel
    const items = Array.from({ length: 10 }, (_, i) => ({ id: "d" + i, t: timeToT(NOW - (i + 1) * 5 * min, NOW, "today") }));
    const r = placeSide(items, "done", g, CARD, [apex]);
    expect(r.placed.length).toBeGreaterThan(1);
    expect(r.placed.length + r.overflow.length).toBe(10);
    for (const a of r.placed) {
      expect(overlaps(a.box, apex)).toBe(false);
      expect(a.t).toBeLessThan(0.5);
      for (const b of r.placed) if (a !== b) expect(overlaps(a.box, b.box)).toBe(false);
    }
    // Reihenfolge: neuere näher am Scheitel
    const ts = r.placed.map((p) => p.t);
    expect([...ts].sort((a, b) => b - a)).toEqual(ts);
    // außerhalb des Zeitrahmens → Überlauf
    const far = placeSide([{ id: "old", t: -0.2 }], "done", g, CARD);
    expect(far.overflow).toEqual(["old"]);
  });

  it("Geplantes liegt rechts", () => {
    const r = placeSide([{ id: "p", t: timeToT(NOW + 3 * hour, NOW, "today") }], "planned", g, CARD);
    expect(r.placed[0]!.box.x).toBeGreaterThan(g.cx);
  });

  it("innerer Ring: eine Karte oben, mehrere verteilt, zu viele → Überlauf", () => {
    const one = ringLayout(["a"], g, RING);
    expect(one.placed[0]!.box.x).toBeCloseTo(g.cx);
    const three = ringLayout(["a", "b", "c"], g, RING);
    expect(three.placed.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(three.placed[0]!.box.x).toBeLessThan(three.placed[2]!.box.x);
    const many = ringLayout(Array.from({ length: 12 }, (_, i) => "r" + i), g, RING);
    expect(many.placed.length).toBeLessThan(12);
    // Scheitel belegt: die eine Karte weicht seitlich aus statt zu verschwinden
    const top = ringLayout(["a"], g, RING, [{ ...arcPoint(g, 0.5, g.innerR), w: 40, h: 40 }]);
    expect(top.placed).toHaveLength(1);
    expect(top.placed[0]!.t).toBeLessThan(0.5);
    expect(many.placed.length + many.overflow.length).toBe(12);
    for (const a of many.placed) for (const b of many.placed) if (a !== b) expect(overlaps(a.box, b.box, 8)).toBe(false);
  });

  it("Zeitmarken: −6 h … now … +6 h; verdeckte fallen weg", () => {
    const ticks = arcTicks(g, "today");
    expect(ticks.map((t) => t.label)).toEqual(["−6 h", "−3 h", "now", "+3 h", "+6 h"]);
    expect(arcTicks(g, "week").map((t) => t.label)[0]).toBe("−3.5 d");
    const nowTick = ticks.find((t) => t.now)!;
    expect(visibleTicks(ticks, [{ x: nowTick.at.x, y: nowTick.at.y, w: 100, h: 40 }]).some((t) => t.now)).toBe(false);
  });
});

describe("Auftragskarte: Zustände", () => {
  it("received mit Wartegrund, understanding, question, proposal über Budget", () => {
    expect(taskCard(task("a", { waiting: "offline" }), []).head).toBe("Saved · waiting: offline");
    expect(taskCard(task("a", { state: "understanding" }), []).phase).toBe("understanding");
    const q = taskCard(task("q", { state: "question", question: { text: "Which project?", options: ["Publit", "Based", "New project"] } }), []);
    expect(q.phase).toBe("question");
    expect(q.question?.options).toEqual(["Publit", "Based", "New project"]);
    const p = taskCard(task("p", {
      state: "proposal", proposal: ["≈ 0.40 € is above the 0.20 € limit per task"],
      plan: { summary: "", actions: [{ id: "a1", type: "spawn_agent", title: "Research", instructions: "x", estimateEUR: 0.4, reason: "", confidence: 0.8 }] }, decisions: { a1: "propose" },
    }), []);
    expect(p.phase).toBe("proposal");
    expect(p.aboutBudget).toBe(true);
    expect(p.canConfirm).toBe(true);
    expect(p.plan[0]).toMatchObject({ needsOK: true, blocked: false });
    const blocked = taskCard(task("b", { state: "proposal", proposal: ["blocked by rule"], plan: { summary: "", actions: [{ id: "a1", type: "schedule", title: "x", when: "daily 07:30", reason: "", confidence: 1 }] }, decisions: { a1: "deny" } }), []);
    expect(blocked.canConfirm).toBe(false);
    expect(blocked.aboutBudget).toBe(false);
  });

  it("erledigt mit Undo und Seite, reine Frage, an Agenten übergeben, Fallback", () => {
    const done = taskCard(task("d", {
      state: "done", result: "Page “Tea”", undo: [{ key: "block:x", before: null, after: "1" }],
      plan: { summary: "", actions: [{ id: "a1", type: "create_page", title: "Tea", reason: "", confidence: 1 }] }, targets: { a1: "page-1" }, applied: ["a1"],
    }), []);
    expect(done).toMatchObject({ phase: "done", canUndo: true, pageID: "page-1", flight: "done" });
    const ans = taskCard(task("q", { state: "done", answer: "Lisbon", result: "Answered", plan: { summary: "", actions: [{ id: "a1", type: "answer", text: "Lisbon", reason: "", confidence: 1 }] } }), []);
    expect(ans.phase).toBe("answered");
    expect(ans.answer).toBe("Lisbon");
    const handed = taskCard(task("h", { state: "done", plan: { summary: "", actions: [{ id: "a1", type: "spawn_agent", title: "R", instructions: "x", reason: "", confidence: 1 }] } }), [run("r1", { taskID: "h" })]);
    expect(handed).toMatchObject({ phase: "handedOff", runID: "r1", flight: "ring" });
    const sched = taskCard(task("s", { state: "done", plan: { summary: "", actions: [{ id: "a1", type: "schedule", title: "Water", when: "daily 07:30", reason: "", confidence: 1 }] } }), []);
    expect(sched.flight).toBe("planned");
    expect(taskCard(task("f", { state: "filed", result: "Filed as a note in Inbox" }), []).phase).toBe("fallback");
    expect(taskCard(task("f", { state: "failed", error: "boom" }), []).error).toBe("boom");
  });

  it("Composer-Karte: neuester offener Auftrag; Erledigtes bleibt kurz (Undo), dann fliegt es; weggelegt nie", () => {
    const busy = task("new", { state: "understanding", at: NOW - min });
    expect(composerTask([task("old", { state: "done", at: NOW - hour }), busy], [], NOW, new Set()).id).toBe("new");
    const justDone = task("d", { state: "done", at: NOW - 2000 });
    const c = composerTask([justDone], [], NOW, new Set());
    expect(c.id).toBe("d");
    expect(c.until).toBe(NOW - 2000 + 8000);
    expect(composerTask([justDone], [], NOW + 9000, new Set()).id).toBeUndefined();
    expect(composerTask([busy], [], NOW, new Set(["new"])).id).toBeUndefined();
    const handed = task("h", { state: "done", at: NOW - 1000, plan: { summary: "", actions: [{ id: "a1", type: "spawn_agent", title: "R", instructions: "x", reason: "", confidence: 1 }] } });
    expect(composerTask([handed], [run("r", { taskID: "h" })], NOW, new Set()).id).toBeUndefined();
    expect(composerTask([], [], NOW, new Set())).toEqual({});
  });
});

describe("Startseite: Bogen, Kopf, Begrüßung", () => {
  it("frischer Workspace ist leer und sagt es ehrlich", () => {
    const m = homeModel({ snapshot: snap(), approvals: [], nowMs: NOW, frame: "today" });
    expect(m.empty).toBe(true);
    expect(greetingSentence(m, NOW)[0]!.text).toMatch(/Nothing is running yet/);
    expect(costLine(m, "today")).toBe("today 0.00 €");
  });

  it("Buckets: erledigt links (ohne Composer-Karte, Läufe statt ihres Auftrags), Needs you, Ring, geplant, Überlauf", () => {
    const s = snap({
      tasks: [
        task("page", { state: "done", at: NOW - hour, result: "Page", plan: { summary: "", actions: [{ id: "a1", type: "create_page", title: "Tea", reason: "", confidence: 1 }] }, targets: { a1: "p1" } }),
        task("composer", { state: "understanding", at: NOW - min }),
        task("ask", { state: "question", question: { text: "Which project?", options: ["A", "B"] } }),
        task("spawn", { state: "done", at: NOW - 30 * min }),
        task("ancient", { state: "done", at: NOW - 30 * hour }),
        task("undone", { state: "undone", at: NOW - hour }),
      ],
      runs: [
        run("main-composer", { kind: "main", taskID: "composer" }),
        run("main-other", { kind: "main", taskID: "other", startMs: NOW - 2 * min }),
        run("research", { taskID: "spawn", startMs: NOW - 25 * min, costEUR: 0.12, budgetEUR: 0.4 }),
        run("finished", { taskID: "spawn", status: "done", startMs: NOW - 3 * hour, endMs: NOW - 2 * hour, result: "Found 3", costEUR: 0.3 }),
        run("waiting", { status: "needsYou" }),
        run("chat", { kind: "chat", costEUR: 1 }),
      ],
      schedules: [schedule("brief", NOW + 2 * hour), schedule("weekly", NOW + 3 * 24 * hour)],
    });
    const m = homeModel({ snapshot: s, approvals: [{ runID: "waiting", callID: "c1", name: "create_page" }], active: ["waiting"], nowMs: NOW, frame: "today", composerID: "composer" });
    expect(m.empty).toBe(false);
    expect(m.done.map((c) => c.id)).toEqual(["task:page", "run:finished"]);
    expect(m.done[0]!.pageID).toBe("p1");
    expect(m.earlier).toBe(1);
    expect(m.running.map((r) => r.runID)).toEqual(["research", "waiting", "main-other"]);
    expect(m.running[0]!.share).toBeCloseTo(0.3);
    expect(m.needsYou.map((n) => n.kind)).toEqual(["approval", "task"]);
    expect(m.planned.map((c) => c.title)).toEqual(["brief"]);
    expect(m.later).toBe(1);
    expect(m.costEUR).toBeCloseTo(1.42);
    expect(costLine(m, "today")).toBe("today 1.42 €");
    // Woche: das Geplante in 3 Tagen ist drin
    expect(homeModel({ snapshot: s, approvals: [], nowMs: NOW, frame: "week" }).planned).toHaveLength(2);
  });

  it("verwaiste Freigabe nach Neuladen: Lauf wartet, keine Anfrage im Speicher → eigener Needs-you-Eintrag", () => {
    const m = homeModel({ snapshot: snap({ runs: [run("w", { status: "needsYou" })] }), approvals: [], active: [], nowMs: NOW, frame: "today" });
    expect(m.needsYou).toEqual([{ kind: "stale", id: "stale:w", runID: "w", title: "w" }]);
  });

  it("Abo-Anteil nur, wenn eingetragen", () => {
    const m = homeModel({ snapshot: snap({ main: { v: 1, kind: "main", permissions: { mode: "askEdits", rules: "" }, subscription: { name: "Claude", share: 0.06 } } }), approvals: [], nowMs: NOW, frame: "month" });
    expect(costLine(m, "month")).toBe("this month 0.00 € · 6% Claude");
  });

  it("Begrüßung: fertige Seite mit Marker, laufende Agenten, Needs you, nächster Termin", () => {
    const m: HomeModel = {
      done: [{ id: "task:a", kind: "task", title: "Tea", atMs: NOW - hour, state: "done", pageID: "p1" }, { id: "task:b", kind: "task", title: "B", atMs: NOW - 2 * hour, state: "done" }],
      planned: [{ id: "schedule:s", kind: "schedule", title: "Daily brief", atMs: new Date(2026, 10, 10, 23, 0).getTime(), state: "planned" }],
      running: [{ id: "run:r", runID: "r", title: "R", kind: "subagent", status: "running", startedMs: NOW, costEUR: 0 }],
      needsYou: [{ kind: "stale", id: "x", runID: "x", title: "x" }], earlier: 0, later: 0, costEUR: 0, empty: false,
    };
    const seg = greetingSentence(m, NOW, (id) => (id === "p1" ? "Green tea" : undefined));
    expect(seg.map((s) => s.text).join("")).toBe("Based finished Green tea and 1 more task; 1 agent is working; one thing needs you; next up at 23:00: Daily brief.");
    expect(seg.find((s) => s.marker)).toMatchObject({ text: "Green tea", pageID: "p1" });
    expect(greetingSentence({ ...m, done: [], planned: [], running: [], needsYou: [] }, NOW).map((s) => s.text).join("")).toMatch(/quiet day/);
  });

  it("Zeitrahmen-Beginn: heute 0:00, Montag, Monatsanfang", () => {
    expect(new Date(frameStart("today", NOW)).getHours()).toBe(0);
    expect(new Date(frameStart("week", NOW)).getDay()).toBe(1);
    expect(new Date(frameStart("month", NOW)).getDate()).toBe(1);
  });
});

describe("Detailseiten", () => {
  it("Agent-Detail: Kennzahlen, Baum, Ziel, Protokoll, Timeline mit Jetzt-Linie", () => {
    const t = task("t", { state: "done", at: NOW - 30 * min, projectID: "proj", log: [{ at: sw(NOW - 30 * min), text: "Received" }, { at: sw(NOW - 29 * min), text: "Done: Started agent" }] });
    const s = snap({
      tasks: [t],
      projects: [{ id: "proj", name: "Publit", data: { v: 1, status: "active", createdAt: 0, budgetEUR: 20 }, createdAt: 0, updatedAt: 0 }],
      runs: [
        run("main", { kind: "main", taskID: "t", status: "done", startMs: NOW - 30 * min, endMs: NOW - 29 * min }),
        run("r", { taskID: "t", projectID: "proj", startMs: NOW - 28 * min, costEUR: 0.12, budgetEUR: 0.4, model: "Sonnet" }),
        run("child", { parentID: "r", startMs: NOW - 10 * min }),
      ],
    });
    s.tasks[0]!.data.runID = "main";
    const d = agentDetail("r", s, NOW)!;
    expect(d.title).toBe("r");
    expect(d.kindLabel).toBe("Agent");
    expect(d.project?.name).toBe("Publit");
    expect(d.metrics.map((m) => m.label)).toEqual(["Runtime", "Cost", "Tokens"]);
    expect(d.metrics[0]!.value).toBe("28m 00s");
    expect(d.metrics[1]).toMatchObject({ value: "0.12 €", sub: "of 0.40 € for this run" });
    expect(d.tree.map((n) => [n.label, n.depth])).toEqual([["Main agent", 0], ["r", 1], ["child", 2]]);
    expect(d.lands).toEqual([{ label: "Project Publit", projectID: "proj" }]);
    expect(d.live.map((l) => l.verb)).toEqual(["Received", "Done", "Started"]);
    expect(d.timeline.lanes.map((l) => l.label)).toEqual(["Main agent", "r", "child"]);
    expect(d.timeline.now).toBeGreaterThan(80);
    expect(d.timeline.now).toBeLessThanOrEqual(100);
    for (const l of d.timeline.lanes) for (const b of l.bars) expect(b.left + b.width).toBeLessThanOrEqual(100.01);
    expect(d.timeline.lanes[1]!.bars[0]!.kind).toBe("running");
    expect(agentDetail("missing", s, NOW)).toBeUndefined();
  });

  it("Projekt-Detail: Kennzahlen, gelandete Aufträge, Updates, als Nächstes, Timeline 2 Wochen zurück", () => {
    const s = snap({
      projects: [{ id: "p", name: "Based", data: { v: 1, status: "active", createdAt: 0 }, createdAt: 0, updatedAt: 0 }],
      tasks: [task("note", { state: "done", projectID: "p", at: NOW - hour, plan: { summary: "", actions: [{ id: "a", type: "file_to_project", note: "idea", projectID: "p", reason: "", confidence: 1 }] }, result: "Filed into Based" })],
      runs: [run("live", { projectID: "p" }), run("old", { projectID: "p", status: "done", startMs: NOW - 2 * 24 * hour, endMs: NOW - 47 * hour, result: "ok", costEUR: 0.5 })],
      schedules: [{ ...schedule("weekly", NOW + 24 * hour, "weekly mon 09:00"), data: { ...schedule("weekly", NOW + 24 * hour).data, projectID: "p" } }],
    });
    const d = projectDetail("p", s, NOW)!;
    expect(d.metrics.map((m) => `${m.label}=${m.value}`)).toEqual(["Running=1", "Done this week=2", "Planned=1", "Budget November=0.50 €"]);
    expect(d.landed[0]).toMatchObject({ taskID: "note", target: "Filed into Based" });
    expect(d.updates.map((u) => u.id)).toEqual(["task:note", "run:old"]);
    expect(d.upNext.map((x) => x.id)).toEqual(["weekly"]);
    expect(d.timeline.lanes.map((l) => l.label)).toEqual(["Main agent", "live", "old", "weekly"]);
    expect(d.timeline.lanes[0]!.bars[0]!.dot).toBe(true);
    expect(d.timeline.now).toBeCloseTo((14 * 24 + 18) / (22 * 24) * 100, 0);
    expect(projectDetail("nope", s, NOW)).toBeUndefined();
  });

  it("passt zu echten Records aus dem AgentStore", () => {
    let t = fromMs(NOW);
    const store = new WorkspaceStore({ node: "t", persistence: new MemoryPersistence(), now: () => (t += 1) });
    const agents = new AgentStore(store, () => NOW);
    const created = agents.createTask("Buy milk tomorrow");
    agents.apply(created.id, { type: "understand" });
    const s = agents.snapshot();
    const m = homeModel({ snapshot: s, approvals: [], nowMs: NOW, frame: "today", composerID: created.id });
    expect(m.empty).toBe(false);
    expect(m.running).toHaveLength(0);
    expect(composerTask(s.tasks, s.runs, NOW, new Set()).id).toBe(created.id);
    expect(taskCard(s.tasks[0]!, s.runs).phase).toBe("understanding");
    const m2 = homeModel({ snapshot: s, approvals: [], nowMs: NOW, frame: "today" });
    expect(m2.running.map((r) => r.kind)).toEqual(["main"]);
  });
});
