// BSD-195 / ADR 0013 §4: Event-Strom im AG-UI-Stil für Aufträge – Run-Start/-Ende, Aktionen (Tool-Calls), Zustand als
// Snapshot + JSON-Patch-Deltas (RFC 6902, nur add/remove/replace). Quelle sind die Records: `TaskStream.update`
// bekommt den neuen Stand und gibt die Ereignisse seit dem letzten aus. So sehen alle Oberflächen (Startseite, Watch,
// MCP-Clients) dasselbe, egal ob die Änderung lokal, aus einem anderen Tab oder über Sync kam.
import type { TaskView } from "./store.js";
import { isFinished, type TaskState } from "./task.js";

export type JsonPatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: unknown };

const esc = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");
const unesc = (k: string) => k.replace(/~1/g, "/").replace(/~0/g, "~");
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Minimaler Patch von `a` nach `b` (Arrays werden als Ganzes ersetzt, außer gleich lang mit Objekten). */
export function diff(a: unknown, b: unknown, path = ""): JsonPatchOp[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (isObj(a) && isObj(b)) {
    const out: JsonPatchOp[] = [];
    for (const k of Object.keys(a)) if (!(k in b) || b[k] === undefined) { if (a[k] !== undefined) out.push({ op: "remove", path: `${path}/${esc(k)}` }); }
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined) continue;
      if (!(k in a) || a[k] === undefined) out.push({ op: "add", path: `${path}/${esc(k)}`, value: v });
      else out.push(...diff(a[k], v, `${path}/${esc(k)}`));
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.flatMap((x, i) => diff(x, b[i], `${path}/${i}`));
  return [{ op: "replace", path: path || "", value: b }];
}

/** Patch anwenden (gibt einen neuen Wert zurück, `doc` bleibt unverändert). */
export function applyPatch<T>(doc: T, ops: readonly JsonPatchOp[]): T {
  let root: unknown = structuredClone(doc);
  for (const op of ops) {
    if (op.path === "") {
      if (op.op === "remove") root = undefined;
      else root = structuredClone(op.value);
      continue;
    }
    const keys = op.path.split("/").slice(1).map(unesc);
    let cur = root as Record<string, unknown> | unknown[];
    for (const k of keys.slice(0, -1)) cur = (cur as Record<string, unknown>)[k] as Record<string, unknown>;
    const last = keys[keys.length - 1]!;
    if (Array.isArray(cur)) {
      const i = last === "-" ? cur.length : Number(last);
      if (op.op === "add") cur.splice(i, 0, structuredClone(op.value));
      else if (op.op === "remove") cur.splice(i, 1);
      else cur[i] = structuredClone(op.value);
    } else if (op.op === "remove") delete cur[last];
    else cur[last] = structuredClone(op.value);
  }
  return root as T;
}

/** Zustand des Stroms: Aufträge nach ID. */
export type TaskStreamState = Record<string, { title: string; state: TaskState; data: TaskView["data"] }>;

export type TaskStreamEvent =
  | { type: "STATE_SNAPSHOT"; snapshot: TaskStreamState }
  | { type: "STATE_DELTA"; delta: JsonPatchOp[] }
  | { type: "RUN_STARTED"; taskID: string }
  | { type: "RUN_FINISHED"; taskID: string; state: TaskState }
  | { type: "RUN_ERROR"; taskID: string; message: string }
  /** Eine Aktion des Plans wurde ausgeführt (Werkzeug-Aufruf im AG-UI-Sinn). */
  | { type: "TOOL_CALL_END"; taskID: string; actionID: string; name: string };

export const toStreamState = (tasks: readonly TaskView[]): TaskStreamState =>
  Object.fromEntries(tasks.map((t) => [t.id, { title: t.title, state: t.data.state, data: t.data }]));

export class TaskStream {
  private state: TaskStreamState | undefined;
  private listeners = new Set<(e: TaskStreamEvent) => void>();

  /** Abonnieren: zuerst kommt ein Snapshot (falls schon ein Stand da ist), danach Deltas und Ereignisse. */
  subscribe(fn: (e: TaskStreamEvent) => void): () => void {
    this.listeners.add(fn);
    if (this.state) fn({ type: "STATE_SNAPSHOT", snapshot: structuredClone(this.state) });
    return () => this.listeners.delete(fn);
  }

  /** Neuer Stand der Aufträge → Ereignisse. Gibt sie auch zurück (Tests). */
  update(tasks: readonly TaskView[]): TaskStreamEvent[] {
    const next = toStreamState(tasks);
    const prev = this.state;
    this.state = next;
    const out: TaskStreamEvent[] = [];
    if (!prev) out.push({ type: "STATE_SNAPSHOT", snapshot: structuredClone(next) });
    else {
      const delta = diff(prev, next);
      if (delta.length === 0) return [];
      out.push({ type: "STATE_DELTA", delta });
      for (const [id, t] of Object.entries(next)) {
        const old = prev[id];
        if (old?.state === t.state) continue;
        if (t.state !== "received" && (!old || old.state === "received")) out.push({ type: "RUN_STARTED", taskID: id });
        if (t.state === "done") for (const a of t.data.applied ?? []) {
          const action = t.data.plan?.actions.find((x) => x.id === a);
          if (action) out.push({ type: "TOOL_CALL_END", taskID: id, actionID: a, name: action.type });
        }
        if (t.state === "failed") out.push({ type: "RUN_ERROR", taskID: id, message: t.data.error ?? "failed" });
        else if (isFinished(t.state) || t.state === "question" || t.state === "proposal") out.push({ type: "RUN_FINISHED", taskID: id, state: t.state });
      }
    }
    for (const e of out) for (const fn of this.listeners) fn(e);
    return out;
  }
}
