// BSD-221 Teil 3a: Läufe (BSD-160-Records) und die Inbox für MCP – damit `based runs`, `based run <id>` und
// `based inbox` gegen den TS-Server funktionieren. Nur lesen; das Format folgt dem, was die CLI erwartet
// (`runSnapshot`: erste Zeile „- [Status] …“, Abschnitte „Result:“, „Sub-runs:“; „Sandbox: …“ falls vorhanden).
import { getRecord, listRecords, RUN_TYPE, toMs, type RunData, type RunStatus } from "@based/brain";
import type { WorkspaceStore } from "@based/core";
import { ToolError } from "./pages.js";

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
