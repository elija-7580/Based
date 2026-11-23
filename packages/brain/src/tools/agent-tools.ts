// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Läufe, Inbox, Hauptagent und Projekte (BSD-221 Teil 3). Die Texte folgen dem, was die CLI erwartet (`runs.ts`).
import { AgentStore } from "../agents/store.js";
import { AGENT_TYPE, defaultMainAgent, getRecord, MAIN_AGENT_ID, toMs, type AgentData, type ProjectStatus } from "../agents/records.js";
import { dueItems } from "../home/due.js";
import { listConnections } from "../mcp/connections.js";
import { Permissions } from "../agents/permissions.js";
import { limitSchema, needStr, obj, optStr, S, str, ToolError, type ToolDef } from "./base.js";
import type { ToolCtx } from "./context.js";
import { createProjectText, getProjectText, getRunText, inboxText, listProjectsText, listRunsText, resolveInboxText, updateProjectStatusText } from "./runs.js";

/** Was `parseSchedule` liest (lokale Zeit des Geräts bzw. Servers). */
const SCHEDULE_FORMS = "“daily 07:30”, “weekdays 18:00”, “weekly mon,thu 09:00”, “monthly 1 08:00”, “every 2h”, “hourly” or once “2026-12-01 09:00” (local time)";

export function agentTools(ctx: ToolCtx): ToolDef[] {
  const { store } = ctx;
  const limit = (a: Record<string, unknown>) => (typeof a.limit === "number" ? a.limit : undefined);
  return [
    {
      group: "agents", write: false,
      spec: {
        name: "list_runs",
        description: "Agent runs (chat turns, main agent, sub-agents, schedules), newest first, with status, kind, start time and cost.",
        inputSchema: obj({ status: str("Queued, Running, Needs you, Done, Failed or Cancelled"), limit: limitSchema }),
      },
      run: (a) => listRunsText(store, { status: optStr(a, "status"), limit: limit(a) }),
    },
    {
      group: "agents", write: false,
      spec: { name: "get_run", description: "One run: status, agent, times, usage and cost, instructions, result and sub-runs.", inputSchema: obj({ run_id: str("Run id") }, ["run_id"]) },
      run: (a) => getRunText(store, needStr(a, "run_id")),
    },
    {
      group: "agents", write: false,
      spec: { name: "inbox", description: "What needs the user: runs waiting for an answer or approval.", inputSchema: obj({}) },
      run: () => inboxText(store),
    },
    // BSD-221 Teil 3e: dem Hauptagenten einen Auftrag geben (wie das Eingabefeld auf der Startseite, ADR 0013). Der
    // Auftrag erscheint als Karte auf Home; ausgeführt wird er von Based (App oder Server mit Modellzugang).
    {
      group: "agents", write: true,
      spec: {
        name: "ask_main_agent",
        description: "Give Based's main agent a task in plain words (like typing it on Based's Home). It shows up as a task card there and runs with the user's permission rules; check progress with list_runs.",
        inputSchema: obj({ task: { type: "string", minLength: 1, maxLength: 4000, description: "What the main agent should do" } }, ["task"]),
      },
      run: (a) => {
        new AgentStore(store).createTask(needStr(a, "task").trim(), { source: "mcp" });
        // ohne Kennung: der Lauf entsteht erst, wenn Based den Auftrag aufnimmt (`based ask --wait` sagt das ehrlich)
        return "Sent to the main agent. It appears on Based's Home and runs there; its run shows up in list_runs once Based picks it up.";
      },
    },
    {
      group: "agents", write: true,
      spec: {
        name: "resolve_inbox",
        description: "Answer a run that waits for an approval (see inbox): allow or deny the tool call it asked for. Only works when the user allowed it with a rule `allow based.resolve_inbox` in Based.",
        inputSchema: obj({ run_id: str("Run id"), decision: str("allow | deny") }, ["run_id", "decision"]),
      },
      run: (a) => {
        const runID = needStr(a, "run_id");
        // Freigaben von außen nur mit ausdrücklicher Regel (wie in der Mac-App); ohne Regel nie.
        const main = getRecord<AgentData>(store, AGENT_TYPE, MAIN_AGENT_ID)?.data ?? defaultMainAgent();
        const v = Permissions.from(main.permissions?.rules ?? "", main.permissions?.mode ?? "askEdits").ruleVerdict({ tool: "based.resolve_inbox", argument: runID });
        if (v?.effect !== "allow") throw new ToolError("Answering approvals from outside Based needs the rule `allow based.resolve_inbox` (Settings → Agents & AI).");
        return resolveInboxText(store, { run_id: runID, decision: needStr(a, "decision") });
      },
    },
    {
      group: "agents", write: false,
      spec: { name: "list_projects", description: "Projects with status, goal and run count; filter by status (active, paused, done).", inputSchema: obj({ status: str("active, paused or done"), limit: limitSchema }) },
      run: (a) => listProjectsText(store, { status: optStr(a, "status"), limit: limit(a) }),
    },
    {
      group: "agents", write: false,
      spec: { name: "get_project", description: "One project: status, goal, budget, project page and recent runs (by id or name).", inputSchema: obj({ project_id: str("Project id or name") }, ["project_id"]) },
      run: (a) => getProjectText(store, needStr(a, "project_id")),
    },
    // BSD-221 Teil 3d: Projekte schreiben
    {
      group: "agents", write: true,
      spec: {
        name: "create_project",
        description: "Create a project (with an overview page for dated updates). Use it when the user starts a new goal that will have several chats, runs or pages; check list_projects first so you don't create a duplicate.",
        inputSchema: obj({ name: str("Short project name"), goal: str("One sentence: what done looks like"), status: str("Optional: Active (default) | Paused | Done") }, ["name"]),
      },
      run: (a) => createProjectText(store, { name: needStr(a, "name"), goal: optStr(a, "goal"), status: optStr(a, "status") }),
    },
    {
      group: "agents", write: true,
      spec: {
        name: "update_project_status",
        description: "Post a short dated update to a project's page, optionally changing its status. Use it after finishing something worth knowing in a project.",
        inputSchema: obj({ project: str("Project id or name"), update: str("What happened, one or two sentences"), status: str("Optional: Active | Paused | Done") }, ["project", "update"]),
      },
      run: (a) => updateProjectStatusText(store, { project: needStr(a, "project"), update: needStr(a, "update"), status: optStr(a, "status") }),
    },
    {
      group: "agents", write: true,
      spec: {
        name: "update_project",
        description: "Change a project: name, goal, status, monthly budget in € (0 clears).",
        inputSchema: obj({ project: str("Project id or name"), name: S, goal: S, status: str("active | paused | done"), budget_eur: { type: "number", minimum: 0 } }, ["project"]),
      },
      run: (a) => {
        const agents = new AgentStore(store);
        const ref = needStr(a, "project");
        const p = agents.projects().find((x) => x.id === ref) ?? agents.projects().find((x) => x.name.toLowerCase() === ref.toLowerCase());
        if (!p) throw new ToolError(`No project “${ref}” (list_projects shows them).`);
        const status = optStr(a, "status")?.toLowerCase();
        if (status !== undefined && !["active", "paused", "done"].includes(status)) throw new ToolError("status must be active, paused or done");
        const patch: Parameters<AgentStore["updateProject"]>[1] = {};
        if (optStr(a, "name")) patch.name = optStr(a, "name")!;
        if (optStr(a, "goal") !== undefined) patch.goal = optStr(a, "goal")!;
        if (status) patch.status = status as ProjectStatus;
        if (typeof a.budget_eur === "number") patch.budgetEUR = a.budget_eur > 0 ? a.budget_eur : null;
        if (Object.keys(patch).length === 0) return "Nothing to change.";
        agents.updateProject(p.id, patch);
        return `Updated project “${patch.name ?? p.name}”: ${Object.keys(patch).join(", ")}`;
      },
    },
    {
      group: "agents", write: false,
      spec: { name: "list_schedules", description: "Scheduled agent runs: when, what, next run, on or off.", inputSchema: obj({}) },
      run: () => {
        const all = new AgentStore(store).schedules();
        if (all.length === 0) return "No schedules.";
        return all.map((s) => `- ${s.data.when} — ${s.data.prompt.split("\n")[0]!.slice(0, 120)} (id: ${s.id}) · ${s.data.enabled ? "on" : "off"}${s.data.nextAt !== undefined ? ` · next ${new Date(toMs(s.data.nextAt)).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}`).join("\n");
      },
    },
    // BSD-591: Zeitplan direkt anlegen (vorher nur über ask_main_agent). Läuft als Hauptagent mit dessen Regeln und Budget.
    {
      group: "agents", write: true,
      spec: {
        name: "create_schedule",
        description: "Schedule a recurring or one-time run of Based's main agent. It runs with the main agent's permission rules and budget; list_schedules shows it, update_schedule changes or deletes it.",
        inputSchema: obj({
          name: str("Short name shown in Based"),
          when: str(SCHEDULE_FORMS),
          prompt: { type: "string", minLength: 1, maxLength: 4000, description: "What the agent should do each time" },
          project: str("Project id or name (optional)"),
          enabled: { type: "boolean", description: "Start turned on (default true)" },
        }, ["when", "prompt"]),
      },
      run: (a) => {
        const agents = new AgentStore(store);
        const prompt = needStr(a, "prompt").trim();
        const when = needStr(a, "when").trim();
        const ref = optStr(a, "project");
        let projectID: string | undefined;
        if (ref) {
          const p = agents.projects().find((x) => x.id === ref) ?? agents.projects().find((x) => x.name.toLowerCase() === ref.toLowerCase());
          if (!p) throw new ToolError(`No project “${ref}” (list_projects shows them).`);
          projectID = p.id;
        }
        const name = optStr(a, "name")?.trim() || prompt.split("\n")[0]!.slice(0, 80);
        let s: ReturnType<AgentStore["createSchedule"]>;
        try {
          s = agents.createSchedule(name, when, prompt, { ...(projectID ? { projectID } : {}), ...(typeof a.enabled === "boolean" ? { enabled: a.enabled } : {}) });
        } catch (e) { throw new ToolError(`${e instanceof Error ? e.message : String(e)} Use ${SCHEDULE_FORMS}.`); }
        const next = s.data.nextAt !== undefined ? ` · next ${new Date(toMs(s.data.nextAt)).toISOString().slice(0, 16).replace("T", " ")} UTC` : " · no future run";
        return `Scheduled “${s.name}” · ${s.data.when} (id: ${s.id}) · ${s.data.enabled ? "on" : "off"}${next}`;
      },
    },
    {
      group: "agents", write: true, destructive: true,
      spec: {
        name: "update_schedule",
        description: "Change a schedule: turn it on or off, change when it runs or what it does, or delete it. New schedules: create_schedule.",
        inputSchema: obj({ id: str("Schedule id"), enabled: { type: "boolean" }, when: str(SCHEDULE_FORMS), prompt: S, delete: { type: "boolean" } }, ["id"]),
      },
      run: (a) => {
        const agents = new AgentStore(store);
        const id = needStr(a, "id");
        if (!agents.schedules().some((s) => s.id === id)) throw new ToolError(`No schedule ${id} (list_schedules shows them).`);
        if (a.delete === true) { agents.deleteSchedule(id); return "Deleted the schedule."; }
        const patch: { enabled?: boolean; when?: string; prompt?: string } = {};
        if (typeof a.enabled === "boolean") patch.enabled = a.enabled;
        if (optStr(a, "when")) patch.when = optStr(a, "when")!;
        if (optStr(a, "prompt")) patch.prompt = optStr(a, "prompt")!;
        if (Object.keys(patch).length === 0) return "Nothing to change.";
        try { agents.updateSchedule(id, patch); } catch (e) { throw new ToolError(e instanceof Error ? e.message : String(e)); }
        return `Updated the schedule: ${Object.keys(patch).join(", ")}`;
      },
    },
    {
      group: "agents", write: false,
      spec: {
        name: "due",
        description: "What is due across all databases with a date and a status: rows between two dates (default: overdue up to 7 days ahead).",
        inputSchema: obj({ from: str("YYYY-MM-DD"), to: str("YYYY-MM-DD"), limit: limitSchema }),
      },
      run: (a) => {
        const at = (k: string, fallback: number) => {
          const v = optStr(a, k);
          if (v === undefined) return fallback;
          const t = Date.parse(v);
          if (Number.isNaN(t)) throw new ToolError(`${k} must be a date like 2026-11-20`);
          return t;
        };
        const now = Date.now();
        const items = dueItems(store, at("from", now - 365 * 86_400_000), at("to", now + 7 * 86_400_000) + 86_399_999, limit(a) ?? 50);
        if (items.length === 0) return "Nothing due in that range.";
        return items.map((d) => `- ${new Date(d.dueMs).toISOString().slice(0, d.allDay ? 10 : 16).replace("T", " ")}${d.dueMs < now ? " (overdue)" : ""} — ${d.title || "Untitled"} (id: ${d.rowID}) in “${d.databaseTitle}”`).join("\n");
      },
    },
    {
      group: "agents", write: false,
      spec: { name: "list_connections", description: "MCP connections set up in Based: name, transport, on or off. Secrets are never shown.", inputSchema: obj({}) },
      run: () => {
        const all = listConnections(store);
        if (all.length === 0) return "No connections.";
        return all.map((c) => `- ${c.name || "Untitled"} (id: ${c.id}) — ${c.data.transport}${c.data.url ? ` ${c.data.url.replace(/[?#].*$/, "")}` : c.data.command ? ` ${c.data.command}` : ""} · ${c.data.enabled ? "on" : "off"}`).join("\n");
      },
    },
  ];
}
