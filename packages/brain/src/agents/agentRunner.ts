// BSD-160: Unteragenten und geplante Läufe. Jeder Lauf ist ein Run-Record (kind subagent | schedule); der Runner holt
// wartende Läufe (`queued`), übernimmt sie per Lease, lässt eine Engine mit den Workspace-Werkzeugen laufen und
// schreibt das Gespräch als Chat-Transkript (BSD-77), den Verbrauch (€ aus usage) und das Ergebnis an den Run.
// Budget: Überschreitet der Lauf seine Obergrenze oder das Monatsbudget des Agenten, wird er gestoppt.
// Berechtigungen: Modus + Regeln des Agenten, geschichtet mit dem Projekt; fragepflichtige Aufrufe warten als
// „Needs you“ am Run, bis jemand an der Karte erlaubt oder ablehnt.
// Zeitpläne laufen hier nur, solange die App offen ist (Server-Zeitpläne: später, nicht in diesem Branch).
import type { ChatEngine, ToolPolicy } from "../engine.js";
import { runTurn } from "../engine.js";
import type { StoredChatEvent } from "../events.js";
import type { ToolCall } from "../messages.js";
import { mayContinue, spentThisMonth } from "./budget.js";
import { mainArgument, Permissions, targetPage } from "./permissions.js";
import { PlanRecorder } from "../planmode.js";
import { fromMs, isRunFinished, MAIN_AGENT_ID, toMs, type AgentData, type ProjectData, type Rec, type RunData, type ScheduleData } from "./records.js";
import type { NewRun, RunPatch } from "./store.js";

export interface AgentRunBackend {
  runs(): Promise<Rec<RunData>[]>;
  claimRun(id: string, owner: string): Promise<boolean>;
  updateRun(id: string, patch: RunPatch): Promise<Rec<RunData> | undefined>;
  createRun(data: NewRun): Promise<Rec<RunData>>;
  main(): Promise<AgentData>;
  projects(): Promise<Rec<ProjectData>[]>;
  schedules(): Promise<Rec<ScheduleData>[]>;
  claimSchedule(id: string, nowMs: number): Promise<boolean>;
  chatCreate(title: string): Promise<{ id: string }>;
  chatSave(id: string, base: number, events: StoredChatEvent[]): Promise<unknown>;
  /** Update auf die Projektseite (Hauptagent schreibt Ergebnisse ins Projekt). */
  projectUpdate?(projectID: string, markdown: string): Promise<void>;
}

export interface AgentEngineRequest {
  model?: string | undefined;
  policy: ToolPolicy;
  /** BSD-250: Projekt des Laufs – sein Connection-Scope gilt zusätzlich zu dem des Agenten. */
  project?: ProjectData | undefined;
}

export interface PendingRunApproval {
  runID: string;
  call: ToolCall;
}

export interface AgentRunnerOptions {
  backend: AgentRunBackend;
  engine: (req: AgentEngineRequest) => Promise<ChatEngine | undefined> | ChatEngine | undefined;
  owner?: string;
  /** Höchstens so viele Läufe gleichzeitig (Standard 2). */
  concurrency?: number;
  now?: () => number;
  onChange?: () => void;
  /** Welche Werkzeuge schreiben (für „Ask before edits“). */
  isWrite?: (name: string) => boolean;
  /** BSD-245: Pfade einer Seite für Pfad-Regeln (`pagePathCandidates` dort, wo der Store liegt). */
  pathOf?: (pageID: string) => Promise<readonly string[]> | readonly string[];
}

export const SUBAGENT_SYSTEM = "You are a sub-agent of Based's main agent. Do the task below with the workspace tools, then reply with a short result (what you did, which pages). Stay within the task.";

export class AgentRunner {
  private readonly owner: string;
  private running = new Map<string, AbortController>();
  private approvals: { runID: string; call: ToolCall; resolve: (ok: boolean) => void }[] = [];

  constructor(private readonly o: AgentRunnerOptions) {
    this.owner = o.owner ?? "agents-" + Math.random().toString(36).slice(2, 10);
  }

  private now = () => (this.o.now ?? Date.now)();

  get pendingApprovals(): readonly PendingRunApproval[] {
    return this.approvals.map(({ runID, call }) => ({ runID, call }));
  }

  get activeRuns(): string[] {
    return [...this.running.keys()];
  }

  approve(runID: string, callID: string, ok: boolean) {
    const a = this.approvals.find((x) => x.runID === runID && x.call.id === callID);
    if (!a) return;
    this.approvals = this.approvals.filter((x) => x !== a);
    void this.o.backend.updateRun(runID, { status: "running" });
    a.resolve(ok);
    this.o.onChange?.();
  }

  /** Lauf abbrechen (Stop an der Karte, oder sein Record ist weg, z. B. nach Undo). */
  cancel(runID: string) {
    this.running.get(runID)?.abort();
  }

  /** Fällige Zeitpläne als Läufe anlegen, dann wartende Läufe starten. Aufruf z. B. alle 30 s. */
  async tick(): Promise<void> {
    await this.fireSchedules();
    const runs = await this.o.backend.runs();
    // abgebrochen/weg: laufende Engines stoppen
    for (const id of this.running.keys()) {
      const r = runs.find((x) => x.id === id);
      if (!r || r.data.status === "cancelled") this.cancel(id);
    }
    // Läufe, deren Prozess weg ist (App geschlossen/neu geladen): nicht blind wiederholen (Werkzeuge sind nicht
    // idempotent), sondern als unterbrochen melden.
    for (const r of runs) {
      if ((r.data.status !== "running" && r.data.status !== "needsYou") || this.running.has(r.id)) continue;
      const lease = r.data.lease;
      if (!lease || lease.owner === this.owner || toMs(lease.until) < this.now()) {
        await this.o.backend.updateRun(r.id, { status: "failed", result: "Interrupted — Based was closed while this ran.", lease: null });
      }
    }
    const queued = runs.filter((r) => r.data.status === "queued").sort((a, b) => a.data.startedAt - b.data.startedAt);
    const free = (this.o.concurrency ?? 2) - this.running.size;
    for (const r of queued.slice(0, Math.max(0, free))) void this.start(r.id);
  }

  async fireSchedules(): Promise<number> {
    const now = this.now();
    let fired = 0;
    for (const s of await this.o.backend.schedules()) {
      if (!s.data.enabled || s.data.nextAt === undefined) continue;
      if (!(await this.o.backend.claimSchedule(s.id, now))) continue;
      const main = await this.o.backend.main();
      const spent = spentThisMonth(await this.o.backend.runs(), s.data.agentID, now);
      const exhausted = main.monthlyBudgetEUR !== undefined && spent >= main.monthlyBudgetEUR;
      await this.o.backend.createRun({
        kind: "schedule", status: exhausted ? "cancelled" : "queued", agentID: s.data.agentID, title: s.name, scheduleID: s.id, instructions: s.data.prompt,
        ...(s.data.projectID ? { projectID: s.data.projectID } : {}), ...(s.data.taskID ? { taskID: s.data.taskID } : {}),
        ...(exhausted ? { result: `Skipped: monthly budget used up (${spent.toFixed(2)} € of ${main.monthlyBudgetEUR!.toFixed(2)} €)` } : {}),
      });
      fired += 1;
    }
    return fired;
  }

  /** Einen wartenden Lauf ausführen (wartet bis zum Ende). */
  async start(runID: string): Promise<void> {
    if (this.running.has(runID)) return;
    const b = this.o.backend;
    if (!(await b.claimRun(runID, this.owner))) return;
    const abort = new AbortController();
    this.running.set(runID, abort);
    this.o.onChange?.();
    // Lease erneuern, solange der Lauf lebt (sonst hielte ein anderer Tab ihn nach 5 min für unterbrochen)
    const renew = setInterval(() => void b.updateRun(runID, { lease: { owner: this.owner, until: fromMs(this.now()) + 300 } }).catch(() => undefined), 60_000);
    try {
      const run = (await b.runs()).find((r) => r.id === runID);
      if (!run) return;
      const main = await b.main();
      const projects = await b.projects();
      const project = run.data.projectID ? projects.find((p) => p.id === run.data.projectID) : undefined;
      const perms = Permissions.from(main.permissions.rules, main.permissions.mode).layered(project?.data.permissions);
      const plan = new PlanRecorder();
      const policy: ToolPolicy = {
        mode: perms.mode,
        rules: async (call) => {
          const target = targetPage(call.arguments);
          const paths = target && this.o.pathOf ? await Promise.resolve(this.o.pathOf(target)).catch(() => []) : undefined;
          return perms.ruleVerdict({ tool: "based." + call.name, argument: mainArgument(call.arguments), paths })?.effect;
        },
        // Plan-Modus: Schreibschritte sammeln; sie stehen danach im Ergebnis des Laufs.
        onPlanned: plan.record,
        approve: (call) => new Promise<boolean>((resolve) => {
          if (abort.signal.aborted) return resolve(false);
          this.approvals.push({ runID, call, resolve });
          void b.updateRun(runID, { status: "needsYou" });
          this.o.onChange?.();
        }),
      };
      const engine = await this.o.engine({ model: run.data.model, policy, ...(project ? { project: project.data } : {}) });
      if (!engine) {
        await b.updateRun(runID, { status: "failed", result: "No model is set up." });
        return;
      }
      const chat = await b.chatCreate(run.name || "Agent run");
      await b.updateRun(runID, { chatID: chat.id, model: engine.label });
      const spentBefore = spentThisMonth((await b.runs()).filter((r) => r.id !== runID), run.data.agentID ?? MAIN_AGENT_ID, this.now());
      const events: StoredChatEvent[] = [{ type: "userMessage", text: run.data.instructions ?? run.name, at: this.now() }];
      let cost = run.data.costEUR, stopReason: string | undefined, final = "", failed: string | undefined;
      const instructions = [SUBAGENT_SYSTEM, project ? `Project: ${project.name}${project.data.goal ? ` — goal: ${project.data.goal}` : ""}` : ""].filter(Boolean).join("\n");
      for await (const e of runTurn(engine, { prompt: run.data.instructions ?? run.name, system: instructions }, abort.signal)) {
        events.push(e);
        if (e.type === "usage") {
          const updated = await b.updateRun(runID, { addUsage: { inputTokens: e.inputTokens, outputTokens: e.outputTokens, costUSD: e.costUSD ?? 0 } });
          cost = updated?.data.costEUR ?? cost;
          const check = updated ? mayContinue(updated.data, spentBefore, main) : { ok: true as const };
          if (!check.ok) {
            stopReason = check.reason;
            abort.abort();
          }
        } else if (e.type === "text") final = final ? final + "\n\n" + e.text : e.text;
        else if (e.type === "failed" && !e.stopped) failed = e.message;
      }
      await b.chatSave(chat.id, 0, events).catch(() => undefined);
      const planned = plan.steps.length ? `\nPlanned (not run, plan mode): ${plan.steps.map((x) => x.name).join(", ")}` : "";
      const result = stopReason ? `Stopped: ${stopReason}` : failed ? failed : ((final.trim().slice(0, 280) || "Done") + planned);
      const stillThere = (await b.runs()).find((r) => r.id === runID);
      if (!stillThere || stillThere.data.status === "cancelled") return;
      await b.updateRun(runID, { status: stopReason || failed ? "failed" : abort.signal.aborted ? "cancelled" : "done", result, lease: null });
      if (project && b.projectUpdate && !failed) await b.projectUpdate(project.id, `**${run.name}** (${cost.toFixed(2)} €): ${result}`).catch(() => undefined);
    } catch (e) {
      await b.updateRun(runID, { status: "failed", result: e instanceof Error ? e.message : String(e), lease: null }).catch(() => undefined);
    } finally {
      clearInterval(renew);
      this.running.delete(runID);
      for (const a of this.approvals.filter((x) => x.runID === runID)) a.resolve(false);
      this.approvals = this.approvals.filter((x) => x.runID !== runID);
      this.o.onChange?.();
    }
  }
}

export const runIsActive = (r: RunData) => !isRunFinished(r.status);
