// OpenAI Chat Completions, gestreamt – auch für OpenAI-kompatible Server (Ollama, LM Studio, OpenRouter …).
// Portiert aus Swift `OpenAIProvider` / `OpenAIStream` (BasedBrain/AI/OpenAI.swift). Ollama läuft wie dort über
// seinen OpenAI-kompatiblen Endpunkt (`/v1`), ohne Schlüssel.
import type { JSONValue } from "@based/core";
import { AIError, type AIProvider, type AIResponse, type ChatMessage, type ProviderEvent, type StreamOptions, type ToolCall } from "../messages.js";
import { HTTPFailure, RetryPolicy, streamSSE, type FetchLike } from "../retry.js";
import type { SSEEvent } from "../sse.js";

type Obj = { [key: string]: JSONValue };
const isObj = (v: JSONValue | undefined): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: JSONValue | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const int = (v: JSONValue | undefined): number | undefined => (typeof v === "number" ? v : undefined);

/** Welches Feld das Antwortlimit trägt: OpenAI will `max_completion_tokens`, ältere kompatible Server nur `max_tokens`. */
export type TokenField = "auto" | "max_tokens" | "max_completion_tokens";

export interface OpenAIOptions {
  id?: string;
  displayName?: string;
  apiKey: string;
  baseURL?: string;
  models?: readonly string[];
  tokenField?: TokenField;
  retry?: RetryPolicy;
  fetch?: FetchLike;
}

export const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";

export class OpenAIProvider implements AIProvider {
  readonly id: string;
  readonly displayName: string;
  readonly models: readonly string[];
  readonly baseURL: string;
  readonly tokenField: TokenField;
  retry: RetryPolicy;
  private readonly apiKey: string;
  private readonly fetch: FetchLike;

  constructor(o: OpenAIOptions) {
    this.id = o.id ?? "openai";
    this.displayName = o.displayName ?? "ChatGPT (OpenAI)";
    this.apiKey = o.apiKey;
    this.baseURL = (o.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.models = o.models ?? [];
    this.tokenField = o.tokenField ?? "auto";
    this.retry = o.retry ?? new RetryPolicy();
    this.fetch = o.fetch ?? ((url, init) => globalThis.fetch(url, init));
  }

  /** Lokale Modelle über Ollamas OpenAI-kompatiblen Endpunkt (kein Schlüssel nötig). */
  static ollama(o: { baseURL?: string; models?: readonly string[]; fetch?: FetchLike; retry?: RetryPolicy } = {}): OpenAIProvider {
    return new OpenAIProvider({ id: "ollama", displayName: "Ollama (local)", apiKey: "ollama", baseURL: o.baseURL ?? OLLAMA_BASE_URL, ...(o.models ? { models: o.models } : {}), ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.retry ? { retry: o.retry } : {}) });
  }

  /** Der Feldname, der wirklich geschickt wird. */
  get resolvedTokenField(): "max_tokens" | "max_completion_tokens" {
    if (this.tokenField !== "auto") return this.tokenField;
    let host = "";
    try {
      host = new URL(this.baseURL).hostname;
    } catch {
      host = "";
    }
    return host.endsWith("openai.com") ? "max_completion_tokens" : "max_tokens";
  }

  async stream(messages: ChatMessage[], opts: StreamOptions): Promise<AIResponse> {
    const body = this.requestBody(messages, opts);
    body.stream = true;
    if (this.resolvedTokenField === "max_completion_tokens") body.stream_options = { include_usage: true };
    const onEvent = opts.onEvent ?? (() => undefined);
    const acc = await streamSSE({
      fetch: this.fetch, url: this.baseURL + "/chat/completions", headers: { Authorization: `Bearer ${this.apiKey}` }, body, policy: this.retry, signal: opts.signal,
      makeState: () => new OpenAIStream(),
      handle: (state, e) => state.apply(e, onEvent),
    });
    return acc.response();
  }

  requestBody(messages: ChatMessage[], opts: Pick<StreamOptions, "model" | "tools" | "maxTokens">): Obj {
    if (!this.apiKey) throw AIError.missingKey(this.displayName);
    const msgs: JSONValue[] = [];
    for (const m of messages) {
      switch (m.role) {
        case "system": msgs.push({ role: "system", content: m.content }); break;
        case "user": msgs.push({ role: "user", content: m.content }); break;
        case "assistant": {
          const o: Obj = { role: "assistant", content: m.content ? m.content : null };
          if (m.toolCalls?.length) o.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } }));
          msgs.push(o);
          break;
        }
        case "tool": msgs.push({ role: "tool", tool_call_id: m.toolCallID ?? "", content: m.content }); break;
      }
    }
    const body: Obj = { model: opts.model, messages: msgs, [this.resolvedTokenField]: opts.maxTokens };
    if (opts.tools.length > 0) body.tools = opts.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    return body;
  }
}

/** Faltet einen Chat-Completions-Strom zur fertigen Antwort. */
export class OpenAIStream {
  private text = "";
  private reasoning = "";
  private calls = new Map<number, { id: string; name: string; args: string; started: boolean }>();
  private finish: string | undefined;
  private usage = { inputTokens: 0, outputTokens: 0 };

  apply(e: SSEEvent, onEvent: (e: ProviderEvent) => void): boolean {
    const d = e.data.trim();
    if (d === "[DONE]") return false;
    let v: JSONValue;
    try {
      v = JSON.parse(d) as JSONValue;
    } catch {
      return false;
    }
    if (!isObj(v)) return false;
    if (v.error !== undefined && v.error !== null) {
      const err = isObj(v.error) ? v.error : {};
      throw new HTTPFailure(int(err.code) ?? 500, str(err.message) ?? JSON.stringify(v.error));
    }
    if (isObj(v.usage)) this.usage = { inputTokens: int(v.usage.prompt_tokens) ?? 0, outputTokens: int(v.usage.completion_tokens) ?? 0 };
    const choice = Array.isArray(v.choices) ? v.choices[0] : undefined;
    if (!isObj(choice)) return false;
    const f = str(choice.finish_reason);
    if (f) this.finish = f;
    const delta = choice.delta;
    if (!isObj(delta)) return false;
    let shown = false;
    const r = str(delta.reasoning_content) ?? str(delta.reasoning);
    if (r) {
      this.reasoning += r;
      onEvent({ type: "thinkingDelta", text: r });
      shown = true;
    }
    const t = str(delta.content);
    if (t) {
      this.text += t;
      onEvent({ type: "textDelta", text: t });
      shown = true;
    }
    for (const c of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (!isObj(c)) continue;
      const i = int(c.index) ?? 0;
      const cur = this.calls.get(i) ?? { id: "", name: "", args: "", started: false };
      const fn = isObj(c.function) ? c.function : {};
      const id = str(c.id);
      if (id) cur.id = id;
      const n = str(fn.name);
      if (n) cur.name += n;
      const a = str(fn.arguments) ?? "";
      cur.args += a;
      if (!cur.started && cur.id && cur.name) {
        cur.started = true;
        onEvent({ type: "toolStart", id: cur.id, name: cur.name });
        if (cur.args) onEvent({ type: "toolInputDelta", id: cur.id, json: cur.args });
        shown = true;
      } else if (cur.started && a) {
        onEvent({ type: "toolInputDelta", id: cur.id, json: a });
        shown = true;
      }
      this.calls.set(i, cur);
    }
    return shown;
  }

  response(): AIResponse {
    const toolCalls: ToolCall[] = [...this.calls.keys()].sort((a, b) => a - b).map((i) => {
      const c = this.calls.get(i)!;
      let args: JSONValue = {};
      try {
        args = JSON.parse(c.args || "{}") as JSONValue;
      } catch {
        args = {};
      }
      return { id: c.id || crypto.randomUUID(), name: c.name, arguments: args };
    });
    const r: AIResponse = { message: { role: "assistant", content: this.text, toolCalls }, usage: this.usage, thinking: this.reasoning };
    if (this.finish !== undefined) r.stopReason = this.finish;
    return r;
  }
}
