// Läufe, Inbox, Hauptagent und Projekte (BSD-221 Teil 3). Die Texte folgen dem, was die CLI erwartet (`runs.ts`).
import { AgentStore } from "../agents/store.js";
import { AGENT_TYPE, defaultMainAgent, getRecord, MAIN_AGENT_ID, type AgentData } from "../agents/records.js";
import { Permissions } from "../agents/permissions.js";
import { limitSchema, needStr, obj, optStr, str, ToolError, type ToolDef } from "./base.js";
import type { ToolCtx } from "./context.js";
import { createProjectText, getProjectText, getRunText, inboxText, listProjectsText, listRunsText, resolveInboxText, updateProjectStatusText } from "./runs.js";

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
  ];
}
