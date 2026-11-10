// Anthropic Messages API (API-Schlüssel, BYOK), gestreamt (SSE), mit Retry bei Überlast; Tool-Use in der Schleife der
// ModelEngine. Portiert aus Swift `AnthropicProvider` / `AnthropicStream` (BasedBrain/AI/Anthropic.swift) – Request-
// und Event-Format sind von dort übernommen, nicht geraten. Modelle trägt der Nutzer ein.
import type { JSONValue } from "@based/core";
import { AIError, type AIProvider, type AIResponse, type ChatMessage, type ProviderEvent, type StreamOptions, type ToolCall } from "../messages.js";
import { HTTPFailure, RetryPolicy, streamSSE, type FetchLike } from "../retry.js";
import type { SSEEvent } from "../sse.js";

type Obj = { [key: string]: JSONValue };
const isObj = (v: JSONValue | undefined): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: JSONValue | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const int = (v: JSONValue | undefined): number | undefined => (typeof v === "number" ? v : undefined);

export interface AnthropicOptions {
  apiKey: string;
  baseURL?: string;
  models?: readonly string[];
  /** low · medium · high · xhigh · max (ohne = Standard des Modells). */
  effort?: string;
  retry?: RetryPolicy;
  fetch?: FetchLike;
  /**
   * Aufruf direkt aus dem Browser: die API verlangt dafür den Header `anthropic-dangerous-direct-browser-access`
   * (sonst scheitert die CORS-Vorabfrage). Nicht in der Swift-Vorlage (dort kein Browser).
   */
  browser?: boolean;
  /** Modelle, für die der serverseitige Fallback bei Ablehnungen angefragt wird (Swift `supportsFallbacks`). */
  fallbackModels?: readonly string[];
}

/** Swift `AnthropicProvider.supportsFallbacks`. */
export const ANTHROPIC_FALLBACK_MODELS: readonly string[] = ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"];

export class AnthropicProvider implements AIProvider {
  readonly id = "anthropic";
  readonly displayName = "Claude (Anthropic)";
  readonly models: readonly string[];
  readonly baseURL: string;
  effort: string | undefined;
  retry: RetryPolicy;
  private readonly apiKey: string;
  private readonly fetch: FetchLike;
  private readonly browser: boolean;
  private readonly fallbackModels: readonly string[];

  constructor(o: AnthropicOptions) {
    this.apiKey = o.apiKey;
    this.baseURL = (o.baseURL ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.models = o.models ?? [];
    this.effort = o.effort;
    this.retry = o.retry ?? new RetryPolicy();
    this.fetch = o.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.browser = o.browser ?? false;
    this.fallbackModels = o.fallbackModels ?? ANTHROPIC_FALLBACK_MODELS;
  }

  /** Modelle vor der 4.6-Generation nehmen kein adaptives Thinking (Swift `supportsAdaptiveThinking`). */
  static supportsAdaptiveThinking(model: string): boolean {
    return !(model.startsWith("claude-3") || model.includes("-4-5") || model.includes("-4-1") || model.includes("-4-0") || model === "claude-opus-4" || model === "claude-sonnet-4");
  }

  async stream(messages: ChatMessage[], opts: StreamOptions): Promise<AIResponse> {
    const { url, headers, body } = this.request(messages, opts);
    const onEvent = opts.onEvent ?? (() => undefined);
    const acc = await streamSSE({
      fetch: this.fetch, url, headers, body: { ...body, stream: true }, policy: this.retry, signal: opts.signal,
      makeState: () => new AnthropicStream(),
      handle: (state, e) => state.apply(e, onEvent),
    });
    return acc.response();
  }

  request(messages: ChatMessage[], opts: Pick<StreamOptions, "model" | "tools" | "maxTokens">): { url: string; headers: Record<string, string>; body: Obj } {
    if (!this.apiKey) throw AIError.missingKey(this.displayName);
    const { model, tools, maxTokens } = opts;
    const body: Obj = { model, max_tokens: maxTokens };
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    if (system) body.system = system;
    const out: Obj[] = [];
    for (const m of messages) {
      switch (m.role) {
        case "user": out.push({ role: "user", content: m.content }); break;
        case "assistant": {
          if (m.rawContent !== undefined) { out.push({ role: "assistant", content: m.rawContent }); break; }
          const parts: JSONValue[] = [];
          if (m.content) parts.push({ type: "text", text: m.content });
          for (const c of m.toolCalls ?? []) parts.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
          out.push({ role: "assistant", content: parts });
          break;
        }
        case "tool": {
          const part: Obj = { type: "tool_result", tool_use_id: m.toolCallID ?? "", content: m.content };
          // Aufeinanderfolgende Tool-Ergebnisse gehören in einen Nutzer-Turn (Vorgabe der API).
          const last = out[out.length - 1];
          const arr = last && last.role === "user" && Array.isArray(last.content) ? last.content : undefined;
          if (arr && isObj(arr[0]) && arr[0].type === "tool_result") arr.push(part);
          else out.push({ role: "user", content: [part] });
          break;
        }
        case "system": break;
      }
    }
    body.messages = out;
    if (tools.length > 0) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    const headers: Record<string, string> = { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" };
    if (this.browser) headers["anthropic-dangerous-direct-browser-access"] = "true";
    if (AnthropicProvider.supportsAdaptiveThinking(model)) {
      body.thinking = { type: "adaptive", display: "summarized" };
      // Thinking teilt sich max_tokens mit der Antwort: Platz für beides lassen.
      body.max_tokens = Math.max(maxTokens, 16_000);
      if (this.effort) body.output_config = { effort: this.effort };
    }
    if (this.fallbackModels.includes(model)) {
      headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
      body.fallbacks = "default";
    }
    return { url: this.baseURL + "/v1/messages", headers, body };
  }

  /** Antwort-Objekt → Text, Tool-Calls, Thinking-Zusammenfassung, rohe Blöcke (für die Schleife) und Usage. */
  static parse(json: JSONValue): AIResponse {
    const root = isObj(json) ? json : {};
    let text = "", thinking = "";
    const calls: ToolCall[] = [];
    const content = Array.isArray(root.content) ? root.content : [];
    for (const part of content) {
      if (!isObj(part)) continue;
      switch (part.type) {
        case "text": text += str(part.text) ?? ""; break;
        case "thinking": {
          const t = str(part.thinking);
          if (t) thinking += (thinking ? "\n\n" : "") + t;
          break;
        }
        case "tool_use": calls.push({ id: str(part.id) ?? crypto.randomUUID(), name: str(part.name) ?? "", arguments: part.input ?? {} }); break;
      }
    }
    const stop = str(root.stop_reason);
    if (stop === "refusal") {
      const details = isObj(root.stop_details) ? root.stop_details : {};
      const why = str(details.explanation) ?? str(details.category);
      if (!text) text = "Claude declined this request" + (why ? ` (${why})` : "") + ".";
    }
    const u = isObj(root.usage) ? root.usage : {};
    const message: ChatMessage = { role: "assistant", content: text, toolCalls: calls, rawContent: content };
    const r: AIResponse = { message, usage: { inputTokens: int(u.input_tokens) ?? 0, outputTokens: int(u.output_tokens) ?? 0 }, thinking };
    if (stop !== undefined) r.stopReason = stop;
    return r;
  }
}

/**
 * Faltet einen Messages-Strom (`message_start`, `content_block_*`, `message_delta`, `error`) zurück in die Nachricht,
 * die ein ungestreamter Aufruf geliefert hätte – Blöcke (Thinking mit Signatur), Stop-Grund, Usage.
 */
export class AnthropicStream {
  private message: Obj = {};
  private blocks = new Map<number, Obj>();
  private texts = new Map<number, string>();
  private thinking = new Map<number, string>();
  private signatures = new Map<number, string>();
  private inputJSON = new Map<number, string>();
  private stopReason: string | undefined;
  private stopDetails: JSONValue | undefined;
  private usage: Obj = {};
  private any = false;

  /** `true`, wenn das Ereignis Ausgabe gezeigt hat (danach kein Retry mehr). */
  apply(e: SSEEvent, onEvent: (e: ProviderEvent) => void): boolean {
    let v: JSONValue;
    try {
      v = JSON.parse(e.data) as JSONValue;
    } catch {
      return false;
    }
    if (!isObj(v)) return false;
    const add = (map: Map<number, string>, i: number, s: string) => map.set(i, (map.get(i) ?? "") + s);
    switch (str(v.type) ?? e.event) {
      case "message_start": {
        this.any = true;
        if (isObj(v.message)) {
          this.message = v.message;
          if (isObj(v.message.usage)) Object.assign(this.usage, v.message.usage);
        }
        break;
      }
      case "content_block_start": {
        const i = int(v.index);
        if (i === undefined) return false;
        this.any = true;
        const block = isObj(v.content_block) ? v.content_block : {};
        this.blocks.set(i, block);
        if (block.type === "tool_use") {
          onEvent({ type: "toolStart", id: str(block.id) ?? "", name: str(block.name) ?? "" });
          return true;
        }
        break;
      }
      case "content_block_delta": {
        const i = int(v.index);
        const d = v.delta;
        if (i === undefined || !isObj(d)) return false;
        switch (d.type) {
          case "text_delta": {
            const t = str(d.text) ?? "";
            add(this.texts, i, t);
            if (t) { onEvent({ type: "textDelta", text: t }); return true; }
            break;
          }
          case "thinking_delta": {
            const t = str(d.thinking) ?? "";
            add(this.thinking, i, t);
            if (t) { onEvent({ type: "thinkingDelta", text: t }); return true; }
            break;
          }
          case "signature_delta": add(this.signatures, i, str(d.signature) ?? ""); break;
          case "input_json_delta": {
            const j = str(d.partial_json) ?? "";
            add(this.inputJSON, i, j);
            const block = this.blocks.get(i);
            if (j && block?.type === "tool_use") { onEvent({ type: "toolInputDelta", id: str(block.id) ?? "", json: j }); return true; }
            break;
          }
        }
        break;
      }
      case "message_delta": {
        if (isObj(v.delta)) {
          this.stopReason = str(v.delta.stop_reason) ?? this.stopReason;
          const sd = v.delta.stop_details;
          if (sd !== undefined && sd !== null) this.stopDetails = sd;
        }
        if (isObj(v.usage)) Object.assign(this.usage, v.usage);
        break;
      }
      case "error": {
        const err = isObj(v.error) ? v.error : {};
        const type = str(err.type) ?? "error";
        // Überlast mitten im Strom: wie ein 529 wiederholt, solange noch nichts gezeigt wurde.
        throw new HTTPFailure(type === "overloaded_error" ? 529 : type === "rate_limit_error" ? 429 : 500, str(err.message) ?? type);
      }
    }
    return false;
  }

  response(): AIResponse {
    const content: JSONValue[] = [];
    for (const i of [...this.blocks.keys()].sort((a, b) => a - b)) {
      const b: Obj = { ...this.blocks.get(i)! };
      switch (b.type) {
        case "text": b.text = this.texts.get(i) ?? str(b.text) ?? ""; break;
        case "thinking": {
          b.thinking = this.thinking.get(i) ?? str(b.thinking) ?? "";
          const s = this.signatures.get(i);
          if (s !== undefined) b.signature = s;
          break;
        }
        case "tool_use": case "server_tool_use": {
          const j = this.inputJSON.get(i);
          if (j !== undefined) {
            let input: JSONValue = {};
            if (j) {
              try { input = JSON.parse(j) as JSONValue; } catch { input = {}; }
            }
            b.input = input;
          }
          break;
        }
      }
      content.push(b);
    }
    if (!this.any && content.length === 0) throw AIError.badResponse("empty stream");
    const m: Obj = { ...this.message, content, stop_reason: this.stopReason ?? null, usage: this.usage };
    if (this.stopDetails !== undefined) m.stop_details = this.stopDetails;
    return AnthropicProvider.parse(m);
  }
}
