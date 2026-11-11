// BSD-195/196/160: der Hauptagent im Hauptthread. Aufträge und Runs liegen als Records im Store-Worker
// (worker/agents.ts); hier laufen Planer (TaskRunner) und Unteragenten/Zeitpläne (AgentRunner), weil Engine und
// API-Schlüssel nur im Hauptthread leben. Zeitpläne laufen nur, solange die App offen ist.
// Haken für Tests/E2E (`globalThis.__basedTasks`): Scripted-Planer (Regeln) und Skripte für Unteragenten statt echter
// Modelle – deterministisch, ohne Netz.
import {
  AgentRunner, combineToolHosts, RulesPlannerEngine, ScriptedEngine, TaskRunner,
  type AgentData, type AgentRunBackend, type ChatEngine, type PlanningContext, type ScriptStep, type TaskBackend, type TaskView, type ToolHost,
} from "@based/brain";
import { aiConfig, splitModelRef, type AiConfig } from "../chat/aiConfig.js";
import type { StoreClient } from "../worker/client.js";
import { mcpRuntime } from "../chat/mcp.js";
import type { ToolCatalog } from "../worker/chat.js";

export function clientTaskBackend(client: StoreClient): TaskBackend {
  const q = client.agents.bind(client);
  return {
    createTask: (input, o) => q<TaskView>({ op: "createTask", input, ...(o?.id ? { id: o.id } : {}), ...(o?.source ? { source: o.source } : {}) }),
    tasks: () => q<TaskView[]>({ op: "tasks" }),
    task: (id) => q<TaskView>({ op: "task", id }),
    apply: (id, event) => q<TaskView>({ op: "apply", id, event }),
    claim: (id, owner, ttl) => q<boolean>({ op: "claim", id, owner, ...(ttl ? { ttl } : {}) }),
    release: (id, owner) => q<void>({ op: "release", id, owner }),
    addTaskUsage: (id, usage, model) => q<void>({ op: "addTaskUsage", id, usage, ...(model ? { model } : {}) }),
    execute: (id, confirmed) => q<TaskView>({ op: "execute", id, ...(confirmed ? { confirmed } : {}) }),
    undo: (id) => q<TaskView>({ op: "undo", id }),
    fileNote: (id, reason, dismiss) => q<TaskView>({ op: "fileNote", id, reason, ...(dismiss ? { dismiss } : {}) }),
    planningContext: () => q<PlanningContext>({ op: "planningContext" }),
    addExample: (example) => q<void>({ op: "addExample", example }),
  };
}

export function clientRunBackend(client: StoreClient): AgentRunBackend {
  const q = client.agents.bind(client);
  return {
    runs: () => q({ op: "runs" }),
    claimRun: (id, owner) => q({ op: "claimRun", id, owner }),
    updateRun: (id, patch) => q({ op: "updateRun", id, patch }),
    createRun: (data) => q({ op: "createRun", data }),
    main: () => q({ op: "main" }),
    projects: () => q({ op: "projects" }),
    schedules: () => q({ op: "schedules" }),
    claimSchedule: (id, nowMs) => q({ op: "claimSchedule", id, nowMs }),
    chatCreate: (title) => client.chatCreate(title),
    chatSave: (id, base, events) => client.chatSave(id, base, events),
    projectUpdate: (id, markdown) => q({ op: "projectUpdate", id, markdown }),
  };
}

export interface TasksUiState {
  /** Unteragenten, die gerade in diesem Tab laufen. */
  active: readonly string[];
  /** Freigaben, auf die ein Unteragent wartet. */
  approvals: readonly { runID: string; callID: string; name: string; input: unknown }[];
  /** Ein Planer ist bereit (Modell eingerichtet oder Scripted). */
  ready: boolean;
}

export class TasksRuntime {
  readonly runner: TaskRunner;
  readonly agents: AgentRunner;
  private plannerOverride: (() => ChatEngine) | undefined;
  private agentOverride: ((policy: Parameters<ConstructorParameters<typeof AgentRunner>[0]["engine"]>[0]) => ChatEngine) | undefined;
  private onlineOverride: boolean | undefined;
  private catalog: Promise<ToolCatalog> | undefined;
  private listeners = new Set<() => void>();
  private state: TasksUiState = { active: [], approvals: [], ready: false };
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;

  constructor(private readonly client: StoreClient, private readonly config: AiConfig = aiConfig()) {
    const online = () => this.onlineOverride ?? (typeof navigator === "undefined" ? true : navigator.onLine !== false);
    const owner = tabOwner();
    this.runner = new TaskRunner({ backend: clientTaskBackend(client), engine: () => this.plannerEngine(), online, owner, onError: (e) => console.warn("main agent:", e) });
    this.agents = new AgentRunner({
      backend: clientRunBackend(client), engine: (req) => this.agentEngine(req), owner: owner + "-agents", onChange: () => this.refresh(),
      pathOf: (id) => client.chatPagePaths(id), // BSD-245: Pfad-Regeln
    });
    this.state = { ...this.state, ready: this.isReady() };
    config.subscribe(() => {
      this.refresh();
      if (this.started) void this.runner.resume();
    });
  }

  getState = (): TasksUiState => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private refresh() {
    this.state = {
      active: this.agents.activeRuns,
      approvals: this.agents.pendingApprovals.map((a) => ({ runID: a.runID, callID: a.call.id, name: a.call.name, input: a.call.arguments })),
      ready: this.isReady(),
    };
    for (const fn of this.listeners) fn();
  }

  private isReady() {
    return this.plannerOverride !== undefined || this.config.activeModel() !== undefined;
  }

  /** Einmal nach dem Start des Stores: Stand laden, offene Aufträge fortsetzen, Zeitpläne/Unteragenten prüfen. */
  start() {
    if (this.started) return;
    this.started = true;
    void this.client.agentSnapshot().catch(() => undefined);
    void this.runner.resume();
    void this.agents.tick();
    // abgelaufene Leases (anderer Tab geschlossen) und fällige Zeitpläne
    this.timer = setInterval(() => {
      void this.agents.tick();
      void this.runner.resume();
    }, 30_000);
    if (typeof window !== "undefined") window.addEventListener("online", () => void this.runner.resume());
    // neue wartende Unteragenten (aus einem Plan) sofort starten
    let queued = "";
    this.client.subscribe(() => {
      const ids = (this.client.getState().agents?.runs ?? []).filter((r) => r.data.status === "queued").map((r) => r.id).join(",");
      if (ids && ids !== queued) void this.agents.tick();
      queued = ids;
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.started = false;
  }

  submit(text: string) {
    return this.runner.submit(text, { source: "composer" });
  }

  // MARK: Engines

  private async plannerEngine(): Promise<ChatEngine | undefined> {
    if (this.plannerOverride) return this.plannerOverride();
    const main = await this.client.agents<{ model?: string }>({ op: "main" }).catch(() => ({} as { model?: string }));
    return this.modelEngine(main.model, undefined, 1500);
  }

  private toolHost(): ToolHost {
    this.catalog ??= this.client.chatToolSpecs();
    let specs: ToolCatalog | undefined;
    void this.catalog.then((c) => { specs = c; });
    return {
      get specs() { return specs?.specs ?? []; },
      isWrite: (n) => specs?.write.includes(n) ?? true,
      call: (name, input) => this.client.chatTool(name, input),
    };
  }

  private async agentEngine(req: { model?: string | undefined; policy: Parameters<ConstructorParameters<typeof AgentRunner>[0]["engine"]>[0]["policy"] }): Promise<ChatEngine | undefined> {
    if (this.agentOverride) return this.agentOverride(req);
    const base = this.toolHost();
    await this.catalog?.catch(() => undefined);
    // BSD-222: Werkzeuge der MCP-Connections, die für Agenten freigegeben sind (und für den Hauptagenten erlaubt).
    const mcp = mcpRuntime(this.client);
    await mcp.ready();
    const main = await this.client.agents<AgentData>({ op: "main" }).catch(() => undefined);
    const extra = mcp.tools(main ? { agent: main } : { agent: { v: 1, kind: "main", permissions: { mode: "askEdits", rules: "" } } });
    const tools = extra ? combineToolHosts(base, extra) : base;
    return this.modelEngine(req.model, { tools, policy: req.policy });
  }

  /** ModelEngine für ein Modell („anbieter/modell“ aus den Einstellungen), sonst das aktive Chat-Modell. */
  private async modelEngine(ref: string | undefined, extra?: { tools: ToolHost; policy: Parameters<ConstructorParameters<typeof AgentRunner>[0]["engine"]>[0]["policy"] }, maxTokens?: number): Promise<ChatEngine | undefined> {
    const models = this.config.models().filter((m) => m.usable);
    const wanted = ref ? models.find((m) => m.ref === ref || (splitModelRef(ref) === undefined && m.model === ref)) : undefined;
    const choice = wanted ?? this.config.activeModel();
    if (!choice) return undefined;
    // BSD-257: ChatGPT (Codex) läuft als Sitzung auf dem Server; API-Modelle als ModelEngine.
    return this.config.engine(choice, { ...(extra ? { tools: extra.tools, policy: extra.policy } : {}), maxTokensPerReply: maxTokens });
  }

  // MARK: Tests/E2E

  installTestHook() {
    (globalThis as { __basedTasks?: unknown }).__basedTasks = {
      runtime: this,
      /** Scripted-Planer (Regeln, DE/EN) statt eines Modells; `delayMs` hält „Understanding“ sichtbar. */
      useRules: (delayMs = 0) => {
        this.plannerOverride = () => new RulesPlannerEngine({ delayMs });
        this.refresh();
        void this.runner.resume();
      },
      /** Skript für Unteragenten (ein Turn). */
      useAgentScript: (script: ScriptStep[], delayMs = 0) => {
        this.agentOverride = (req) => new ScriptedEngine({ script, tools: this.toolHost(), policy: req.policy, delayMs });
      },
      useModel: () => {
        this.plannerOverride = undefined;
        this.agentOverride = undefined;
        this.refresh();
      },
      setOnline: (on: boolean | undefined) => {
        this.onlineOverride = on;
        if (on !== false) void this.runner.resume();
      },
    };
  }
}

/** Kennung dieses Browser-Tabs für Leases: überlebt Neuladen (sessionStorage), damit ein Auftrag, der beim Neuladen
 *  mitten in der Arbeit war, sofort weiterläuft statt auf das Ablaufen der eigenen Lease zu warten. */
function tabOwner(): string {
  const fresh = "tab-" + Math.random().toString(36).slice(2, 10);
  try {
    const s = globalThis.sessionStorage;
    const v = s?.getItem("based.tasks.owner");
    if (v) return v;
    s?.setItem("based.tasks.owner", fresh);
  } catch {
    // ohne sessionStorage: neue Kennung je Start
  }
  return fresh;
}

let shared: TasksRuntime | undefined;
export function tasksRuntime(client: StoreClient): TasksRuntime {
  if (!shared) {
    shared = new TasksRuntime(client);
    shared.installTestHook();
  }
  return shared;
}
