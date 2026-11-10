// BSD-159 / ADR 0005: die ChatEngine – jede Engine liefert denselben ChatEvent-Strom als AsyncIterable, abbrechbar
// per AbortSignal. `ModelEngine` ist die Tool-Schleife für API-Modelle (Swift `AgentRuntime.run`): streamt, führt
// Werkzeuge aus, setzt abgeschnittene Antworten fort und verdichtet den Kontext. `ScriptedEngine` spielt ein Skript
// ab (Tests, E2E). `runTurn` macht aus jedem Lauf einen sauberen Turn mit genau einem Ende (`result` oder `failed`).
import type { JSONValue } from "@based/core";
import { compactionChanged, compactionNotice, ContextBudget } from "./context.js";
import type { ChatEvent } from "./events.js";
import { AbortError, isAbort, isTruncated, type AIProvider, type AIResponse, type ChatMessage, type ToolCall, type ToolSpec } from "./messages.js";
import { estimateCost } from "./pricing.js";

// MARK: Schnittstellen

/** Alles, was eine Engine für einen Turn braucht. */
export interface ChatRequest {
  /** Die Nachricht des Nutzers. */
  prompt: string;
  /** Frühere Turns (aus dem Transkript, siehe `historyFromEvents`). */
  history?: readonly ChatMessage[];
  /** Zusätzliches System-Prompt (Agent-Anweisungen). */
  system?: string;
}

export interface ChatEngine {
  /** Kurzer Name für die Oberfläche („anthropic/claude-…“, „Scripted“). */
  readonly label: string;
  /** Ein Turn: Ereignisse in Engine-Reihenfolge. Abbruch über `signal` beendet den Strom (ggf. mit AbortError). */
  run(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

/** Wo Werkzeuge laufen (im Web: im Store-Worker). */
export interface ToolHost {
  readonly specs: readonly ToolSpec[];
  /** Ändert das Werkzeug etwas im Workspace? (für „Ask before edits“) */
  isWrite(name: string): boolean;
  call(name: string, input: JSONValue, signal?: AbortSignal): Promise<ToolResult>;
}

/** Permission-Pille: jede Aktion fragen · vor Änderungen fragen · frei arbeiten. */
export type PermissionMode = "ask" | "askEdits" | "free";

export interface ToolPolicy {
  mode: PermissionMode;
  /** Fragt den Nutzer (Karte im Chat). Fehlt sie, werden fragepflichtige Aufrufe abgelehnt. */
  approve?: ((call: ToolCall) => Promise<boolean>) | undefined;
}

/** Tool-Ausgabe im Ereignis (Transkript): vollständig bis 64 kB, darüber gekürzt (BSD-77; Auslagern als Asset fehlt noch). */
export const TOOL_OUTPUT_EVENT_LIMIT = 64_000;
/** Tool-Ausgabe an das Modell (Swift: 24 000 Zeichen). */
export const TOOL_OUTPUT_MODEL_LIMIT = 24_000;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n[… ${s.length - n} more characters not shown]` : s);

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener("abort", onAbort); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

/** Ein Werkzeug ausführen: erst Permission (Modus, ggf. Nutzer fragen), dann der Aufruf. Wirft nur bei Abbruch. */
export async function executeTool(host: ToolHost, call: ToolCall, policy: ToolPolicy, signal: AbortSignal, emit: (e: ChatEvent) => void): Promise<ToolResult> {
  const known = host.specs.some((s) => s.name === call.name);
  if (!known) return { text: `Unknown tool ${call.name}`, isError: true };
  const needsAsk = policy.mode === "ask" || (policy.mode === "askEdits" && host.isWrite(call.name));
  if (needsAsk) {
    if (!policy.approve) return { text: "This action needs the user's approval, and nobody can be asked right now.", isError: true };
    emit({ type: "permissionRequest", id: call.id, name: call.name });
    const ok = await raceAbort(policy.approve(call), signal);
    if (!ok) return { text: "The user declined this action.", isError: true };
  }
  try {
    return await raceAbort(host.call(call.name, call.arguments, signal), signal);
  } catch (e) {
    if (signal.aborted || isAbort(e)) throw new AbortError();
    return { text: e instanceof Error ? e.message : String(e), isError: true };
  }
}

// MARK: Kanal (Callback → AsyncIterable, eine Quelle, Reihenfolge bleibt)

class EventChannel<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiter: (() => void) | undefined;
  private ended = false;
  private error: unknown;

  push(v: T) {
    if (this.ended) return;
    this.queue.push(v);
    this.wake();
  }
  close(error?: unknown) {
    if (this.ended) return;
    this.ended = true;
    this.error = error;
    this.wake();
  }
  private wake() {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.ended) {
        if (this.error !== undefined) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => { this.waiter = resolve; });
    }
  }
}

// MARK: ModelEngine

export const BASED_SYSTEM_PROMPT = `You are Based, the user's personal workspace assistant. You work inside their notes (pages and databases) using tools. Prefer reading existing content before creating new pages. Keep answers concise.

Based is a Notion-like workspace (pages, blocks, databases). Pages are read and written as Markdown.
- Find pages with \`search\` or \`list_pages\`, read them with \`read_page\` (ids are UUIDs; links look like based://page/<id>).
- Create with \`create_page\`, add content with \`append_markdown\`, change a passage with \`find_replace\`; use \`replace_page_content\` only when the user wants a rewrite.
- Databases: \`list_databases\` shows ids and properties, \`query_database\` the rows, \`add_row\` / \`update_row\` set properties by name.`;

export const CONTINUE_PROMPT = "Your reply was cut off by the length limit. Continue exactly where you stopped — no repetition, no preamble.";
const SUMMARY_PROMPT = "Summarize this earlier part of a conversation between the user and their assistant in at most 250 words. Keep facts, decisions, names, ids of pages and open tasks. Write in the conversation's language. Reply with the summary only.";

export interface ModelEngineOptions {
  provider: AIProvider;
  model: string;
  tools?: ToolHost | undefined;
  policy?: ToolPolicy | undefined;
  /** Basis-System-Prompt (Standard: `BASED_SYSTEM_PROMPT`). */
  system?: string;
  maxSteps?: number;
  maxTokensPerReply?: number;
  /** Kontextfenster in Tokens (ohne: bekannte Größe der Modellfamilie). */
  contextWindow?: number;
  /** Heutiges Datum fürs System-Prompt (Tests: fest). */
  today?: () => string;
}

export class ModelEngine implements ChatEngine {
  readonly label: string;
  maxSteps: number;
  maxTokensPerReply: number;

  constructor(private readonly o: ModelEngineOptions) {
    this.label = `${o.provider.id}/${o.model}`;
    this.maxSteps = o.maxSteps ?? 24;
    this.maxTokensPerReply = o.maxTokensPerReply ?? 4096;
  }

  run(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    const channel = new EventChannel<ChatEvent>();
    this.loop(request, signal, (e) => channel.push(e)).then(
      () => channel.close(),
      (e: unknown) => channel.close(e ?? new Error("failed")),
    );
    return channel;
  }

  /** Ein Modellaufruf; `thinking: false` verwirft Thinking-Deltas (eine Fortsetzung hängt an den gezeigten Text an). */
  private async step(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal, emit: (e: ChatEvent) => void, thinking: boolean): Promise<AIResponse> {
    const { provider, model } = this.o;
    const r = await provider.stream(messages, {
      model, tools, maxTokens: this.maxTokensPerReply, signal,
      onEvent: (e) => {
        if (e.type === "thinkingDelta" && !thinking) return;
        emit(e);
      },
    });
    if (signal.aborted) throw new AbortError();
    const cost = estimateCost(this.label, r.usage);
    emit({ type: "usage", inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, costUSD: cost, estimated: true, model: this.label });
    return r;
  }

  private async loop(request: ChatRequest, signal: AbortSignal, emit: (e: ChatEvent) => void): Promise<void> {
    const { provider, model, tools: host } = this.o;
    const policy: ToolPolicy = this.o.policy ?? { mode: "askEdits" };
    const specs = [...(host?.specs ?? [])];
    const today = (this.o.today ?? (() => new Date().toISOString().slice(0, 10)))();
    let system = `${this.o.system ?? BASED_SYSTEM_PROMPT}\n\nToday is ${today}.`;
    if (request.system) system += "\n\n# Agent instructions\n" + request.system;
    let messages: ChatMessage[] = [{ role: "system", content: system }, ...(request.history ?? []), { role: "user", content: request.prompt }];
    emit({ type: "started", model: this.label });

    // BSD-47: das Gespräch im Kontextfenster halten (Zusammenfassung statt „prompt too long“).
    const budget = new ContextBudget(this.o.contextWindow ?? ContextBudget.windowFor(model));
    const summaryModel = ContextBudget.summaryModel(provider.models, model);
    const summarizer = async (text: string) => {
      const r = await provider.stream([{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: text }], { model: summaryModel, tools: [], maxTokens: 1024, signal });
      emit({ type: "usage", inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, costUSD: estimateCost(`${provider.id}/${summaryModel}`, r.usage), estimated: true, model: `${provider.id}/${summaryModel}` });
      return r.message.content;
    };
    const noticed = new Set<string>();
    const compacted = async (m: ChatMessage[], force: boolean): Promise<ChatMessage[]> => {
      const { messages: out, report } = await budget.fit(m, summarizer, force);
      if (signal.aborted) throw new AbortError();
      if (!compactionChanged(report)) return m;
      const n = compactionNotice(report);
      if (n && !noticed.has(n)) {
        noticed.add(n);
        emit({ type: "notice", text: n });
      }
      return out;
    };

    for (let steps = 0; steps < this.maxSteps; steps++) {
      messages = await compacted(messages, false);
      let r: AIResponse;
      try {
        r = await this.step(messages, specs, signal, emit, true);
      } catch (e) {
        if (!ContextBudget.isContextOverflow(e)) throw e;
        // Unsere Schätzung war für dieses Modell zu optimistisch: stärker verdichten und einmal neu versuchen.
        messages = await compacted(messages, true);
        r = await this.step(messages, specs, signal, emit, true);
      }
      let reply = r.message;
      // BSD-46: eine vom Längenlimit abgeschnittene Antwort wird einmal fortgesetzt (die Deltas der Fortsetzung
      // verlängern den schon gezeigten Text), danach als abgeschnitten markiert.
      if (isTruncated(r) && (r.message.toolCalls ?? []).length === 0) {
        emit({ type: "notice", text: "The answer hit the length limit and was continued." });
        const more: ChatMessage[] = [r.message, { role: "user", content: CONTINUE_PROMPT }];
        const r2 = await this.step([...messages, ...more], specs, signal, emit, false);
        if (isTruncated(r2)) emit({ type: "notice", text: "The answer was cut off at the length limit." });
        messages.push(...more);
        reply = r2.message;
        r = { ...r2, message: { ...r2.message, content: r.message.content + r2.message.content }, thinking: r.thinking };
      }
      messages.push(reply);
      if (r.thinking) emit({ type: "thinking", text: r.thinking });
      const calls = r.message.toolCalls ?? [];
      // Auch die Schlussantwort ist ein Ereignis (sonst ginge Text neben einem Tool-Call verloren).
      if (r.message.content) emit({ type: "text", text: r.message.content });
      if (calls.length === 0) return;
      for (const call of calls) {
        emit({ type: "toolUse", id: call.id, name: call.name, input: call.arguments });
        const res = host
          ? await executeTool(host, call, policy, signal, emit)
          : { text: `Unknown tool ${call.name}`, isError: true };
        messages.push({ role: "tool", content: clip(res.text, TOOL_OUTPUT_MODEL_LIMIT), toolCallID: call.id });
        emit({ type: "toolResult", id: call.id, output: clip(res.text, TOOL_OUTPUT_EVENT_LIMIT), isError: res.isError });
      }
    }
    // BSD-47: das Schrittlimit endet nicht mehr still.
    emit({ type: "notice", text: `Stopped after ${this.maxSteps} steps (step limit). Reply “continue” to keep going.` });
  }
}

// MARK: ScriptedEngine

export type ScriptStep =
  /** Ein Ereignis unverändert. */
  | { event: ChatEvent }
  /** Text in Stücken (`chunk` Zeichen, Standard 12), danach der fertige Block. */
  | { text: string; chunk?: number }
  | { thinking: string; chunk?: number }
  /** Ein echter Werkzeug-Aufruf über den ToolHost (mit Permission wie bei Modellen). */
  | { tool: string; input: JSONValue; id?: string }
  /** Pause in ms. */
  | { wait: number }
  /** Wartet, bis der Turn abgebrochen wird (für Stop-Tests). */
  | { hold: true }
  /** Der Turn scheitert mit dieser Meldung. */
  | { fail: string };

export interface ScriptedEngineOptions {
  /** Skript je Turn; eine Funktion bekommt die Anfrage und die Nummer des Turns (ab 0). */
  script: readonly ScriptStep[] | ((request: ChatRequest, turn: number) => readonly ScriptStep[]);
  tools?: ToolHost | undefined;
  policy?: ToolPolicy | undefined;
  /** Pause zwischen Schritten und Stücken in ms (Standard 0). */
  delayMs?: number;
  label?: string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const sleepMs = (ms: number, signal: AbortSignal) =>
  raceAbort(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);

/** Spielt ein Skript als ChatEvent-Strom ab – deterministisch, ohne Netz. Für Tests, E2E und Vorführungen. */
export class ScriptedEngine implements ChatEngine {
  readonly label: string;
  /** Anfragen, die die Engine gesehen hat (Tests). */
  readonly requests: ChatRequest[] = [];

  constructor(private readonly o: ScriptedEngineOptions) {
    this.label = o.label ?? "Scripted";
  }

  async *run(request: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    const turn = this.requests.length;
    this.requests.push(request);
    const steps = typeof this.o.script === "function" ? this.o.script(request, turn) : this.o.script;
    const sleep = this.o.sleep ?? sleepMs;
    const delay = this.o.delayMs ?? 0;
    const pause = async () => {
      if (signal.aborted) throw new AbortError();
      if (delay > 0) await sleep(delay, signal);
    };
    const pieces = (s: string, n: number) => {
      const out: string[] = [];
      for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
      return out;
    };
    yield { type: "started", model: this.label };
    let n = 0;
    for (const step of steps) {
      await pause();
      if ("event" in step) yield step.event;
      else if ("text" in step) {
        for (const p of pieces(step.text, step.chunk ?? 12)) { yield { type: "textDelta", text: p }; await pause(); }
        yield { type: "text", text: step.text };
      } else if ("thinking" in step) {
        for (const p of pieces(step.thinking, step.chunk ?? 12)) { yield { type: "thinkingDelta", text: p }; await pause(); }
        yield { type: "thinking", text: step.thinking };
      } else if ("tool" in step) {
        n += 1;
        const call: ToolCall = { id: step.id ?? `call_${turn}_${n}`, name: step.tool, arguments: step.input };
        yield { type: "toolUse", id: call.id, name: call.name, input: call.arguments };
        const pending: ChatEvent[] = [];
        const policy = this.o.policy ?? { mode: "free" as const };
        const run = this.o.tools
          ? executeTool(this.o.tools, call, policy, signal, (e) => pending.push(e))
          : Promise.resolve<ToolResult>({ text: `Unknown tool ${call.name}`, isError: true });
        // Die Freigabe-Anfrage muss raus, bevor auf die Antwort gewartet wird.
        await Promise.resolve();
        await Promise.resolve();
        while (pending.length > 0) yield pending.shift()!;
        const res = await run;
        while (pending.length > 0) yield pending.shift()!;
        yield { type: "toolResult", id: call.id, output: clip(res.text, TOOL_OUTPUT_EVENT_LIMIT), isError: res.isError };
      } else if ("wait" in step) await sleep(step.wait, signal);
      else if ("hold" in step) await raceAbort(new Promise<void>(() => undefined), signal);
      else if ("fail" in step) throw new Error(step.fail);
    }
  }
}

// MARK: Ein Turn mit genau einem Ende

/**
 * Lässt `engine` einen Turn laufen und garantiert das Ende: `result`, wenn die Engine selbst keins schickt; bei
 * Abbruch `failed` („Stopped.“, `stopped`), bei einem Fehler `failed` mit der Meldung. Nach dem Ende kommt nichts mehr.
 */
export async function* runTurn(engine: ChatEngine, request: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
  let text = "";
  let ended = false;
  try {
    for await (const e of engine.run(request, signal)) {
      if (signal.aborted) break;
      if (e.type === "text") text = text ? text + "\n\n" + e.text : e.text;
      yield e;
      if (e.type === "result" || e.type === "failed") {
        ended = true;
        break;
      }
    }
  } catch (e) {
    if (!signal.aborted && !isAbort(e)) {
      yield { type: "failed", message: e instanceof Error ? e.message : String(e) };
      return;
    }
  }
  if (ended) return;
  if (signal.aborted) yield { type: "failed", message: "Stopped.", stopped: true };
  else yield { type: "result", text, isError: false };
}
