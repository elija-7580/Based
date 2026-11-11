// BSD-221 Teil 3a: Läufe (BSD-160-Records) und die Inbox für MCP – damit `based runs`, `based run <id>` und
// `based inbox` gegen den TS-Server funktionieren. Nur lesen; das Format folgt dem, was die CLI erwartet
// (`runSnapshot`: erste Zeile „- [Status] …“, Abschnitte „Result:“, „Sub-runs:“; „Sandbox: …“ falls vorhanden).
import { AgentStore, getRecord, listRecords, PROJECT_TYPE, RUN_TYPE, toMs, type ProjectData, type ProjectStatus, type RunData, type RunStatus } from "@based/brain";
import { titleOf, type WorkspaceStore } from "@based/core";
import { PAGE_URI, ToolError } from "./pages.js";

export const RUN_STATUS_LABEL: Record<RunStatus, string> = { queued: "Queued", running: "Running", needsYou: "Needs you", done: "Done", failed: "Failed", cancelled: "Cancelled" };

/** „Needs you“ / „needsyou“ / „needsYou“ → Status. */
export function parseRunStatus(s: string): RunStatus | undefined {
  const k = s.toLowerCase().replace(/\s+/g, "");
  return (Object.keys(RUN_STATUS_LABEL) as RunStatus[]).find((x) => x.toLowerCase() === k || RUN_STATUS_LABEL[x].toLowerCase().replace(/\s+/g, "") === k);
}

const iso = (swift: number | undefined) => (swift === undefined ? undefined : new Date(toMs(swift)).toISOString().replace(/\.\d{3}Z$/, "Z"));
const eur = (n: number) => `€${n.toFixed(n < 0.1 ? 3 : 2)}`;

function line(r: { id: string; name: string; data: RunData }): string {
  const d = r.data;
  const title = d.title || r.name || "Run";
  const label = RUN_STATUS_LABEL[d.status] ?? d.status;
  return `- [${label}] ${title} (id: ${r.id}) · ${d.kind} · ${iso(d.startedAt) ?? "?"}${d.costEUR > 0 ? ` · ${eur(d.costEUR)}` : ""}`;
}

export function listRunsText(store: WorkspaceStore, o: { status?: string | undefined; limit?: number | undefined } = {}): string {
  let status: RunStatus | undefined;
  if (o.status !== undefined) {
    status = parseRunStatus(o.status);
    if (!status) throw new ToolError(`status must be one of: ${Object.values(RUN_STATUS_LABEL).join(", ")}`);
  }
  const runs = listRecords<RunData>(store, RUN_TYPE)
    .filter((r) => status === undefined || r.data.status === status)
    .sort((a, b) => b.data.startedAt - a.data.startedAt);
  const n = o.limit ?? 50;
  const shown = runs.slice(0, n).map(line);
  if (shown.length === 0) return status ? `No runs with status ${RUN_STATUS_LABEL[status]}.` : "No runs yet.";
  return shown.join("\n") + (runs.length > n ? `\n… ${runs.length - n} more` : "");
}

export function getRunText(store: WorkspaceStore, id: string): string {
  const r = getRecord<RunData>(store, RUN_TYPE, id);
  if (!r) throw new ToolError(`No run with id ${id}`);
  const d = r.data;
  const out = [line(r)];
  out.push(`Kind: ${d.kind}`, `Agent: ${d.agentID}`, `Started: ${iso(d.startedAt) ?? "?"}`);
  if (d.endedAt !== undefined) out.push(`Ended: ${iso(d.endedAt)}`);
  if (d.model) out.push(`Model: ${d.model}`);
  out.push(`Usage: ${d.usage.inputTokens} in / ${d.usage.outputTokens} out tokens · ${eur(d.costEUR)}${d.budgetEUR !== undefined ? ` of ${eur(d.budgetEUR)}` : ""}`);
  if (d.parentID) out.push(`Parent run: ${d.parentID}`);
  if (d.projectID) out.push(`Project: ${d.projectID}`);
  if (d.chatID) out.push(`Chat: ${d.chatID}`);
  if (typeof d.sandbox === "string" && d.sandbox !== "") out.push(`Sandbox: ${d.sandbox}`);
  if (d.instructions) out.push("", "Instructions:", d.instructions);
  if (d.result) out.push("", "Result:", d.result);
  const subs = listRecords<RunData>(store, RUN_TYPE).filter((x) => x.data.parentID === id).sort((a, b) => a.data.startedAt - b.data.startedAt);
  if (subs.length > 0) out.push("", "Sub-runs:", ...subs.map(line));
  return out.join("\n");
}

/** Was auf den Nutzer wartet: Läufe mit „Needs you“. */
export function inboxText(store: WorkspaceStore): string {
  const waiting = listRecords<RunData>(store, RUN_TYPE).filter((r) => r.data.status === "needsYou").sort((a, b) => a.data.startedAt - b.data.startedAt);
  if (waiting.length === 0) return "Nothing needs you right now.";
  return [`${waiting.length} ${waiting.length === 1 ? "run needs" : "runs need"} you:`, ...waiting.map((r) => `${line(r)}${r.data.result ? `\n  ${r.data.result.split("\n")[0]}` : ""}`)].join("\n");
}

// MARK: Projekte (BSD-221 Teil 3c, lesend; Swift AgentTools list_projects/get_project)

const PROJECT_STATUSES = ["active", "paused", "done"] as const;

export function listProjectsText(store: WorkspaceStore, o: { status?: string | undefined; limit?: number | undefined } = {}): string {
  let ps = listRecords<ProjectData>(store, PROJECT_TYPE);
  if (o.status) {
    const st = PROJECT_STATUSES.find((x) => x === o.status!.toLowerCase());
    if (!st) throw new ToolError(`Unknown status '${o.status}'`);
    ps = ps.filter((p) => p.data.status === st);
  }
  if (ps.length === 0) return "No projects yet.";
  ps.sort((a, b) => a.name.localeCompare(b.name));
  const runs = listRecords<RunData>(store, RUN_TYPE);
  const n = o.limit ?? 50;
  const lines = ps.slice(0, n).map((p) => `- ${p.name || "Untitled"} [${p.data.status}] (id: ${p.id})${p.data.goal ? ` — ${p.data.goal}` : ""} · ${runs.filter((r) => r.data.projectID === p.id).length} runs`);
  return lines.join("\n") + (ps.length > n ? `\n… ${ps.length - n} more` : "");
}

export function getProjectText(store: WorkspaceStore, id: string): string {
  const p = getRecord<ProjectData>(store, PROJECT_TYPE, id) ?? listRecords<ProjectData>(store, PROJECT_TYPE).find((x) => x.name.toLowerCase() === id.toLowerCase());
  if (!p) throw new ToolError(`No project ${id}. Use list_projects.`);
  const out = [`# ${p.name || "Untitled"}`, `Status: ${p.data.status}`, `id: ${p.id}`];
  if (p.data.goal) out.push(`Goal: ${p.data.goal}`);
  if (p.data.budgetEUR !== undefined) out.push(`Budget per task: ${eur(p.data.budgetEUR)}`);
  if (p.data.pageID && store.blocks.has(p.data.pageID)) out.push(`Page: ${titleOf(store, p.data.pageID)} (id: ${p.data.pageID})`);
  const runs = listRecords<RunData>(store, RUN_TYPE).filter((r) => r.data.projectID === p.id).sort((a, b) => b.data.startedAt - a.data.startedAt);
  if (runs.length > 0) out.push("", "Recent runs:", ...runs.slice(0, 10).map(line));
  return out.join("\n");
}

// MARK: Projekte schreiben (BSD-221 Teil 3d; Swift AgentTools create_project/update_project_status)

function projectStatus(s: string | undefined): ProjectStatus | undefined {
  if (s === undefined || s.trim() === "") return undefined;
  const st = PROJECT_STATUSES.find((x) => x === s.trim().toLowerCase());
  if (!st) throw new ToolError(`Unknown status '${s}'`);
  return st;
}

const projectNamed = (store: WorkspaceStore, name: string) => listRecords<ProjectData>(store, PROJECT_TYPE).find((x) => x.name.toLowerCase() === name.toLowerCase());

/** Projekt anlegen (mit Projektseite); gleicher Name (ohne Groß/klein) → nichts anlegen. */
export function createProjectText(store: WorkspaceStore, o: { name: string; goal?: string | undefined; status?: string | undefined }, now: () => number = Date.now): string {
  const name = o.name.trim();
  if (!name) throw new ToolError("name is required");
  const existing = projectNamed(store, name);
  if (existing) return `A project named ${existing.name} already exists (id: ${existing.id}) — nothing created.`;
  const status = projectStatus(o.status) ?? "active";
  const agents = new AgentStore(store, now);
  const goal = o.goal?.trim();
  const p = agents.createProject(name, goal ? { goal } : {});
  if (status !== "active") agents.updateProject(p.id, { status });
  agents.projectUpdate(p.id, goal ? `Project created. Goal: ${goal}` : "Project created.");
  const page = getRecord<ProjectData>(store, PROJECT_TYPE, p.id)?.data.pageID;
  return `Created project [${name}](${PAGE_URI}${page ?? p.id}) (id: ${p.id}, ${status}).`;
}

/** Datiertes Update auf die Projektseite, optional mit neuem Status. */
export function updateProjectStatusText(store: WorkspaceStore, o: { project: string; update: string; status?: string | undefined }, now: () => number = Date.now): string {
  const p = getRecord<ProjectData>(store, PROJECT_TYPE, o.project) ?? projectNamed(store, o.project);
  if (!p) throw new ToolError(`No project ${o.project}. Use list_projects.`);
  const status = projectStatus(o.status);
  const update = o.update.trim();
  if (!update) throw new ToolError("update is required");
  const agents = new AgentStore(store, now);
  if (status) agents.updateProject(p.id, { status });
  agents.projectUpdate(p.id, update);
  return `Posted update to ${p.name}${status ? ` (status ${status})` : ""}.`;
}
