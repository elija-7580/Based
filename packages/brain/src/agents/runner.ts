// BSD-195/196: der Runner des Hauptagenten (im Web: Hauptthread, weil Engine und API-Schlüssel dort leben; die
// Records liegen im Store-Worker und werden über `TaskBackend` geschrieben). Ablauf je Auftrag:
//   received → (online + Modell?) understanding → Plan (Schema, 1 Retry) → Sicherheitsstufen → question | proposal |
//   executing → done; zwei ungültige Pläne/Fehler → als Notiz abgelegt („filed“). Jeder Schritt steht im Record, bevor
//   der nächste beginnt: nach einem Neustart setzt `resume()` an der letzten Stelle fort; das Ausführen ist idempotent.
// Mehrere Tabs/Geräte: ein Auftrag wird nur bearbeitet, wer ihn per Lease hält (`claim`).
import { isAbort } from "../messages.js";
import type { ChatEngine } from "../engine.js";
import { remaining } from "./budget.js";
import type { PlannedAction } from "./plan.js";
import { planOnce, type PlannerExample } from "./planner.js";
import { Permissions, mainArgument } from "./permissions.js";
import { assess, type RuleDecider, type SafetyContext } from "./safety.js";
import type { PlanningContext, TaskView } from "./store.js";
import { MAX_PLAN_ATTEMPTS, needsWork, type TaskEvent } from "./task.js";

/** Was der Runner vom Speicher braucht (Store-Worker über den Client; in Tests `localBackend(AgentStore)`). */
export interface TaskBackend {
  createTask(input: string, opts?: { id?: string; source?: string }): Promise<TaskView>;
  tasks(): Promise<TaskView[]>;
  task(id: string): Promise<TaskView>;
  apply(id: string, event: TaskEvent): Promise<TaskView>;
  claim(id: string, owner: string, ttlSeconds?: number): Promise<boolean>;
  release(id: string, owner: string): Promise<void>;
  addTaskUsage(id: string, usage: { inputTokens: number; outputTokens: number; costUSD: number }, model?: string): Promise<void>;
  execute(id: string, confirmed?: boolean): Promise<TaskView>;
  undo(id: string): Promise<TaskView>;
  fileNote(id: string, reason: string, dismiss?: boolean): Promise<TaskView>;
  planningContext(): Promise<PlanningContext>;
  addExample(example: PlannerExample): Promise<void>;
}

/** Synchrones AgentStore-Objekt als Backend (Tests, Server). */
export function localBackend(s: {
  createTask(input: string, opts?: { id?: string; source?: string }): TaskView; tasks(): TaskView[]; task(id: string): TaskView; apply(id: string, e: TaskEvent): TaskView;
  claim(id: string, owner: string, ttl?: number): boolean; release(id: string, owner: string): void; addTaskUsage(id: string, u: { inputTokens: number; outputTokens: number; costUSD: number }, model?: string): void;
  execute(id: string, confirmed?: boolean): TaskView; undo(id: string): TaskView; fileNote(id: string, reason: string, dismiss?: boolean): TaskView; planningContext(): PlanningContext; addExample(e: PlannerExample): void;
}): TaskBackend {
  const a = <T>(f: () => T) => Promise.resolve().then(f);
  return {
    createTask: (i, o) => a(() => s.createTask(i, o)), tasks: () => a(() => s.tasks()), task: (id) => a(() => s.task(id)), apply: (id, e) => a(() => s.apply(id, e)),
    claim: (id, o, t) => a(() => s.claim(id, o, t)), release: (id, o) => a(() => s.release(id, o)), addTaskUsage: (id, u, m) => a(() => s.addTaskUsage(id, u, m)),
    execute: (id, c) => a(() => s.execute(id, c)), undo: (id) => a(() => s.undo(id)), fileNote: (id, r, d) => a(() => s.fileNote(id, r, d)),
    planningContext: () => a(() => s.planningContext()), addExample: (e) => a(() => s.addExample(e)),
  };
}

export interface TaskRunnerOptions {
  backend: TaskBackend;
  /** Engine für den Planer (`undefined`: kein Modell eingerichtet → Auftrag wartet). */
  engine: () => Promise<ChatEngine | undefined> | ChatEngine | undefined;
  /** Verbindung da? (Standard: immer). Offline wartet der Auftrag in „received“. */
  online?: () => boolean;
  /** Kennung dieses Tabs/Prozesses für Leases. */
  owner?: string;
  today?: () => string;
  minConfidence?: number;
  /** Fehler außerhalb eines Auftrags (Speichern gescheitert …). */
  onError?: (e: unknown) => void;
}

export const YES_OPTION = "Yes, do it";
export const NOTE_OPTION = "File as note";

/** Netzfehler (fetch) – kein Grund, den Auftrag abzulegen: er wartet auf Verbindung. */
const isOffline = (e: unknown) => e instanceof Error && /failed to fetch|networkerror|network error|load failed|cannot connect|ERR_INTERNET/i.test(e.message);

export class TaskRunner {
  private readonly owner: string;
  private inFlight = new Map<string, Promise<void>>();
  private abort = new AbortController();

  constructor(private readonly o: TaskRunnerOptions) {
    this.owner = o.owner ?? "runner-" + Math.random().toString(36).slice(2, 10);
  }

  /** Eingabe → Auftrag (zuerst gespeichert, auch offline) → im Hintergrund planen. */
  async submit(input: string, opts: { source?: string } = {}): Promise<TaskView> {
    const t = await this.o.backend.createTask(input.trim(), opts.source ? { source: opts.source } : {});
    this.kick(t.id);
    return t;
  }

  /** Nach Start/Neuladen oder wenn die Verbindung zurück ist: alles fortsetzen, was nicht fertig ist. */
  async resume(): Promise<void> {
    const tasks = await this.o.backend.tasks();
    await Promise.all(tasks.filter((t) => needsWork(t.data.state)).map((t) => this.kick(t.id)));
  }

  /** Einen Auftrag weiterbearbeiten (läuft er schon in diesem Runner: dieselbe Promise). */
  kick(id: string): Promise<void> {
    const cur = this.inFlight.get(id);
    if (cur) return cur;
    const p = this.process(id).catch((e: unknown) => this.o.onError?.(e)).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, p);
    return p;
  }

  /** Warten, bis alle laufenden Aufträge stehen (Tests). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight.values()]);
  }

  stop() {
    this.abort.abort();
    this.abort = new AbortController();
  }

  // MARK: Knöpfe der Karte

  /** Antwort auf eine Rückfrage. */
  async answer(id: string, option: string): Promise<void> {
    const t = await this.o.backend.task(id);
    const q = t.data.question;
    if (t.data.state !== "question" || !q) return;
    const askAction = t.data.plan?.actions.find((a) => a.id === q.actionID);
    if (option === NOTE_OPTION) {
      await this.o.backend.fileNote(id, "the user chose to file it", true);
      return;
    }
    if (askAction && askAction.type !== "ask" && option === YES_OPTION && t.data.plan) {
      // unsichere Aktion bestätigt: derselbe Plan, diese Aktion gilt als sicher
      const plan = { ...t.data.plan, actions: t.data.plan.actions.map((a) => (a.id === askAction.id ? { ...a, confidence: 1 } : a)) as PlannedAction[] };
      const ctx = await this.o.backend.planningContext();
      const r = assess(plan, this.safety(ctx));
      await this.o.backend.apply(id, { type: "planned", plan, decisions: r.decisions, next: r.next, ...(r.question ? { question: r.question } : {}), ...(r.proposal ? { proposal: r.proposal } : {}) });
    } else {
      await this.o.backend.apply(id, { type: "answer", option });
      // Korrektur merken: „diese Eingabe gehört zu <Antwort>“ (ADR 0013 §5)
      if (askAction?.type === "ask") await this.o.backend.addExample({ input: t.data.input.slice(0, 200), correction: `${q.text} → ${option}` }).catch(() => undefined);
    }
    await this.kick(id);
  }

  async confirm(id: string): Promise<void> {
    await this.o.backend.apply(id, { type: "confirm" });
    await this.kick(id);
  }

  /** Vorschlag/Rückfrage verwerfen: die Eingabe landet als Notiz in der Inbox (nichts geht verloren). */
  async dismiss(id: string): Promise<void> {
    await this.o.backend.fileNote(id, "dismissed", true);
  }

  async undo(id: string): Promise<void> {
    await this.o.backend.undo(id);
  }

  async retry(id: string): Promise<void> {
    await this.o.backend.apply(id, { type: "retry" });
    await this.kick(id);
  }

  // MARK: Ablauf

  private safety(ctx: PlanningContext): SafetyContext {
    const base = Permissions.from(ctx.main.permissions.rules, ctx.main.permissions.mode);
    const rules: RuleDecider = (a) => {
      const p = "projectID" in a && a.projectID ? ctx.projects.find((x) => x.id === a.projectID) : undefined;
      const perms = base.layered(p?.permissions);
      const arg = a.type === "file_to_project" ? a.projectName ?? p?.name : mainArgument(a as unknown as Record<string, unknown>);
      return perms.ruleVerdict({ tool: "based." + a.type, argument: arg });
    };
    return {
      mode: base.mode, rules,
      ...(this.o.minConfidence !== undefined ? { minConfidence: this.o.minConfidence } : {}),
      perTaskEUR: ctx.main.perTaskEUR,
      remainingEUR: remaining(ctx.spentEUR, ctx.main.monthlyBudgetEUR),
      defaultEstimateEUR: 0.4,
    };
  }

  private today(): string {
    if (this.o.today) return this.o.today();
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  private async process(id: string): Promise<void> {
    const b = this.o.backend;
    if (!(await b.claim(id, this.owner))) return;
    try {
      for (let guard = 0; guard < 10; guard++) {
        const t = await b.task(id);
        switch (t.data.state) {
          case "received": {
            if (this.o.online && !this.o.online()) { await b.apply(id, { type: "wait", reason: "offline" }); return; }
            const engine = await this.o.engine();
            if (!engine) { await b.apply(id, { type: "wait", reason: "no model set up" }); return; }
            await b.apply(id, { type: "understand" });
            break;
          }
          case "understanding": {
            if (t.data.attempts >= MAX_PLAN_ATTEMPTS) {
              await b.fileNote(id, t.data.error ?? "no valid plan");
              return;
            }
            const engine = await this.o.engine();
            if (!engine) { await b.apply(id, { type: "wait", reason: "no model set up" }); return; }
            const ctx = await b.planningContext();
            let attempt;
            try {
              attempt = await planOnce(engine, t.data.input, { projects: ctx.projects, answers: t.data.answers, examples: ctx.examples, previousError: t.data.attempts > 0 ? t.data.error : undefined, today: this.today() }, this.abort.signal);
            } catch (e) {
              if (isAbort(e) || this.abort.signal.aborted) return;
              if (isOffline(e) || (this.o.online && !this.o.online())) { await b.apply(id, { type: "wait", reason: "offline" }); return; }
              // Engine-Fehler zählt wie eine ungültige Ausgabe: noch ein Versuch, dann als Notiz
              await b.apply(id, { type: "planInvalid", error: e instanceof Error ? e.message : String(e) });
              break;
            }
            if (attempt.usage.inputTokens + attempt.usage.outputTokens > 0) await b.addTaskUsage(id, attempt.usage, attempt.model);
            if (!attempt.parse.ok) {
              await b.apply(id, { type: "planInvalid", error: attempt.parse.error });
              break;
            }
            const r = assess(attempt.parse.plan, this.safety(ctx));
            await b.apply(id, { type: "planned", plan: attempt.parse.plan, decisions: r.decisions, next: r.next, ...(r.question ? { question: r.question } : {}), ...(r.proposal ? { proposal: r.proposal } : {}) });
            break;
          }
          case "executing":
            await b.execute(id);
            break;
          default:
            return;
        }
      }
    } finally {
      await b.release(id, this.owner).catch(() => undefined);
    }
  }
}
