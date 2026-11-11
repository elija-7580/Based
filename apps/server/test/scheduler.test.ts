// BSD-243: Zeitpläne laufen auch bei geschlossener App – der Server legt fällige Läufe als Run-Records an.
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore, fromMs, MAIN_AGENT_ID, putRecord, RUN_TYPE, SCHEDULE_TYPE, listRecords, type RunData, type ScheduleData } from "@based/brain";
import { startApp } from "./helpers.js";

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
});
