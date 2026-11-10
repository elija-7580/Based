// BSD-195/196/160: Agenten-Seite des Store-Hosts (Muster: worker/chat.ts). Aufträge, Runs, Projekte, Zeitpläne und
// die Einstellungen des Hauptagenten liegen als Records im Store (AgentStore); geplant und gerechnet wird im
// Hauptthread (tasks/runtime.ts), weil Engine und API-Schlüssel dort leben. Jede Liste, die sich ändert (lokal, anderer
// Tab, Sync), geht als `agents`-Ereignis an alle Clients.
import { parseKey, type StoreChange, type WorkspaceStore } from "@based/core";
import { AGENT_RECORD_TYPES, AgentStore, type AgentData, type AgentSnapshot, type NewRun, type PlannerExample, type ProjectStatus, type RunPatch, type TaskEvent } from "@based/brain";

export type AgentAction =
  | { op: "snapshot" }
  | { op: "createTask"; input: string; id?: string; source?: string }
  | { op: "tasks" }
  | { op: "task"; id: string }
  | { op: "apply"; id: string; event: TaskEvent }
  | { op: "claim"; id: string; owner: string; ttl?: number }
  | { op: "release"; id: string; owner: string }
  | { op: "addTaskUsage"; id: string; usage: { inputTokens: number; outputTokens: number; costUSD: number }; model?: string }
  | { op: "execute"; id: string; confirmed?: boolean }
  | { op: "undo"; id: string }
  | { op: "fileNote"; id: string; reason: string; dismiss?: boolean }
  | { op: "deleteTask"; id: string }
  | { op: "planningContext" }
  | { op: "addExample"; example: PlannerExample }
  | { op: "clearExamples" }
  | { op: "runs" }
  | { op: "createRun"; data: NewRun }
  | { op: "updateRun"; id: string; patch: RunPatch }
  | { op: "claimRun"; id: string; owner: string }
  | { op: "main" }
  | { op: "saveMain"; patch: Partial<AgentData> & { rules?: string; mode?: AgentData["permissions"]["mode"] }; clear?: (keyof AgentData)[] }
  | { op: "projects" }
  | { op: "createProject"; name: string; goal?: string }
  | { op: "updateProject"; id: string; patch: { name?: string; status?: ProjectStatus; goal?: string; permissions?: string; budgetEUR?: number | null } }
  | { op: "projectUpdate"; id: string; markdown: string }
  | { op: "schedules" }
  | { op: "updateSchedule"; id: string; patch: { enabled?: boolean; when?: string; prompt?: string } }
  | { op: "deleteSchedule"; id: string }
  | { op: "claimSchedule"; id: string; nowMs: number };

export class AgentHost {
  readonly agents: AgentStore;
  private dirty = false;

  constructor(private readonly store: WorkspaceStore) {
    this.agents = new AgentStore(store);
  }

  handle(a: AgentAction): unknown {
    const s = this.agents;
    switch (a.op) {
      case "snapshot": return s.snapshot();
      case "createTask": return this.checked(() => s.createTask(a.input, { ...(a.id ? { id: a.id } : {}), ...(a.source ? { source: a.source } : {}) }));
      case "tasks": return s.tasks();
      case "task": return s.task(a.id);
      case "apply": return this.checked(() => s.apply(a.id, a.event));
      case "claim": return s.claim(a.id, a.owner, a.ttl);
      case "release": return s.release(a.id, a.owner);
      case "addTaskUsage": return s.addTaskUsage(a.id, a.usage, a.model);
      case "execute": return this.checked(() => s.execute(a.id, a.confirmed));
      case "undo": return this.checked(() => s.undo(a.id));
      case "fileNote": return this.checked(() => s.fileNote(a.id, a.reason, a.dismiss));
      case "deleteTask": return s.deleteTask(a.id);
      case "planningContext": return s.planningContext();
      case "addExample": return s.addExample(a.example);
      case "clearExamples": return s.clearExamples();
      case "runs": return s.runs();
      case "createRun": return s.createRun(a.data);
      case "updateRun": return s.updateRun(a.id, a.patch);
      case "claimRun": return s.claimRun(a.id, a.owner);
      case "main": return s.main();
      case "saveMain": return this.checked(() => s.saveMain((d) => {
        const { rules, mode, ...rest } = a.patch;
        Object.assign(d, rest);
        if (rules !== undefined) d.permissions = { ...d.permissions, rules };
        if (mode !== undefined) d.permissions = { ...d.permissions, mode };
        for (const k of a.clear ?? []) delete d[k];
      }));
      case "projects": return s.projects();
      case "createProject": return this.checked(() => s.createProject(a.name, a.goal ? { goal: a.goal } : {}));
      case "updateProject": return this.checked(() => s.updateProject(a.id, a.patch));
      case "projectUpdate": return s.projectUpdate(a.id, a.markdown);
      case "schedules": return s.schedules();
      case "updateSchedule": return this.checked(() => s.updateSchedule(a.id, a.patch));
      case "deleteSchedule": return s.deleteSchedule(a.id);
      case "claimSchedule": return s.claimSchedule(a.id, a.nowMs);
    }
  }

  /** Der Store weist Schreiben still ab, wenn er schreibgeschützt ist: als Fehler melden, nicht als Erfolg. */
  private checked<T>(body: () => T): T {
    const out = body();
    if (this.store.isReadOnly) throw new Error("read-only: " + (this.store.writeFailure?.message ?? ""));
    return out;
  }

  /** Hat sich ein Agenten-Record geändert (lokal, anderer Tab oder Sync)? Gelöschte erkennt man am fehlenden Block. */
  noteChange(change: StoreChange) {
    for (const key of change.keys) {
      const { kind, id } = parseKey(key);
      if (kind !== "block") continue;
      const b = this.store.blocks.get(id);
      if (!b || AGENT_RECORD_TYPES.has(b.type)) {
        this.dirty = true;
        return;
      }
    }
  }

  /** Neuer Stand, falls sich seit dem letzten Aufruf etwas geändert hat. */
  takeSnapshot(): AgentSnapshot | undefined {
    if (!this.dirty) return undefined;
    this.dirty = false;
    return this.agents.snapshot();
  }
}
