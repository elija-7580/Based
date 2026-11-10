// BSD-159: Zustand des Chats im Hauptthread – ein Objekt für Panel und Vollseite. Hält den offenen Chat (Ereignisse
// aus dem Store-Worker), lässt Turns über eine Engine laufen (ein ChatEvent-Strom, ADR 0005), reiht Nachrichten
// während einer laufenden Antwort ein (PromptQueue), speichert den laufenden Turn gedrosselt als Records (BSD-77)
// und fragt bei Schreib-Werkzeugen nach Freigabe (Permission-Pille). Ohne DOM, damit es in Vitest läuft.
import {
  combineToolHosts, foldTranscript, historyFromEvents, ModelEngine, PlanRecorder, PromptQueue, runPlan, runTurn,
  type PlannedStep, type RuleEffect,
  type AIProvider, type ChatEngine, type ChatEvent, type ChatInfo, type PermissionMode, type QueuedPrompt, type RunningTurn, type StoredChatEvent, type ToolCall, type ToolHost, type ToolPolicy,
} from "@based/brain";
import type { JSONValue } from "@based/core";
import type { ChatLoaded, ToolCatalog } from "../worker/chat.js";
import type { AiConfig } from "./aiConfig.js";

/** Was der Controller vom Store-Client braucht (StoreClient; in Tests ein Fake). */
export interface ChatBackend {
  chatList(): Promise<ChatInfo[]>;
  chatCreate(title?: string): Promise<ChatInfo>;
  chatLoad(id: string): Promise<ChatLoaded>;
  chatSave(id: string, base: number, events: StoredChatEvent[]): Promise<{ events: number }>;
  chatDelete(id: string): Promise<void>;
  chatToolSpecs(): Promise<ToolCatalog>;
  chatTool(name: string, input: JSONValue): Promise<{ text: string; isError: boolean }>;
}

export interface EngineContext {
  tools: ToolHost;
  policy: ToolPolicy;
}

/** Baut die Engine für einen Turn; `undefined` = kein Modell eingerichtet. */
export type EngineFactory = (ctx: EngineContext) => Promise<ChatEngine | undefined> | ChatEngine | undefined;

export interface PendingApproval {
  call: ToolCall;
  resolve: (ok: boolean) => void;
}

export interface ChatViewState {
  chatID: string | undefined;
  /** Ereignisse des offenen Chats (gespeichert + laufender Turn). */
  events: StoredChatEvent[];
  loading: boolean;
  running: boolean;
  waiting: readonly QueuedPrompt<string>[];
  approvals: readonly PendingApproval[];
  /** Fehler außerhalb eines Turns (Laden, Speichern). */
  error: string | undefined;
  /** Ein Engine-Override ist aktiv (Tests) oder ein Modell eingerichtet. */
  ready: boolean;
  /** BSD-245: im Plan-Modus gesammelte Schritte des letzten Turns (bis „Run plan“ oder „Dismiss“). */
  plan: { chatID: string; steps: PlannedStep[] } | undefined;
}

/** BSD-245: Regeln (global, Pfade) für Werkzeugaufrufe im Chat; je Turn neu geholt. */
export type ChatRules = (call: ToolCall) => RuleEffect | undefined | Promise<RuleEffect | undefined>;

const EMPTY: ChatViewState = { chatID: undefined, events: [], loading: false, running: false, waiting: [], approvals: [], error: undefined, ready: false, plan: undefined };

/** Wo die Engine eines Turns ihr Modell aufruft (für Privacy-Redact: lokale Modelle brauchen keins). */
export type TurnReach = "external" | "local" | "cli";

/** Was ein Hook vor dem Turn beisteuert (Agent Brain: Skills, Redact – apps/web/src/brain/turn.ts). */
export interface TurnPrep {
  /** Zusatz fürs System-Prompt. */
  system?: string;
  /** Ereignisse direkt nach der Nutzer-Nachricht (z. B. gewählte Skills; unbekannte Typen bleiben im Transkript). */
  events?: StoredChatEvent[];
  /** Engine ohne Anbieter-Schnittstelle einhüllen (ScriptedEngine, später CLIs). */
  wrapEngine?: (engine: ChatEngine) => ChatEngine;
  /** Anbieter einhüllen (ModelEngine: sitzt vor JEDEM Modellaufruf, auch für Tool-Ergebnisse). */
  wrapProvider?: (provider: AIProvider) => AIProvider;
  /** Ereignisse am Ende des Turns (z. B. „n details redacted“). */
  finish?: () => StoredChatEvent[];
}

export interface TurnContext {
  chatID: string;
  reach: TurnReach;
  signal: AbortSignal;
}

export interface TurnHooks {
  prepare?: (text: string, ctx: TurnContext) => Promise<TurnPrep | undefined>;
  /** Nach dem Turn (gespeichert): weitere Ereignisse, die angehängt werden (Memory-Vorschläge). */
  after?: (turn: readonly StoredChatEvent[], ctx: { chatID: string; complete: (system: string, prompt: string) => Promise<string> }) => Promise<StoredChatEvent[] | undefined>;
  /** Zusätzliche Werkzeuge (Agent Brain). */
  tools?: () => ToolHost | undefined;
}

export interface ChatControllerOptions {
  backend: ChatBackend;
  config?: AiConfig | undefined;
  /** Gespeichert wird höchstens so oft (ms) während eines Turns; das Ende immer sofort. */
  saveEveryMs?: number;
  fetch?: typeof globalThis.fetch;
  /** BSD-160: nach jedem Turn (gespeichert) – z. B. als Run-Record mit Verbrauch. */
  onTurnEnd?: (turn: { chatID: string; prompt: string; events: readonly StoredChatEvent[] }) => void;
  /** BSD-245: Regeln für den Turn (Einstellungen → Main agent, mit Pfad-Regeln); ohne: nur der Modus. */
  rules?: () => Promise<ChatRules | undefined>;
}

export class ChatController {
  /** Haken für das Agent Brain (Skills, Redact, Memories); ohne bleibt der Chat wie er ist. */
  hooks: TurnHooks = {};
  private state: ChatViewState = EMPTY;
  private listeners = new Set<() => void>();
  private readonly queue: PromptQueue<string>;
  private override: EngineFactory | undefined;
  private catalog: Promise<ToolCatalog> | undefined;
  private saving: Promise<unknown> = Promise.resolve();
  private readonly saveEveryMs: number;
  /** Erhöht sich bei jedem Chatwechsel: ein Turn im Hintergrund schreibt nicht mehr in die Anzeige. */
  private view = 0;
  /** Gespeicherte Ereignisse je Chat (verdichtet – nicht dasselbe wie die angezeigten mit allen Deltas). */
  private stored = new Map<string, number>();

  constructor(private readonly o: ChatControllerOptions) {
    this.saveEveryMs = o.saveEveryMs ?? 400;
    this.queue = new PromptQueue<string>((text) => this.startTurn(text));
    this.queue.onChange = () => this.set({ waiting: this.queue.waiting, running: this.queue.isBusy });
    o.config?.subscribe(() => this.set({ ready: this.isReady() }));
    this.state = { ...EMPTY, ready: this.isReady() };
  }

  getState = (): ChatViewState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<ChatViewState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private isReady(): boolean {
    return this.override !== undefined || this.o.config?.activeModel() !== undefined;
  }

  /** Engine für Tests/E2E/Vorführungen (ScriptedEngine); `undefined` = wieder das eingestellte Modell. */
  setEngineFactory(f: EngineFactory | undefined) {
    this.override = f;
    this.set({ ready: this.isReady() });
  }

  // MARK: Chats

  /** Einen gespeicherten Chat öffnen. Eine laufende Antwort im alten Chat läuft im Hintergrund zu Ende und wird gespeichert. */
  async open(id: string): Promise<void> {
    if (id === this.state.chatID && !this.state.error) return;
    this.queue.detach();
    const v = ++this.view;
    this.set({ chatID: id, events: [], loading: true, error: undefined, approvals: [], running: false });
    try {
      const loaded = await this.o.backend.chatLoad(id);
      if (v !== this.view) return;
      this.stored.set(id, loaded.events.length);
      this.set({ events: loaded.events, loading: false });
    } catch (e) {
      if (v !== this.view) return;
      this.set({ loading: false, error: message(e) });
    }
  }

  /** Neuer, leerer Chat (wird erst beim ersten Senden angelegt). */
  newChat() {
    this.queue.detach();
    this.view += 1;
    this.set({ chatID: undefined, events: [], loading: false, error: undefined, approvals: [], running: false });
  }

  async remove(id: string): Promise<void> {
    await this.o.backend.chatDelete(id);
    if (this.state.chatID === id) this.newChat();
  }

  // MARK: Senden

  /** Nachricht senden – sofort, oder eingereiht, wenn gerade eine Antwort läuft. */
  send(text: string): string | undefined {
    const t = text.trim();
    if (!t) return undefined;
    return this.queue.submit(t, t);
  }

  stop() {
    this.queue.stopCurrent();
  }

  removeQueued(id: string) {
    this.queue.remove(id);
  }

  sendNow(id: string) {
    this.queue.sendNow(id);
  }

  /** Die letzte Nachricht nach einem Fehler noch einmal schicken. */
  retry() {
    const last = [...this.state.events].reverse().find((e) => e.type === "userMessage") as Extract<ChatEvent, { type: "userMessage" }> | undefined;
    if (last) this.send(last.text);
  }

  /**
   * BSD-245: den gesammelten Plan ausführen (das ist die Freigabe): Schritte laufen der Reihe nach, Regeln gelten
   * weiter (deny blockiert), danach zurück in den Modus vor dem Plan. Jeder Schritt wird eine Werkzeug-Karte.
   */
  async runPlan(): Promise<void> {
    const plan = this.state.plan;
    if (!plan || plan.chatID !== this.state.chatID || this.state.running) return;
    this.set({ plan: undefined });
    const rules = await this.o.rules?.().catch(() => undefined);
    const events: StoredChatEvent[] = [];
    const host = this.toolHost();
    await this.catalog?.catch(() => undefined);
    const results = await runPlan(host, plan.steps, { rules }, new AbortController().signal, (e) => events.push(e));
    const failed = results.filter((r) => r.result.isError).length;
    events.push({ type: "notice", text: `Ran the plan: ${results.length} ${results.length === 1 ? "step" : "steps"}${failed ? `, ${failed} failed` : ""}.` });
    this.o.config?.leavePlan();
    await this.appendEvents(events);
  }

  /** BSD-245: den gesammelten Plan verwerfen (nichts wird ausgeführt). */
  dismissPlan() {
    if (this.state.plan) this.set({ plan: undefined });
  }

  /** Antwort auf eine Freigabe-Anfrage. */
  answer(callID: string, ok: boolean) {
    const a = this.state.approvals.find((x) => x.call.id === callID);
    if (!a) return;
    this.set({ approvals: this.state.approvals.filter((x) => x !== a) });
    a.resolve(ok);
  }

  private toolHost(): ToolHost {
    this.catalog ??= this.o.backend.chatToolSpecs();
    const catalog = this.catalog;
    let specs: ToolCatalog | undefined;
    void catalog.then((c) => { specs = c; });
    const base: ToolHost = {
      get specs() { return specs?.specs ?? []; },
      isWrite: (n) => specs?.write.includes(n) ?? true,
      call: (name, input) => this.o.backend.chatTool(name, input),
    };
    const extra = this.hooks.tools?.();
    return extra ? combineToolHosts(base, extra) : base;
  }

  private async engine(ctx: EngineContext, prep?: TurnPrep, system?: string): Promise<ChatEngine | undefined> {
    if (this.override) {
      const e = await this.override(ctx);
      return e && prep?.wrapEngine ? prep.wrapEngine(e) : e;
    }
    const cfg = this.o.config;
    const choice = cfg?.activeModel();
    if (!cfg || !choice) return undefined;
    let provider = await cfg.provider(choice, this.o.fetch);
    if (prep?.wrapProvider) provider = prep.wrapProvider(provider);
    return new ModelEngine({ provider, model: choice.model, tools: ctx.tools, policy: ctx.policy, ...(system ? { system } : {}) });
  }

  /** Wohin das eingestellte Modell spricht. */
  reach(): TurnReach {
    if (this.override) return "external";
    const choice = this.o.config?.activeModel();
    if (!choice) return "external";
    if (choice.kind === "ollama") return "local";
    const base = this.o.config?.getState().settings.providers[choice.kind]?.baseURL ?? "";
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base) ? "local" : "external";
  }

  /**
   * BSD-225: Text für den Editor („Ask AI“) – ein Turn ohne Werkzeuge mit der Test-Engine (falls gesetzt) oder dem
   * eingestellten Modell. Liefert den Text der letzten Antwort; ohne Modell oder bei Fehler: Ausnahme.
   */
  /** Gibt es etwas, das antworten kann (Test-Engine oder eingestelltes Modell)? */
  canWrite(): boolean {
    return !!this.override || !!this.o.config?.activeModel();
  }

  async write(system: string, prompt: string, signal: AbortSignal): Promise<string> {
    const tools: ToolHost = { specs: [], isWrite: () => false, call: async () => ({ text: "No tools here.", isError: true }) };
    const policy: ToolPolicy = { mode: "ask" };
    const engine = this.override ? await this.override({ tools, policy }) : undefined;
    if (!engine) {
      if (this.override) throw new Error("No model is set up.");
      const cfg = this.o.config;
      const choice = cfg?.activeModel();
      if (!cfg || !choice) throw new Error("No model is set up. Add a provider and a model in Settings → Agents & AI.");
      const provider = await cfg.provider(choice, this.o.fetch);
      const r = await provider.stream([{ role: "system", content: system }, { role: "user", content: prompt }], { model: choice.model, tools: [], maxTokens: 2048, signal });
      return r.message.content;
    }
    let text = "";
    for await (const e of runTurn(engine, { prompt, system }, signal)) {
      if (e.type === "text") text = (e as Extract<ChatEvent, { type: "text" }>).text;
      else if (e.type === "failed") throw new Error((e as Extract<ChatEvent, { type: "failed" }>).message);
    }
    return text;
  }

  /** Ein einzelner Modellaufruf ohne Werkzeuge (Memory-Vorschläge). Ohne Modell: Fehler. */
  private async complete(system: string, prompt: string, wrap?: (p: AIProvider) => AIProvider): Promise<string> {
    const cfg = this.o.config;
    const choice = cfg?.activeModel();
    if (!cfg || !choice) throw new Error("No model is set up.");
    let provider = await cfg.provider(choice, this.o.fetch);
    if (wrap) provider = wrap(provider);
    const r = await provider.stream([{ role: "system", content: system }, { role: "user", content: prompt }], { model: choice.model, tools: [], maxTokens: 1024 });
    return r.message.content;
  }

  /** Ereignisse an den offenen Chat anhängen (z. B. Entscheidung über einen Memory-Vorschlag). */
  async appendEvents(events: StoredChatEvent[]): Promise<void> {
    const id = this.state.chatID;
    if (!id || events.length === 0) return;
    await this.saving;
    const base = this.stored.get(id) ?? (await this.o.backend.chatLoad(id)).events.length;
    const r = await this.o.backend.chatSave(id, base, events);
    this.stored.set(id, r.events);
    if (this.state.chatID === id) this.set({ events: [...this.state.events, ...events] });
  }

  private permission(): PermissionMode {
    return this.o.config?.getState().settings.permission ?? "askEdits";
  }

  private startTurn(text: string): RunningTurn {
    const abort = new AbortController();
    const v = this.view;
    const done = this.runTurn(text, abort.signal, v).catch((e: unknown) => {
      if (v === this.view) this.set({ error: message(e) });
    });
    return {
      done,
      cancel: () => {
        abort.abort();
        // offene Freigaben dieses Turns gelten als abgelehnt
        for (const a of this.state.approvals) a.resolve(false);
        if (v === this.view) this.set({ approvals: [] });
      },
    };
  }

  private async runTurn(text: string, signal: AbortSignal, v: number): Promise<void> {
    const live = () => v === this.view;
    let chatID = this.state.chatID;
    if (!chatID) {
      const info = await this.o.backend.chatCreate();
      chatID = info.id;
      if (live()) this.set({ chatID });
    }
    const id = chatID;
    // Ereignisse vor diesem Turn: so viele, wie gespeichert sind (der Turn schreibt nur seinen Teil neu).
    let before = live() ? this.state.events : undefined;
    let base = this.stored.get(id);
    if (!before || base === undefined) {
      const loaded = (await this.o.backend.chatLoad(id)).events;
      base = loaded.length;
      before ??= loaded;
    }
    const prior = before;
    const start = base;
    const turn: StoredChatEvent[] = [{ type: "userMessage", text, at: Date.now() }];
    const show = () => {
      if (live()) this.set({ events: [...prior, ...turn], error: undefined });
    };
    show();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      const snapshot = [...turn];
      this.saving = this.saving.then(async () => {
        const r = await this.o.backend.chatSave(id, start, snapshot);
        this.stored.set(id, r.events);
      }).catch((e: unknown) => {
        if (live()) this.set({ error: "Couldn't save this chat: " + message(e) });
      });
      return this.saving;
    };
    const scheduleSave = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void save();
      }, this.saveEveryMs);
    };
    await save();

    const plan = new PlanRecorder();
    const rules = await this.o.rules?.().catch(() => undefined);
    const policy: ToolPolicy = {
      mode: this.permission(),
      approve: (call) => new Promise<boolean>((resolve) => {
        if (signal.aborted) return resolve(false);
        this.set({ approvals: [...this.state.approvals, { call, resolve }] });
      }),
      rules,
      onPlanned: plan.record,
    };
    const tools = this.toolHost();
    await this.catalog?.catch(() => undefined);
    let prep: TurnPrep | undefined;
    try {
      prep = await this.hooks.prepare?.(text, { chatID: id, reach: this.reach(), signal });
    } catch (e) {
      turn.push({ type: "notice", text: "Skills and privacy checks were skipped: " + message(e) });
    }
    if (prep?.events?.length) {
      turn.push(...prep.events);
      show();
    }
    let engine: ChatEngine | undefined;
    try {
      engine = await this.engine({ tools, policy }, prep, undefined);
    } catch (e) {
      turn.push({ type: "failed", message: message(e) });
    }
    if (!engine && !turn.some((e) => e.type === "failed")) turn.push({ type: "failed", message: "No model is set up. Add a provider and a model in the chat settings." });
    if (engine) {
      const history = historyFromEvents(prior);
      const request = prep?.system ? { prompt: text, history, system: prep.system } : { prompt: text, history };
      // Hängt ein Hook Ereignisse an, kommen sie nach dem Turn-Ende – damit nichts in die Antwort fällt.
      let ended = false;
      for await (const e of runTurn(engine, request, signal)) {
        turn.push(e);
        if (e.type === "result" || e.type === "failed") ended = true;
        show();
        scheduleSave();
      }
      const extra = ended ? prep?.finish?.() ?? [] : [];
      if (extra.length > 0) turn.push(...extra);
    }
    if (timer) clearTimeout(timer);
    timer = undefined;
    show();
    await save();
    if (engine) this.o.onTurnEnd?.({ chatID: id, prompt: text, events: turn });
    if (plan.steps.length > 0 && live()) this.set({ plan: { chatID: id, steps: plan.steps } });
    if (engine && !signal.aborted && this.hooks.after) {
      const more = await this.hooks.after(turn, { chatID: id, complete: (sys, p) => this.complete(sys, p, prep?.wrapProvider) }).catch(() => undefined);
      if (more?.length && live()) await this.appendEvents(more).catch(() => undefined);
    }
  }
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Summen und Turns des offenen Chats (für die Anzeige). */
export const transcriptOf = (events: readonly StoredChatEvent[]) => foldTranscript(events);
