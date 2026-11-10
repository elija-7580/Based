// BSD-195/196/160: alle Agenten-Records eines Workspaces auf dem WorkspaceStore (im Web: im Store-Worker). Jede
// Methode ist synchron und schreibt in genau einer Transaktion; Auftrags- und Run-Verwaltung ist kein Undo-Schritt
// (⌘Z nimmt keinen Zustandswechsel zurück) – nur das Ausführen eines Plans ist einer (executor.ts).
import { insertPage, makeRecordID, MarkdownImporter, plainText, sortKeys, type WorkspaceStore } from "@based/core";
import { putMarkdownBlocks } from "../tools.js";
import { spentThisMonth, usdToEUR } from "./budget.js";
import { assignTargets, executePlan, fileAsNote, undoChanges } from "./executor.js";
import type { PlannerExample } from "./planner.js";
import {
  AGENT_TYPE, defaultMainAgent, getRecord, listRecords, MAIN_AGENT_ID, PROJECT_TYPE, putRecord, removeRecord, RUN_TYPE, SCHEDULE_TYPE, toMs, fromMs, updateRecord,
  type AgentData, type ProjectData, type ProjectStatus, type Rec, type RunData, type ScheduleData,
} from "./records.js";
import { nextFire, parseSchedule } from "./schedule.js";
import { newTask, readTask, TASK_TYPE, taskTitle, transition, type TaskData, type TaskEvent } from "./task.js";

export interface TaskView {
  id: string;
  title: string;
  data: TaskData;
}

export interface AgentSnapshot {
  tasks: TaskView[];
  runs: Rec<RunData>[];
  projects: Rec<ProjectData>[];
  schedules: Rec<ScheduleData>[];
  main: AgentData;
  /** € des Hauptagenten in diesem Monat. */
  spentEUR: number;
}

export interface PlanningContext {
  projects: { id: string; name: string; goal?: string; permissions?: string }[];
  examples: PlannerExample[];
  main: AgentData;
  spentEUR: number;
}

export interface RunPatch {
  status?: RunData["status"];
  result?: string;
  chatID?: string;
  model?: string;
  /** Verbrauch hinzufügen (USD; € wird mit dem Kurs des Agenten gerechnet). */
  addUsage?: { inputTokens: number; outputTokens: number; costUSD: number };
  subscriptionShare?: number;
  lease?: { owner: string; until: number } | null;
}

/** Neuer Run: Pflichtfelder, Rest optional (Zeit und Kosten setzt der Store). */
export type NewRun = Pick<RunData, "kind" | "status" | "agentID" | "title"> & Partial<Omit<RunData, "v" | "startedAt" | "kind" | "status" | "agentID" | "title">>;

const TASK_LIMIT = 200;
const MAX_EXAMPLES = 20;

export class AgentStore {
  constructor(readonly store: WorkspaceStore, private readonly nowMs: () => number = () => Date.now()) {}

  // MARK: Aufträge (BSD-195)

  private taskView(id: string): TaskView | undefined {
    const b = this.store.blocks.get(id);
    if (!b || b.type !== TASK_TYPE || b.trashedAt !== undefined) return undefined;
    const data = readTask((b.props as { task?: unknown } | undefined)?.task);
    return data ? { id, title: plainText(b.text), data } : undefined;
  }

  task(id: string): TaskView {
    const t = this.taskView(id);
    if (!t) throw new Error("This task no longer exists.");
    return t;
  }

  /** Neueste zuerst (höchstens 200). */
  tasks(): TaskView[] {
    const out: TaskView[] = [];
    for (const id of this.store.children("w")) {
      const t = this.taskView(id);
      if (t) out.push(t);
    }
    return out.sort((a, b) => b.data.createdAt - a.data.createdAt || (a.id < b.id ? -1 : 1)).slice(0, TASK_LIMIT);
  }

  /** Auftrag ZUERST speichern – vor jedem Modellaufruf. `id` darf der Aufrufer vergeben (Idempotenz beim Wiederholen). */
  createTask(input: string, opts: { id?: string; source?: string } = {}): TaskView {
    const id = opts.id ?? makeRecordID();
    if (this.taskView(id)) return this.task(id);
    const data = newTask(input, this.store.now(), opts.source);
    this.store.transact("New task", (tx) => putRecord(this.store, tx, TASK_TYPE, id, taskTitle(input), data), { undoable: false });
    return this.task(id);
  }

  private writeTask(id: string, data: TaskData, name = "Task") {
    this.store.transact(name, (tx) => updateRecord<TaskData>(tx, TASK_TYPE, id, (d) => {
      for (const k of Object.keys(d)) if (!(k in data)) delete (d as Record<string, unknown>)[k];
      Object.assign(d, data);
    }), { undoable: false });
  }

  /** Zustandsübergang (wirft TransitionError bei unerlaubten). `understand` legt den Run des Hauptagenten an. */
  apply(id: string, event: TaskEvent): TaskView {
    const t = this.task(id);
    const next = transition(t.data, event, this.store.now());
    if (event.type === "understand" && !next.runID) {
      const runID = makeRecordID();
      next.runID = runID;
      this.store.transact("Task", (tx) => {
        putRecord(this.store, tx, RUN_TYPE, runID, t.title, { v: 1, kind: "main", status: "running", agentID: MAIN_AGENT_ID, title: t.title, startedAt: this.store.now(), taskID: id, usage: { inputTokens: 0, outputTokens: 0, costUSD: 0 }, costEUR: 0 } satisfies RunData);
        updateRecord<TaskData>(tx, TASK_TYPE, id, (d) => Object.assign(d, next));
      }, { undoable: false });
      return this.task(id);
    }
    this.writeTask(id, next);
    // Run des Hauptagenten folgt dem Auftrag
    if (next.runID && (next.state === "done" || next.state === "failed" || next.state === "filed" || next.state === "question" || next.state === "proposal")) {
      const status: RunData["status"] = next.state === "done" || next.state === "filed" ? "done" : next.state === "failed" ? "failed" : "needsYou";
      this.updateRun(next.runID, { status, ...(next.result ? { result: next.result } : next.error ? { result: next.error } : {}) });
    } else if (next.runID && event.type === "retry") this.updateRun(next.runID, { status: "running" });
    return this.task(id);
  }

  /** Arbeit an einem Auftrag übernehmen (ein Tab/Gerät zur Zeit). `false`: jemand anderes hält ihn. */
  claim(id: string, owner: string, ttlSeconds = 300): boolean {
    const t = this.task(id);
    const now = this.store.now();
    if (t.data.lease && t.data.lease.owner !== owner && t.data.lease.until > now) return false;
    this.store.transact("Task", (tx) => updateRecord<TaskData>(tx, TASK_TYPE, id, (d) => { d.lease = { owner, until: now + ttlSeconds }; }), { undoable: false });
    return true;
  }

  release(id: string, owner: string) {
    const t = this.taskView(id);
    if (!t?.data.lease || t.data.lease.owner !== owner) return;
    this.store.transact("Task", (tx) => updateRecord<TaskData>(tx, TASK_TYPE, id, (d) => { delete d.lease; }), { undoable: false });
  }

  /** Verbrauch der Planung am Auftrag und am Run des Hauptagenten. */
  addTaskUsage(id: string, usage: { inputTokens: number; outputTokens: number; costUSD: number }, model?: string) {
    const t = this.task(id);
    const u = t.data.usage ?? { inputTokens: 0, outputTokens: 0, costUSD: 0 };
    this.store.transact("Task", (tx) => updateRecord<TaskData>(tx, TASK_TYPE, id, (d) => {
      d.usage = { inputTokens: u.inputTokens + usage.inputTokens, outputTokens: u.outputTokens + usage.outputTokens, costUSD: u.costUSD + usage.costUSD };
    }), { undoable: false });
    if (t.data.runID) this.updateRun(t.data.runID, { addUsage: usage, ...(model ? { model } : {}) });
  }

  /** Ausführen (BSD-196): Ziel-IDs zuerst im Auftrag speichern, dann der Plan in einer Transaktion, dann der Zustand. */
  execute(id: string, confirmed = false): TaskView {
    let t = this.task(id);
    if (t.data.state !== "executing") throw new Error(`Task is ${t.data.state}, not executing.`);
    const plan = t.data.plan;
    if (!plan) return this.apply(id, { type: "fail", error: "No plan to execute." });
    if (!t.data.targets) {
      const targets = assignTargets(plan);
      this.store.transact("Task", (tx) => updateRecord<TaskData>(tx, TASK_TYPE, id, (d) => { d.targets = targets; }), { undoable: false });
      t = this.task(id);
    }
    try {
      const r = executePlan(this.store, {
        taskID: id, input: t.data.input, plan, decisions: t.data.decisions ?? {}, targets: t.data.targets!, runID: t.data.runID,
        confirmed: confirmed || t.data.confirmed === true, nowMs: this.nowMs(),
      });
      return this.apply(id, { type: "executed", applied: r.applied, undo: r.undo, result: r.result, ...(r.answer !== undefined ? { answer: r.answer } : {}), ...(r.projectID ? { projectID: r.projectID } : {}) });
    } catch (e) {
      return this.apply(id, { type: "fail", error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Undo an der Karte: eine Transaktion, nur Unverändertes. Gestartete Unteragenten werden abgebrochen. */
  undo(id: string): TaskView {
    const t = this.task(id);
    if (t.data.state !== "done") throw new Error("Only finished tasks can be undone.");
    const { restored, kept } = undoChanges(this.store, t.data.undo ?? [], `Undo “${t.title}”`);
    const result = kept > 0 ? `Undone (${kept} changed since, kept)` : restored > 0 ? "Undone" : "Undone (nothing to revert)";
    return this.apply(id, { type: "undo", result });
  }

  /** Fallback: als Notiz in die Inbox (nach zwei ungültigen Plänen oder „File as note“). */
  fileNote(id: string, reason: string, dismiss = false): TaskView {
    const t = this.task(id);
    const noteID = fileAsNote(this.store, id, t.data.input);
    return this.apply(id, dismiss ? { type: "dismiss", noteID } : { type: "filed", noteID, reason });
  }

  /** Korrektur als persönliches Beispiel (ADR 0013 §5): fließt als Few-Shot in künftige Pläne. */
  addExample(example: PlannerExample) {
    this.saveMain((d) => {
      const list = ((d as { examples?: PlannerExample[] }).examples ?? []).filter((e) => e.input !== example.input);
      (d as { examples?: PlannerExample[] }).examples = [example, ...list].slice(0, MAX_EXAMPLES);
    });
  }

  clearExamples() {
    this.saveMain((d) => { delete (d as { examples?: unknown }).examples; });
  }

  deleteTask(id: string) {
    this.task(id);
    this.store.transact("Delete task", (tx) => removeRecord(tx, id), { undoable: false });
  }

  planningContext(): PlanningContext {
    const main = this.main();
    return {
      projects: this.projects().filter((p) => p.data.status === "active").map((p) => ({ id: p.id, name: p.name, ...(p.data.goal ? { goal: p.data.goal } : {}), ...(p.data.permissions ? { permissions: p.data.permissions } : {}) })),
      examples: (main as { examples?: PlannerExample[] }).examples ?? [],
      main,
      spentEUR: spentThisMonth(this.runs(), MAIN_AGENT_ID, this.nowMs()),
    };
  }

  // MARK: Agent (BSD-160)

  main(): AgentData {
    return getRecord<AgentData>(this.store, AGENT_TYPE, MAIN_AGENT_ID)?.data ?? defaultMainAgent();
  }

  saveMain(f: (d: AgentData) => void) {
    this.store.transact("Main agent settings", (tx) => {
      if (!getRecord<AgentData>(this.store, AGENT_TYPE, MAIN_AGENT_ID)) putRecord(this.store, tx, AGENT_TYPE, MAIN_AGENT_ID, "Main agent", defaultMainAgent());
      updateRecord<AgentData>(tx, AGENT_TYPE, MAIN_AGENT_ID, f);
    }, { undoable: false });
  }

  // MARK: Runs

  runs(): Rec<RunData>[] {
    return listRecords<RunData>(this.store, RUN_TYPE);
  }

  run(id: string): Rec<RunData> | undefined {
    return getRecord<RunData>(this.store, RUN_TYPE, id);
  }

  createRun(data: NewRun, id = makeRecordID()): Rec<RunData> {
    const usage: RunData["usage"] = (data.usage as RunData["usage"] | undefined) ?? { inputTokens: 0, outputTokens: 0, costUSD: 0 };
    const run = { ...data, v: 1, startedAt: this.store.now(), usage, costEUR: (data.costEUR as number | undefined) ?? usdToEUR(usage.costUSD, this.main()) } as RunData;
    if ((run.status === "done" || run.status === "failed" || run.status === "cancelled") && run.endedAt === undefined) run.endedAt = run.startedAt;
    this.store.transact("Run", (tx) => putRecord(this.store, tx, RUN_TYPE, id, data.title, run), { undoable: false });
    return this.run(id)!;
  }

  updateRun(id: string, patch: RunPatch): Rec<RunData> | undefined {
    if (!this.run(id)) return undefined;
    const rate = this.main();
    const now = this.store.now();
    this.store.transact("Run", (tx) => updateRecord<RunData>(tx, RUN_TYPE, id, (d) => {
      if (patch.status) {
        d.status = patch.status;
        if (patch.status === "done" || patch.status === "failed" || patch.status === "cancelled") d.endedAt = now;
        else delete d.endedAt;
      }
      if (patch.result !== undefined) d.result = patch.result;
      if (patch.chatID) d.chatID = patch.chatID;
      if (patch.model) d.model = patch.model;
      if (patch.subscriptionShare !== undefined) d.subscriptionShare = patch.subscriptionShare;
      if (patch.lease === null) delete d.lease;
      else if (patch.lease) d.lease = patch.lease;
      if (patch.addUsage) {
        const u = d.usage ?? { inputTokens: 0, outputTokens: 0, costUSD: 0 };
        d.usage = { inputTokens: u.inputTokens + patch.addUsage.inputTokens, outputTokens: u.outputTokens + patch.addUsage.outputTokens, costUSD: u.costUSD + patch.addUsage.costUSD };
        d.costEUR = (d.costEUR ?? 0) + usdToEUR(patch.addUsage.costUSD, rate);
      }
    }), { undoable: false });
    return this.run(id);
  }

  /** Einen wartenden Lauf übernehmen (`queued` → `running`, mit Lease). `false`: läuft schon woanders oder ist weg. */
  claimRun(id: string, owner: string, ttlSeconds = 300): boolean {
    const r = this.run(id);
    if (!r) return false;
    const now = this.store.now();
    const leased = r.data.lease && r.data.lease.owner !== owner && r.data.lease.until > now;
    if (leased || (r.data.status !== "queued" && r.data.status !== "running")) return false;
    this.updateRun(id, { status: "running", lease: { owner, until: now + ttlSeconds } });
    return true;
  }

  // MARK: Projekte

  projects(): Rec<ProjectData>[] {
    return listRecords<ProjectData>(this.store, PROJECT_TYPE).sort((a, b) => a.name.localeCompare(b.name));
  }

  createProject(name: string, opts: { goal?: string; id?: string } = {}): Rec<ProjectData> {
    const id = opts.id ?? makeRecordID();
    this.store.transact("New project", (tx) => putRecord(this.store, tx, PROJECT_TYPE, id, name.trim() || "Untitled project", { v: 1, status: "active", createdAt: this.store.now(), ...(opts.goal ? { goal: opts.goal } : {}) } satisfies ProjectData), { undoable: false });
    return getRecord<ProjectData>(this.store, PROJECT_TYPE, id)!;
  }

  updateProject(id: string, patch: { name?: string; status?: ProjectStatus; goal?: string; permissions?: string; budgetEUR?: number | null }) {
    if (!getRecord<ProjectData>(this.store, PROJECT_TYPE, id)) throw new Error("This project no longer exists.");
    this.store.transact("Project", (tx) => updateRecord<ProjectData>(tx, PROJECT_TYPE, id, (d) => {
      if (patch.status) d.status = patch.status;
      if (patch.goal !== undefined) d.goal = patch.goal;
      if (patch.permissions !== undefined) d.permissions = patch.permissions;
      if (patch.budgetEUR === null) delete d.budgetEUR;
      else if (patch.budgetEUR !== undefined) d.budgetEUR = patch.budgetEUR;
    }, patch.name), { undoable: false });
  }

  /** Update des Hauptagenten auf die Projektseite (Seite wird bei Bedarf angelegt). Kein Undo-Schritt. */
  projectUpdate(projectID: string, markdown: string) {
    const p = getRecord<ProjectData>(this.store, PROJECT_TYPE, projectID);
    if (!p) throw new Error("This project no longer exists.");
    const day = new Date(this.nowMs()).toISOString().slice(0, 10);
    this.store.transact("Project update", (tx) => {
      let page = p.data.pageID && this.store.blocks.get(p.data.pageID) ? p.data.pageID : undefined;
      if (!page) {
        page = insertPage(this.store, tx, { title: p.name || "Project" });
        const pid = page;
        updateRecord<ProjectData>(tx, PROJECT_TYPE, projectID, (d) => { d.pageID = pid; });
      }
      const items = new MarkdownImporter().parse(`${day} · ${markdown}`);
      putMarkdownBlocks(this.store, tx, items, "b:" + page, sortKeys(this.store, "b:" + page, { kind: "end" }, items.length));
    }, { undoable: false });
  }

  // MARK: Zeitpläne

  schedules(): Rec<ScheduleData>[] {
    return listRecords<ScheduleData>(this.store, SCHEDULE_TYPE);
  }

  updateSchedule(id: string, patch: { enabled?: boolean; when?: string; prompt?: string }) {
    const s = getRecord<ScheduleData>(this.store, SCHEDULE_TYPE, id);
    if (!s) throw new Error("This schedule no longer exists.");
    const when = patch.when ?? s.data.when;
    const parsed = parseSchedule(when);
    if (!parsed) throw new Error(`Can't read the time “${when}”.`);
    const next = nextFire(parsed, this.nowMs());
    this.store.transact("Schedule", (tx) => updateRecord<ScheduleData>(tx, SCHEDULE_TYPE, id, (d) => {
      if (patch.enabled !== undefined) d.enabled = patch.enabled;
      if (patch.prompt !== undefined) d.prompt = patch.prompt;
      d.when = when;
      if (next !== undefined) d.nextAt = fromMs(next);
      else delete d.nextAt;
    }), { undoable: false });
  }

  deleteSchedule(id: string) {
    this.store.transact("Delete schedule", (tx) => removeRecord(tx, id), { undoable: false });
  }

  /**
   * Fälligen Zeitplan übernehmen – ohne Doppel-Lauf: nur wer `nextAt` noch fällig sieht, schiebt ihn weiter und
   * bekommt `true` (ein Tab/Worker zur Zeit; über Geräte hinweg schützt der weitergeschobene Termin, sobald gesynct).
   */
  claimSchedule(id: string, nowMs = this.nowMs()): boolean {
    const s = getRecord<ScheduleData>(this.store, SCHEDULE_TYPE, id);
    if (!s || !s.data.enabled || s.data.nextAt === undefined || toMs(s.data.nextAt) > nowMs) return false;
    const parsed = parseSchedule(s.data.when);
    const next = parsed ? nextFire(parsed, nowMs) : undefined;
    this.store.transact("Schedule", (tx) => updateRecord<ScheduleData>(tx, SCHEDULE_TYPE, id, (d) => {
      d.lastAt = fromMs(nowMs);
      if (next !== undefined) d.nextAt = fromMs(next);
      else delete d.nextAt;
    }), { undoable: false });
    return true;
  }

  snapshot(): AgentSnapshot {
    const runs = this.runs();
    return { tasks: this.tasks(), runs: runs.slice(0, 200), projects: this.projects(), schedules: this.schedules(), main: this.main(), spentEUR: spentThisMonth(runs, MAIN_AGENT_ID, this.nowMs()) };
  }
}

/** Gehört ein Block-Typ zu den Agenten-Records? (für das Beobachten von Änderungen) */
export const AGENT_RECORD_TYPES: ReadonlySet<string> = new Set([TASK_TYPE, RUN_TYPE, PROJECT_TYPE, AGENT_TYPE, SCHEDULE_TYPE]);
