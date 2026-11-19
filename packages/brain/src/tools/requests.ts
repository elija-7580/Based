// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Rückfrage in der Inbox (docs/agent-parity-matrix.md, Entscheidung 3): Was ein Agent nie allein darf – endgültig
// löschen, Papierkorb leeren –, läuft nicht, sondern wird als Lauf „Needs you“ abgelegt. Der Aufruf (Name,
// Argumente, Urheber) steht im Record; ausgeführt wird er erst, wenn ein Mensch in Based „Allow“ klickt.
// Von außen (resolve_inbox) lässt sich so eine Rückfrage nicht beantworten, auch nicht mit einer allow-Regel.
import type { Author, JSONValue, WorkspaceStore } from "@based/core";
import { AgentStore } from "../agents/store.js";
import { AGENT_TYPE, defaultMainAgent, getRecord, MAIN_AGENT_ID, RUN_TYPE } from "../agents/records.js";
import type { AgentData, RunData } from "../agents/records.js";
import { ToolError } from "./base.js";

export const REQUEST_KIND = "request" as const;

/**
 * Hat der Mensch Agenten „Work freely“ gegeben? Nur dann laufen Dinge ohne Rückfrage, die sonst eine Frage in der
 * Inbox sind (teilen, Skills ändern). Endgültiges Löschen fragt immer.
 */
export function agentsWorkFreely(store: WorkspaceStore): boolean {
  return (getRecord<AgentData>(store, AGENT_TYPE, MAIN_AGENT_ID)?.data ?? defaultMainAgent()).permissions?.mode === "free";
}

/** Rückfrage anlegen. Gibt die Antwort an den Agenten zurück. */
export function createToolRequest(store: WorkspaceStore, o: { name: string; input: JSONValue; actor: Author; title: string }): string {
  const agents = new AgentStore(store);
  const same = agents.runs().find((r) => r.data.kind === REQUEST_KIND && r.data.status === "needsYou" && r.data.approval?.name === o.name && JSON.stringify(r.data.approval.arguments) === JSON.stringify(o.input));
  if (same) return `Already asked (request ${same.id}); the user hasn't answered yet. Nothing was changed.`;
  const run = agents.createRun({
    kind: REQUEST_KIND, status: "needsYou", agentID: o.actor.name, title: o.title,
    approval: { callID: "request", name: o.name, arguments: o.input },
    requestedBy: { kind: o.actor.kind, name: o.actor.name, ...(o.actor.model ? { model: o.actor.model } : {}) },
  } as unknown as Parameters<AgentStore["createRun"]>[0]);
  return `Asked the user in Based's inbox (request ${run.id}): “${o.title}”. Nothing was changed yet; it runs when the user allows it there. Check with get_run.`;
}

export const isToolRequest = (d: RunData | undefined): boolean => d?.kind === (REQUEST_KIND as string);

/**
 * Antwort des Menschen. `run` führt den gespeicherten Aufruf als freigegeben aus (WorkspaceTools.callApproved).
 * Nur aus Based heraus aufrufen (Knopf in der Inbox), nie aus einem Werkzeug.
 */
type Run = (name: string, input: JSONValue, actor: Author) => { text: string; isError: boolean };

export function resolveToolRequest(store: WorkspaceStore, runID: string, ok: boolean, run: Run, has: (name: string) => boolean = () => true): string {
  const agents = new AgentStore(store);
  const rec = getRecord<RunData>(store, RUN_TYPE, runID);
  if (!rec || !isToolRequest(rec.data)) throw new ToolError(`No request with id ${runID}`);
  const a = rec.data.approval;
  if (rec.data.status !== "needsYou" || !a) throw new ToolError("This request is already answered.");
  if (!ok) {
    agents.updateRun(runID, { status: "cancelled", result: `Declined: ${rec.data.title}`, approval: null, lease: null });
    return "Declined.";
  }
  if (!has(a.name)) {
    // Zustimmung vermerken; der Host mit diesem Werkzeug (der Server) führt aus.
    agents.updateRun(runID, { status: "queued", approval: null, lease: null, resume: { ...a, ok: true } });
    return "Allowed. Your Based server carries it out.";
  }
  return finish(store, runID, rec.data, a, run);
}

function finish(store: WorkspaceStore, runID: string, d: RunData, a: { name: string; arguments: unknown }, run: Run): string {
  const by = d.requestedBy as Author | undefined;
  const out = run(a.name, a.arguments as JSONValue, by ?? { kind: "agent", name: d.agentID });
  new AgentStore(store).updateRun(runID, { status: out.isError ? "failed" : "done", result: out.text, approval: null, lease: null, resume: null } as Parameters<AgentStore["updateRun"]>[1]);
  return out.text;
}

/** Rückfragen, denen der Mensch auf einem anderen Gerät zugestimmt hat und die nur dieser Host ausführen kann. */
export function runApprovedRequests(store: WorkspaceStore, run: Run, has: (name: string) => boolean): number {
  let n = 0;
  for (const r of new AgentStore(store).runs()) {
    const res = r.data.resume;
    if (!isToolRequest(r.data) || r.data.status !== "queued" || !res?.ok || !has(res.name)) continue;
    finish(store, r.id, r.data, res, run);
    n++;
  }
  return n;
}
