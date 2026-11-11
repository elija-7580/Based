// BSD-243: Zeitpläne laufen auch bei geschlossener App – der Server legt fällige Läufe als Run-Records an.
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore, ChatStore, fromMs, MAIN_AGENT_ID, putRecord, RUN_TYPE, SCHEDULE_TYPE, listRecords, ScriptedEngine, WorkspaceTools, type RunData, type ScheduleData } from "@based/brain";
import { serverModelFor } from "../src/agent-engine.js";
import { startApp, TOKEN } from "./helpers.js";

const apps: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });

describe("Server-Scheduler (BSD-243)", () => {
  it("fälliger Zeitplan eines eigenen Agenten → genau ein Lauf, auch nach langer Pause; deaktiviert → keiner", async () => {
    let now = Date.UTC(2026, 10, 11, 8, 0);
    const app = await startApp({ nowMillis: () => now, scheduleEvery: false });
    apps.push(app);
    const store = app.sync.store;
    const agent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sched = (id: string, enabled: boolean) => ({ v: 1, when: "every 2h", prompt: "Summarise the inbox", agentID: agent, enabled, nextAt: fromMs(now - 60_000) }) satisfies ScheduleData;
    store.transact("s", (tx) => {
      putRecord(store, tx, SCHEDULE_TYPE, "11111111-1111-4111-8111-111111111111", "Inbox digest", sched("1", true));
      putRecord(store, tx, SCHEDULE_TYPE, "22222222-2222-4222-8222-222222222222", "Paused", sched("2", false));
    });
    expect(app.scheduler.tick()).toBe(1);
    const runs = listRecords<RunData>(store, RUN_TYPE);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.data).toMatchObject({ kind: "schedule", status: "queued", agentID: agent, instructions: "Summarise the inbox", scheduleID: "11111111-1111-4111-8111-111111111111" });
    // Gleich noch einmal: nichts (Termin ist weitergeschoben)
    expect(app.scheduler.tick()).toBe(0);
    // Server war 10 h aus: höchstens ein Nachhol-Lauf
    now += 10 * 3_600_000;
    expect(app.scheduler.tick()).toBe(1);
    expect(listRecords<RunData>(store, RUN_TYPE)).toHaveLength(2);
    const s = new AgentStore(store, () => now).schedules().find((x) => x.name === "Inbox digest")!;
    expect(s.data.nextAt! * 1000 + 978_307_200_000).toBeGreaterThan(now);
  });

  it("Monatsbudget aufgebraucht → Lauf „cancelled“ mit Grund", async () => {
    const now = Date.UTC(2026, 10, 11, 8, 0);
    const app = await startApp({ nowMillis: () => now, scheduleEvery: false });
    apps.push(app);
    const store = app.sync.store;
    const agents = new AgentStore(store, () => now);
    agents.saveMain((d) => { d.monthlyBudgetEUR = 1; });
    agents.createRun({ kind: "main", status: "done", agentID: MAIN_AGENT_ID, title: "Big", costEUR: 2 });
    store.transact("s", (tx) => putRecord(store, tx, SCHEDULE_TYPE, "33333333-3333-4333-8333-333333333333", "Daily", { v: 1, when: "every 2h", prompt: "x", agentID: MAIN_AGENT_ID, enabled: true, nextAt: fromMs(now - 1000) }));
    expect(app.scheduler.tick()).toBe(1);
    const r = listRecords<RunData>(store, RUN_TYPE).find((x) => x.data.kind === "schedule")!;
    expect(r.data.status).toBe("cancelled");
    expect(r.data.result).toMatch(/monthly budget used up/);
  });

  it("Teil 2: mit Modell führt der Server den fälligen Lauf aus – Ergebnis, Transkript, Seite; Fragen werden abgelehnt", async () => {
    const now = Date.UTC(2026, 10, 11, 8, 0);
    const app = await startApp({
      nowMillis: () => now, scheduleEvery: false,
      agentEngine: (store) => ({ policy, model }) => new ScriptedEngine({ tools: new WorkspaceTools(store), policy, label: "test/" + (model ?? "default"), script: [
        { tool: "create_page", input: { title: "Morning brief", markdown: "- all quiet" } },
        { text: "Wrote the brief." },
      ] }),
    });
    apps.push(app);
    const store = app.sync.store;
    expect(app.scheduler.executes).toBe(true);
    const info = await fetch(`${app.url}/sync/v2/info`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json() as Promise<{ agents?: { runsOnServer?: boolean } }>);
    expect(info.agents?.runsOnServer).toBe(true);
    new AgentStore(store, () => now).saveMain((d) => { d.permissions = { mode: "free", rules: "" }; });
    store.transact("s", (tx) => putRecord(store, tx, SCHEDULE_TYPE, "44444444-4444-4444-8444-444444444444", "Brief", { v: 1, when: "every 2h", prompt: "Write the morning brief", agentID: MAIN_AGENT_ID, enabled: true, nextAt: fromMs(now - 1000) }));
    expect(await app.scheduler.cycle()).toBe(1);
    await waitFor(() => listRecords<RunData>(store, RUN_TYPE).some((r) => r.data.status === "done"));
    const run = listRecords<RunData>(store, RUN_TYPE).find((r) => r.data.kind === "schedule")!;
    expect(run.data).toMatchObject({ status: "done", result: "Wrote the brief." });
    expect(run.data.chatID).toBeTruthy();
    expect(new ChatStore(store).get(run.data.chatID!)).toBeTruthy();
    expect(app.pages.searchPages("Morning brief").some((p) => p.title === "Morning brief")).toBe(true);

    // „Ask before edits“: niemand kann auf dem Server erlauben → abgelehnt, Lauf endet trotzdem (kein ewiges „Needs you“)
    new AgentStore(store, () => now).saveMain((d) => { d.permissions = { mode: "askEdits", rules: "" }; });
    store.transact("s", (tx) => putRecord(store, tx, SCHEDULE_TYPE, "55555555-5555-4555-8555-555555555555", "Asked", { v: 1, when: "every 2h", prompt: "Make a page", agentID: MAIN_AGENT_ID, enabled: true, nextAt: fromMs(now - 1000) }));
    await app.scheduler.cycle();
    await waitFor(() => listRecords<RunData>(store, RUN_TYPE).filter((r) => r.data.status === "done").length === 2);
    expect(app.pages.searchPages("Morning brief").filter((p) => p.title === "Morning brief")).toHaveLength(1);
  });

  it("ohne Modell bleibt der Lauf „queued“ (die App führt ihn aus); Modellwahl", async () => {
    const now = Date.UTC(2026, 10, 11, 8, 0);
    const app = await startApp({ nowMillis: () => now, scheduleEvery: false });
    apps.push(app);
    expect(app.scheduler.executes).toBe(false);
    const info = await fetch(`${app.url}/sync/v2/info`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json() as Promise<{ agents?: { runsOnServer?: boolean } }>);
    expect(info.agents?.runsOnServer).toBe(false);
    const store = app.sync.store;
    store.transact("s", (tx) => putRecord(store, tx, SCHEDULE_TYPE, "66666666-6666-4666-8666-666666666666", "Daily", { v: 1, when: "every 2h", prompt: "x", agentID: MAIN_AGENT_ID, enabled: true, nextAt: fromMs(now - 1000) }));
    expect(await app.scheduler.cycle()).toBe(1);
    expect(listRecords<RunData>(store, RUN_TYPE)[0]!.data.status).toBe("queued");
    expect(serverModelFor(undefined, "d")).toBe("d");
    expect(serverModelFor("anthropic/claude-opus-5-5", "d")).toBe("claude-opus-5-5");
    expect(serverModelFor("openai/gpt-5", "d")).toBe("d");
    expect(serverModelFor("claude-haiku-5", "d")).toBe("claude-haiku-5");
  });
});

async function waitFor(ok: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
