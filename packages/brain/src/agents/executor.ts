// BSD-196 / ADR 0013 §3: der deterministische Ausführer. Ein Plan wird in GENAU EINER Transaktion umgesetzt (ein
// Undo-Schritt im Store, alles oder nichts: wirft eine Aktion, dreht der Store alles zurück). Idempotent: jede Aktion
// schreibt unter einer vorher vergebenen ID (`targets`), die im Auftrag steht, bevor ausgeführt wird; existiert sie
// schon, lief die Aktion bereits (Neustart mitten im Ausführen → keine doppelte Seite).
//
// Undo an der Karte: Für jeden berührten Record merkt sich der Auftrag den Stand davor und den Stempel danach.
// `undoChanges` dreht in einer Transaktion nur zurück, was seitdem niemand geändert hat (wie Store-Undo bei Remote-
// Änderungen); eine neu angelegte Seite, in die inzwischen jemand geschrieben hat, bleibt stehen.
import {
  insertPage, isPageLike, keyOf, makeBlock, makeRecordID, MarkdownImporter, sortKeys, stampToString,
  type Block, type RecordKeyString, type Tx, type WireRecord, type WorkspaceStore,
} from "@based/core";
import { putMarkdownBlocks } from "../tools.js";
import { fromMs, INBOX_PAGE_ID, PROJECT_TYPE, putRecord, RUN_TYPE, SCHEDULE_TYPE, getRecord, updateRecord, MAIN_AGENT_ID, type ProjectData, type RunData, type ScheduleData } from "./records.js";
import type { PlannedAction, ValidPlan } from "./plan.js";
import { nextFire, parseSchedule } from "./schedule.js";
import type { Decision, UndoEntry } from "./task.js";

export class ExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionError";
  }
}

/** IDs für alles, was der Plan anlegen wird (vor dem Ausführen im Auftrag speichern). */
export function assignTargets(plan: ValidPlan, existing: Record<string, string> = {}): Record<string, string> {
  const out = { ...existing };
  for (const a of plan.actions) {
    if (a.type === "answer" || a.type === "ask") continue;
    out[a.id] ??= makeRecordID();
    // file_to_project mit neuem Namen legt zusätzlich Projekt + Seite an
    if (a.type === "file_to_project" && !a.projectID) {
      out[a.id + ":project"] ??= makeRecordID();
      out[a.id + ":page"] ??= makeRecordID();
    }
    if ((a.type === "create_page" || a.type === "create_task" || a.type === "file_to_project") && "projectID" in a && a.projectID) out[a.id + ":page"] ??= makeRecordID();
  }
  return out;
}

export interface ExecuteInput {
  taskID: string;
  input: string;
  plan: ValidPlan;
  decisions: Record<string, Decision>;
  targets: Record<string, string>;
  /** Run des Hauptagenten (Eltern der Unteragenten). */
  runID?: string | undefined;
  /** Nach Bestätigung eines Vorschlags laufen auch die „propose“-Aktionen. */
  confirmed: boolean;
  /** Jetzt (ms) für Zeitpläne. */
  nowMs: number;
}

export interface ExecuteResult {
  applied: string[];
  skipped: string[];
  undo: UndoEntry[];
  result: string;
  answer?: string;
  projectID?: string;
}

const stampOf = (r: WireRecord | undefined): string | null => (r?.data.stamp ? stampToString(r.data.stamp) : r ? "" : null);

/** Inbox-Seite (feste ID) anlegen, falls es sie nicht gibt. */
export function ensureInbox(store: WorkspaceStore, tx: Tx): string {
  if (!store.blocks.get(INBOX_PAGE_ID)) insertPage(store, tx, { id: INBOX_PAGE_ID, title: "Inbox" });
  return INBOX_PAGE_ID;
}

function appendBlock(store: WorkspaceStore, tx: Tx, pageID: string, b: Omit<Partial<Block>, "id"> & { id: string; type: string }) {
  const [sk] = sortKeys(store, "b:" + pageID, { kind: "end" }, 1);
  tx.put({ kind: "block", data: makeBlock({ ...b, parent: "b:" + pageID, sk: sk!, createdBy: store.userID } as Parameters<typeof makeBlock>[0], store.now()) });
}

function appendMarkdown(store: WorkspaceStore, tx: Tx, pageID: string, markdown: string, firstID?: string) {
  const items = new MarkdownImporter().parse(markdown);
  if (items.length === 0) return;
  const keys = sortKeys(store, "b:" + pageID, { kind: "end" }, items.length);
  putMarkdownBlocks(store, tx, items, "b:" + pageID, keys, firstID);
}

/** Projektseite, notfalls angelegt (ID aus `targets`). */
function projectPage(store: WorkspaceStore, tx: Tx, projectID: string, newPageID: string | undefined): string {
  const p = getRecord<ProjectData>(store, PROJECT_TYPE, projectID);
  if (!p) throw new ExecutionError(`The project ${projectID} no longer exists.`);
  if (p.data.pageID && isPageLike(store.blocks.get(p.data.pageID))) return p.data.pageID;
  if (!newPageID) throw new ExecutionError("No page for the project.");
  if (!store.blocks.get(newPageID)) insertPage(store, tx, { id: newPageID, title: p.name || "Project" });
  updateRecord<ProjectData>(tx, PROJECT_TYPE, projectID, (d) => { d.pageID = newPageID; });
  return newPageID;
}

const today = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Den Plan umsetzen – eine Transaktion, ein Undo-Schritt. */
export function executePlan(store: WorkspaceStore, x: ExecuteInput): ExecuteResult {
  const applied: string[] = [], skipped: string[] = [];
  const lines: string[] = [];
  let answer: string | undefined, projectID: string | undefined;
  const runs = (a: PlannedAction) => {
    const d = x.decisions[a.id] ?? "auto";
    return d === "auto" || (d === "propose" && x.confirmed);
  };
  let captured: Tx | undefined;
  const preexisting: string[] = [];
  store.transact(x.plan.summary ? `Main agent: ${x.plan.summary}` : "Main agent", (tx) => {
    captured = tx;
    for (const a of x.plan.actions) {
      if (a.type === "ask") continue;
      if (!runs(a)) { skipped.push(a.id); continue; }
      if (a.type === "answer") {
        answer = answer ? answer + "\n\n" + a.text : a.text;
        applied.push(a.id);
        continue;
      }
      const target = x.targets[a.id];
      if (!target) throw new ExecutionError(`No target id for action ${a.id}.`);
      if (store.blocks.has(target)) {
        // lief schon (Neustart mitten im Ausführen): für Undo trotzdem merken
        applied.push(a.id);
        preexisting.push(target, ...store.descendants(target));
        continue;
      }
      switch (a.type) {
        case "create_page": {
          let parent: string | undefined;
          if (a.parentID && isPageLike(store.blocks.get(a.parentID))) parent = a.parentID;
          else if (a.projectID) {
            parent = projectPage(store, tx, a.projectID, x.targets[a.id + ":page"]);
            projectID ??= a.projectID;
          }
          insertPage(store, tx, { id: target, title: a.title, ...(parent ? { parent } : {}) });
          if (a.markdown) appendMarkdown(store, tx, target, a.markdown);
          lines.push(`Page “${a.title}”`);
          break;
        }
        case "create_task": {
          const page = a.projectID ? projectPage(store, tx, a.projectID, x.targets[a.id + ":page"]) : ensureInbox(store, tx);
          if (a.projectID) projectID ??= a.projectID;
          const due = a.due ? ` — due ${a.due.slice(0, 10)}` : "";
          appendBlock(store, tx, page, { id: target, type: "todo", text: a.title + due, props: { checked: false, fromTask: x.taskID } as Block["props"] & object });
          lines.push(`Task “${a.title}”${due}`);
          break;
        }
        case "file_to_project": {
          let pid = a.projectID;
          if (!pid) {
            // gleichnamiges Projekt wiederverwenden, sonst anlegen
            const name = a.projectName!;
            pid = [...store.children("w")].find((id) => {
              const b = store.blocks.get(id);
              return b?.type === PROJECT_TYPE && b.trashedAt === undefined && (typeof b.text === "string" ? b.text : "").toLowerCase() === name.toLowerCase();
            });
            if (!pid) {
              pid = x.targets[a.id + ":project"]!;
              putRecord(store, tx, PROJECT_TYPE, pid, name, { v: 1, status: "active", createdAt: store.now() } satisfies ProjectData);
            }
          }
          const page = projectPage(store, tx, pid, x.targets[a.id + ":page"]);
          appendBlock(store, tx, page, { id: target, type: "heading3", text: `Update ${today(x.nowMs)}`, props: { fromTask: x.taskID } as Block["props"] & object });
          appendMarkdown(store, tx, page, a.note);
          projectID ??= pid;
          lines.push(`Filed into ${getRecord<ProjectData>(store, PROJECT_TYPE, pid)?.name ?? "project"}`);
          break;
        }
        case "spawn_agent": {
          const run: RunData = {
            v: 1, kind: "subagent", status: "queued", agentID: MAIN_AGENT_ID, title: a.title, startedAt: store.now(), taskID: x.taskID,
            instructions: a.instructions, usage: { inputTokens: 0, outputTokens: 0, costUSD: 0 }, costEUR: 0,
            ...(a.model ? { model: a.model } : {}), ...(a.estimateEUR !== undefined ? { budgetEUR: a.estimateEUR } : {}),
            ...(a.projectID ? { projectID: a.projectID } : {}), ...(x.runID ? { parentID: x.runID } : {}),
          };
          if (a.projectID) projectID ??= a.projectID;
          putRecord(store, tx, RUN_TYPE, target, a.title, run);
          lines.push(`Agent “${a.title}” started`);
          break;
        }
        case "schedule": {
          const s = parseSchedule(a.when);
          if (!s) throw new ExecutionError(`Can't read the time “${a.when}”.`);
          const next = nextFire(s, x.nowMs);
          const data: ScheduleData = { v: 1, when: a.when, prompt: a.prompt ?? a.title, agentID: MAIN_AGENT_ID, enabled: true, taskID: x.taskID, ...(next !== undefined ? { nextAt: fromMs(next) } : {}), ...(a.projectID ? { projectID: a.projectID } : {}) };
          putRecord(store, tx, SCHEDULE_TYPE, target, a.title, data);
          lines.push(`Scheduled “${a.title}” · ${a.when}`);
          break;
        }
      }
      applied.push(a.id);
    }
  });
  const tx = captured!;
  const undo: UndoEntry[] = tx.order.map((key) => ({ key, before: tx.before.get(key) ?? null, after: stampOf(store.record(key)) }));
  for (const id of preexisting) {
    const key = keyOf("block", id);
    if (!tx.before.has(key)) undo.push({ key, before: null, after: stampOf(store.record(key)) });
  }
  const result = lines.length > 0 ? lines.join(" · ") : answer !== undefined ? "Answered" : "Nothing to do";
  const out: ExecuteResult = { applied, skipped, undo, result };
  if (answer !== undefined) out.answer = answer;
  if (projectID) out.projectID = projectID;
  return out;
}

/** Undo eines Auftrags: eine Transaktion; nur, was seitdem unverändert ist. */
export function undoChanges(store: WorkspaceStore, undo: readonly UndoEntry[], name = "Undo main agent"): { restored: number; kept: number } {
  let restored = 0, kept = 0;
  const removing = new Set<string>();
  for (const e of undo) if (e.before === null && e.key.startsWith("block:")) removing.add(e.key.slice(6));
  store.transact(name, (tx) => {
    for (const e of [...undo].reverse()) {
      const key = e.key as RecordKeyString;
      const cur = store.record(key);
      if (stampOf(cur) !== e.after) { kept += 1; continue; }
      if (e.before === null) {
        // neu angelegt: nur entfernen, wenn niemand etwas hineingeschrieben hat
        const id = key.startsWith("block:") ? key.slice(6) : undefined;
        if (id && store.descendants(id).some((d) => !removing.has(d))) { kept += 1; continue; }
        tx.remove(key);
      } else tx.put(e.before as WireRecord);
      restored += 1;
    }
  }, { undoable: false });
  return { restored, kept };
}

/** Fallback: Eingabe als Notiz in die Inbox (idempotent über `fromTask`). Gibt die ID der Notiz zurück. */
export function fileAsNote(store: WorkspaceStore, taskID: string, input: string): string {
  const existing = store.children("b:" + INBOX_PAGE_ID).find((id) => (store.blocks.get(id)?.props as { fromTask?: string } | undefined)?.fromTask === taskID);
  if (existing) return existing;
  const id = makeRecordID();
  store.transact("File as note", (tx) => {
    ensureInbox(store, tx);
    appendBlock(store, tx, INBOX_PAGE_ID, { id, type: "text", text: input, props: { fromTask: taskID } as Block["props"] & object });
  });
  return id;
}
