// BSD-160: Berechtigungen (Modus + Regeln, Schichten), Budget-Grenzen, Zeitpläne ohne Doppel-Lauf, Unteragenten als
// Runs (Transkript, Kosten in €, Budget-Stopp, Freigabe „Needs you“), Projekt-Updates.
import { MemoryPersistence, WorkspaceStore, plainText } from "@based/core";
import { describe, expect, it } from "vitest";
import {
  AgentRunner, AgentStore, budgetLevel, ChatStore, executeTool, formatEUR, fromMs, globMatch, MAIN_AGENT_ID, mayContinue, nextFire, parseLayer, parseSchedule,
  Permissions, ScriptedEngine, spentThisMonth, WorkspaceTools, type AgentRunBackend, type ChatEvent, type RunData,
} from "../src/index.js";

function setup(nowMs = Date.UTC(2026, 10, 10, 12)) {
  let t = fromMs(nowMs);
  const store = new WorkspaceStore({ node: "t", persistence: new MemoryPersistence(), now: () => (t += 1) });
  let clock = nowMs;
  const agents = new AgentStore(store, () => clock);
  return { store, agents, setNow: (ms: number) => { clock = ms; }, now: () => clock };
}

function backend(agents: AgentStore, store: WorkspaceStore): AgentRunBackend {
  const chats = new ChatStore(store);
  const a = <T>(f: () => T) => Promise.resolve().then(f);
  return {
    runs: () => a(() => agents.runs()), claimRun: (id, o) => a(() => agents.claimRun(id, o)), updateRun: (id, p) => a(() => agents.updateRun(id, p)),
    createRun: (d) => a(() => agents.createRun(d)), main: () => a(() => agents.main()), projects: () => a(() => agents.projects()), schedules: () => a(() => agents.schedules()),
    claimSchedule: (id, n) => a(() => agents.claimSchedule(id, n)), chatCreate: (title) => a(() => chats.create({ title })), chatSave: (id, b, e) => a(() => chats.save(id, b, e)),
    projectUpdate: (id, md) => a(() => agents.projectUpdate(id, md)),
    chatLoad: (id) => a(() => chats.load(id)),
  };
}

describe("Berechtigungen", () => {
  it("Regeln lesen: Zeilen, Aufzählungen, Kommentare, mode-Zeile, JSON; Fehler sichtbar", () => {
    const l = parseLayer("# mine\n- allow based.create_page\nask `based.spawn_agent`\ndeny based.file_to_project(Publit)\nmode free\nwhatever");
    expect(l.mode).toBe("free");
    expect(l.rules).toEqual([{ effect: "allow", tool: "based.create_page" }, { effect: "ask", tool: "based.spawn_agent" }, { effect: "deny", tool: "based.file_to_project", pattern: "Publit" }]);
    expect(l.errors).toEqual(["whatever"]);
    expect(parseLayer('{"permissions": {"allow": ["based.*"], "deny": ["based.schedule"]}}').rules).toHaveLength(2);
    expect(globMatch("based.*", "BASED.create_page")).toBe(true);
  });

  it("Vorrang deny > ask > allow > Modus; Projekt-Schicht ergänzt, ihr Modus gewinnt", () => {
    const p = Permissions.from("allow based.*\nask based.spawn_agent\ndeny based.spawn_agent(*secret*)", "ask");
    expect(p.decide({ tool: "based.create_page" }, true).effect).toBe("allow");
    expect(p.decide({ tool: "based.spawn_agent", argument: "research" }, true).effect).toBe("ask");
    expect(p.decide({ tool: "based.spawn_agent", argument: "my secret plan" }, true).effect).toBe("deny");
    const bare = Permissions.from("", "askEdits");
    expect(bare.decide({ tool: "based.search" }, false).effect).toBe("allow");
    expect(bare.decide({ tool: "based.create_page" }, true).effect).toBe("ask");
    const layered = bare.layered("mode free\ndeny based.replace_page_content");
    expect(layered.mode).toBe("free");
    expect(layered.decide({ tool: "based.create_page" }, true).effect).toBe("allow");
    expect(layered.decide({ tool: "based.replace_page_content" }, true).effect).toBe("deny");
  });

  it("Werkzeuge im Chat: deny-Regel blockiert, allow-Regel spart die Frage", async () => {
    const { store } = setup();
    const tools = new WorkspaceTools(store);
    const events: ChatEvent[] = [];
    const call = { id: "c", name: "create_page", arguments: { title: "x" } };
    const denied = await executeTool(tools, call, { mode: "free", rules: () => "deny" }, new AbortController().signal, (e) => events.push(e));
    expect(denied).toMatchObject({ isError: true, text: "A permission rule blocks this action." });
    const allowed = await executeTool(tools, call, { mode: "ask", rules: () => "allow" }, new AbortController().signal, (e) => events.push(e));
    expect(allowed.isError).toBe(false);
    expect(events).toHaveLength(0);
  });
});

describe("Budget", () => {
  const run = (startedMs: number, costEUR: number, agentID = MAIN_AGENT_ID) => ({ id: String(Math.random()), name: "r", createdAt: 0, updatedAt: 0, data: { v: 1, kind: "subagent", status: "done", agentID, title: "r", startedAt: fromMs(startedMs), usage: { inputTokens: 0, outputTokens: 0, costUSD: 0 }, costEUR } as RunData });
  it("Monat zählt, andere Monate/Agenten nicht; Stufen 80 %/100 %", () => {
    const now = new Date(2026, 10, 20).getTime();
    const runs = [run(new Date(2026, 10, 2).getTime(), 1.5), run(new Date(2026, 10, 19).getTime(), 2.5), run(new Date(2026, 9, 30).getTime(), 9), run(now, 4, "other")];
    expect(spentThisMonth(runs, MAIN_AGENT_ID, now)).toBe(4);
    expect(budgetLevel(4, undefined)).toBe("ok");
    expect(budgetLevel(3.9, 5)).toBe("ok");
    expect(budgetLevel(4, 5)).toBe("warning");
    expect(budgetLevel(5, 5)).toBe("exhausted");
    expect(formatEUR(0.0031)).toBe("0.0031 €");
  });

  it("Lauf-Obergrenze und Monatsbudget stoppen einen Unteragenten", () => {
    const r = run(0, 0.6).data;
    expect(mayContinue({ ...r, budgetEUR: 0.5 }, 0, undefined)).toMatchObject({ ok: false });
    expect(mayContinue(r, 4.5, { v: 1, kind: "main", permissions: { mode: "ask", rules: "" }, monthlyBudgetEUR: 5 })).toMatchObject({ ok: false });
    expect(mayContinue(r, 1, { v: 1, kind: "main", permissions: { mode: "ask", rules: "" }, monthlyBudgetEUR: 5 })).toEqual({ ok: true });
  });

  it("Run-Kosten in € aus USD mit dem Kurs des Agenten; Abo-Anteil nur als Feld", () => {
    const { agents } = setup();
    agents.saveMain((d) => { d.eurPerUSD = 0.5; });
    const r = agents.createRun({ kind: "chat", status: "done", agentID: MAIN_AGENT_ID, title: "chat", usage: { inputTokens: 10, outputTokens: 5, costUSD: 0.2 } });
    expect(r.data.costEUR).toBeCloseTo(0.1);
    const u = agents.updateRun(r.id, { addUsage: { inputTokens: 1, outputTokens: 1, costUSD: 1 }, subscriptionShare: 0.06 });
    expect(u!.data.costEUR).toBeCloseTo(0.6);
    expect(u!.data.subscriptionShare).toBe(0.06);
    expect(agents.snapshot().spentEUR).toBeCloseTo(0.6);
  });
});

describe("Zeitpläne", () => {
  it("lesen und nächster Termin", () => {
    const base = new Date(2026, 10, 10, 12, 0).getTime(); // Di
    const at = (s: string) => new Date(nextFire(parseSchedule(s)!, base)!);
    expect(at("daily 06:30").getDate()).toBe(11);
    expect(at("daily 13:00").getHours()).toBe(13);
    expect(at("weekly mon 09:00").getDay()).toBe(1);
    expect(at("weekdays 09:00").getDate()).toBe(11);
    expect(nextFire(parseSchedule("every 2h")!, base)).toBe(base + 7_200_000);
    expect(at("monthly 1 08:00").getMonth()).toBe(11);
    expect(nextFire(parseSchedule("2026-11-09 10:00")!, base)).toBeUndefined();
    expect(parseSchedule("every 1m")).toBeUndefined();
    expect(parseSchedule("sometime")).toBeUndefined();
    expect(parseSchedule("2026-02-30")).toBeUndefined();
  });

  it("fälliger Zeitplan läuft genau einmal (zwei Runner), Budget erschöpft → übersprungen", async () => {
    const { agents, store, setNow } = setup(new Date(2026, 10, 10, 6, 0).getTime());
    const p = agents;
    store.transact("s", (tx) => {
      void tx;
    });
    // Zeitplan über den Ausführer anlegen
    const { executePlan, assignTargets, parsePlan } = await import("../src/index.js");
    const plan = parsePlan('{"actions":[{"type":"schedule","title":"Daily brief","when":"daily 06:30","prompt":"Write the brief"}]}');
    if (!plan.ok) throw new Error(plan.error);
    executePlan(store, { taskID: "t", input: "x", plan: plan.plan, decisions: {}, targets: assignTargets(plan.plan), confirmed: false, nowMs: new Date(2026, 10, 10, 6, 0).getTime() });
    setNow(new Date(2026, 10, 10, 6, 31).getTime());
    const engine = () => new ScriptedEngine({ script: [{ text: "Brief written." }] });
    const a = new AgentRunner({ backend: backend(p, store), engine, now: () => new Date(2026, 10, 10, 6, 31).getTime(), owner: "a" });
    const b = new AgentRunner({ backend: backend(p, store), engine, now: () => new Date(2026, 10, 10, 6, 31).getTime(), owner: "b" });
    expect(await Promise.all([a.fireSchedules(), b.fireSchedules()])).toEqual([1, 0]);
    expect(p.runs().filter((r) => r.data.kind === "schedule")).toHaveLength(1);
    expect(new Date(p.schedules()[0]!.data.nextAt! * 1000 + 978_307_200_000).getDate()).toBe(11);

    p.saveMain((d) => { d.monthlyBudgetEUR = 0; });
    const later = new Date(2026, 10, 11, 6, 31).getTime();
    const c = new AgentRunner({ backend: backend(p, store), engine, now: () => later });
    expect(await c.fireSchedules()).toBe(1);
    expect(p.runs().find((r) => r.data.status === "cancelled")?.data.result).toContain("budget used up");
  });
});

describe("Unteragenten", () => {
  it("wartender Lauf → läuft mit Werkzeugen, Transkript als Chat, Kosten in €, Projekt-Update", async () => {
    const { agents, store } = setup();
    const proj = agents.createProject("Based");
    agents.saveMain((d) => { d.permissions.mode = "free"; d.eurPerUSD = 1; });
    const run = agents.createRun({ kind: "subagent", status: "queued", agentID: MAIN_AGENT_ID, title: "Research", instructions: "Write findings", projectID: proj.id });
    const tools = new WorkspaceTools(store);
    const seenProjects: (string | undefined)[] = [];
    const runner = new AgentRunner({
      backend: backend(agents, store),
      engine: ({ policy, project }) => { seenProjects.push(project?.status); return new ScriptedEngine({ tools, policy, script: [
        { tool: "create_page", input: { title: "Findings", markdown: "- one" } },
        { event: { type: "usage", inputTokens: 100, outputTokens: 50, costUSD: 0.05 } },
        { text: "Created Findings." },
      ] }); },
    });
    await runner.start(run.id);
    // BSD-250: die Engine bekommt das Projekt (für dessen Connection-Scope).
    expect(seenProjects).toEqual(["active"]);
    const r = agents.run(run.id)!.data;
    expect(r).toMatchObject({ status: "done", result: "Created Findings.", costEUR: 0.05 });
    expect(new ChatStore(store).load(r.chatID!).some((e) => e.type === "toolResult")).toBe(true);
    expect([...store.blocks.values()].some((b) => b.type === "page" && plainText(b.text) === "Findings")).toBe(true);
    const page = agents.projects()[0]!.data.pageID!;
    expect(store.children("b:" + page).map((id) => plainText(store.blocks.get(id)!.text)).join(" ")).toContain("Created Findings.");
  });

  it("über Lauf-Budget → gestoppt; Ask before edits → Needs you, bis jemand erlaubt", async () => {
    const { agents, store } = setup();
    agents.saveMain((d) => { d.eurPerUSD = 1; });
    const tools = new WorkspaceTools(store);
    const pricey = agents.createRun({ kind: "subagent", status: "queued", agentID: MAIN_AGENT_ID, title: "Pricey", instructions: "x", budgetEUR: 0.1 });
    const runner = new AgentRunner({
      backend: backend(agents, store),
      engine: ({ policy }) => new ScriptedEngine({ tools, policy, script: [{ event: { type: "usage", inputTokens: 1, outputTokens: 1, costUSD: 0.5 } }, { wait: 5 }, { text: "never" }] }),
    });
    await runner.start(pricey.id);
    expect(agents.run(pricey.id)!.data).toMatchObject({ status: "failed", result: "Stopped: run budget of 0.10 € reached" });

    const asking = agents.createRun({ kind: "subagent", status: "queued", agentID: MAIN_AGENT_ID, title: "Asks", instructions: "x" });
    let changed = 0;
    const r2 = new AgentRunner({
      backend: backend(agents, store), onChange: () => { changed += 1; },
      engine: ({ policy }) => new ScriptedEngine({ tools, policy, script: [{ tool: "create_page", input: { title: "Asked" } }, { text: "ok" }] }),
    });
    const p = r2.start(asking.id);
    for (let i = 0; i < 50 && r2.pendingApprovals.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    expect(r2.pendingApprovals[0]!.call.name).toBe("create_page");
    expect(agents.run(asking.id)!.data.status).toBe("needsYou");
    r2.approve(asking.id, r2.pendingApprovals[0]!.call.id, true);
    await p;
    expect(agents.run(asking.id)!.data.status).toBe("done");
    expect(changed).toBeGreaterThan(0);
  });

  it("Freigabe übersteht Neuladen (BSD-168): Frage am Run, nach Erlauben setzt der Lauf mit Transkript fort", async () => {
    const { agents, store } = setup();
    const tools = new WorkspaceTools(store);
    const asking = agents.createRun({ kind: "subagent", status: "queued", agentID: MAIN_AGENT_ID, title: "Asks", instructions: "Make the page" });
    const before = new AgentRunner({
      backend: backend(agents, store), owner: "tab-1",
      engine: ({ policy }) => new ScriptedEngine({ tools, policy, script: [{ tool: "create_page", input: { title: "Asked" } }, { text: "first" }] }),
    });
    void before.start(asking.id);
    for (let i = 0; i < 100 && !agents.run(asking.id)!.data.approval; i++) await new Promise((r) => setTimeout(r, 2));
    expect(agents.run(asking.id)!.data).toMatchObject({ status: "needsYou", approval: { name: "create_page", arguments: { title: "Asked" } } });

    // „Neu geladen“: neuer Runner im selben Tab, der alte Prozess ist weg.
    const after = new AgentRunner({
      backend: backend(agents, store), owner: "tab-1",
      engine: ({ policy }) => new ScriptedEngine({ tools, policy, script: [{ tool: "create_page", input: { title: "Asked" } }, { text: "Created Asked." }] }),
    });
    await after.tick();
    expect(agents.run(asking.id)!.data.status).toBe("needsYou");
    expect(after.pendingApprovals.map((a) => a.call.name)).toEqual(["create_page"]);
    after.approve(asking.id, after.pendingApprovals[0]!.call.id, true);
    for (let i = 0; i < 100 && agents.run(asking.id)!.data.status !== "done"; i++) await new Promise((r) => setTimeout(r, 2));
    const r = agents.run(asking.id)!.data;
    expect(r).toMatchObject({ status: "done", result: "Created Asked." });
    expect(r.approval).toBeUndefined();
    expect(r.resume).toBeUndefined();
    expect([...store.blocks.values()].filter((b) => b.type === "page" && plainText(b.text) === "Asked")).toHaveLength(1);
    const transcript = new ChatStore(store).load(r.chatID!);
    const resumedWith = transcript.filter((e) => e.type === "userMessage").map((e) => (e as { text: string }).text).join(" | ");
    expect(resumedWith).toContain("Make the page");
    expect(resumedWith).toContain("approved create_page");
    expect(after.pendingApprovals).toEqual([]);
  });

  it("gespeicherte Freigabe ablehnen beendet den Lauf mit Hinweis; lebender Lauf in anderem Tab bleibt dessen Sache", async () => {
    const { agents, store, now } = setup();
    const tools = new WorkspaceTools(store);
    const asking = agents.createRun({ kind: "subagent", status: "queued", agentID: MAIN_AGENT_ID, title: "Asks", instructions: "x" });
    const live = new AgentRunner({
      backend: backend(agents, store), owner: "tab-1", now,
      engine: ({ policy }) => new ScriptedEngine({ tools, policy, script: [{ tool: "create_page", input: { title: "No" } }, { text: "x" }] }),
    });
    void live.start(asking.id);
    for (let i = 0; i < 100 && !agents.run(asking.id)!.data.approval; i++) await new Promise((r) => setTimeout(r, 2));
    const other = new AgentRunner({ backend: backend(agents, store), owner: "tab-2", now, engine: () => undefined });
    await other.tick();
    expect(other.pendingApprovals).toEqual([]); // Lease von tab-1 läuft noch
    const again = new AgentRunner({ backend: backend(agents, store), owner: "tab-1", now, engine: () => undefined });
    await again.tick();
    again.approve(asking.id, again.pendingApprovals[0]!.call.id, false);
    for (let i = 0; i < 100 && agents.run(asking.id)!.data.status !== "failed"; i++) await new Promise((r) => setTimeout(r, 2));
    expect(agents.run(asking.id)!.data).toMatchObject({ status: "failed", result: "Stopped: you declined create_page." });
  });

  it("unterbrochener Lauf (App zu) wird als fehlgeschlagen gemeldet, nicht wiederholt", async () => {
    const { agents, store } = setup();
    const r = agents.createRun({ kind: "subagent", status: "queued", agentID: MAIN_AGENT_ID, title: "A", instructions: "x" });
    expect(agents.claimRun(r.id, "old-tab")).toBe(true);
    const runner = new AgentRunner({ backend: backend(agents, store), owner: "old-tab", engine: () => new ScriptedEngine({ script: [{ text: "again" }] }) });
    await runner.tick();
    expect(agents.run(r.id)!.data).toMatchObject({ status: "failed", result: "Interrupted — Based was closed while this ran." });
  });

  it("gelöschter/abgebrochener Lauf (Undo) wird nicht gestartet; tick startet wartende", async () => {
    const { agents, store } = setup();
    agents.saveMain((d) => { d.permissions.mode = "free"; });
    const r1 = agents.createRun({ kind: "subagent", status: "queued", agentID: MAIN_AGENT_ID, title: "A", instructions: "x" });
    agents.updateRun(r1.id, { status: "cancelled" });
    const r2 = agents.createRun({ kind: "subagent", status: "queued", agentID: MAIN_AGENT_ID, title: "B", instructions: "x" });
    const runner = new AgentRunner({ backend: backend(agents, store), engine: () => new ScriptedEngine({ script: [{ text: "ok" }] }) });
    await runner.tick();
    for (let i = 0; i < 50 && agents.run(r2.id)!.data.status !== "done"; i++) await new Promise((r) => setTimeout(r, 2));
    expect(agents.run(r1.id)!.data.status).toBe("cancelled");
    expect(agents.run(r2.id)!.data.status).toBe("done");
  });
});
