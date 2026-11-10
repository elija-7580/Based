// Swift `AnthropicStreamingTests` / `OpenAIStreamingTests` (APIStreamingTests.swift): Event-Parser gegen die
// SSE-Fixtures der Swift-Testsuite, Retry vor dem ersten Token, kein Retry danach.
import { describe, expect, it } from "vitest";
import { AIError, AnthropicProvider, OpenAIProvider, type ProviderEvent } from "../src/index.js";
import { bytes, chunks, fakeFetch, fixture, instant, type Reply } from "./helpers.js";

const ok = (name: string, size?: number): Reply => ({ status: 200, parts: size ? chunks(fixture(name), size) : [fixture(name)] });
const user = [{ role: "user" as const, content: "hi" }];

describe("AnthropicProvider", () => {
  const provider = (replies: Reply[], slept: number[] = []) => {
    const f = fakeFetch(replies);
    return { p: new AnthropicProvider({ apiKey: "sk-secret", fetch: f.fetch, retry: instant(slept) }), f };
  };

  it("streamt Thinking, Text und Tool-Call", async () => {
    const { p, f } = provider([ok("anthropic-stream.sse", 5)]);
    const log: ProviderEvent[] = [];
    const r = await p.stream(user, { model: "claude-opus-5-5", tools: [], maxTokens: 1000, onEvent: (e) => log.push(e) });
    expect(log).toEqual([
      { type: "thinkingDelta", text: "The user wants " }, { type: "thinkingDelta", text: "a greeting." },
      { type: "textDelta", text: "Grüß " }, { type: "textDelta", text: "dich! Ich lese die Seite." },
      { type: "toolStart", id: "toolu_01", name: "get_page" },
      { type: "toolInputDelta", id: "toolu_01", json: '{"page_id": "p' }, { type: "toolInputDelta", id: "toolu_01", json: '1"}' },
    ]);
    expect(r.thinking).toBe("The user wants a greeting.");
    expect(r.message.content).toBe("Grüß dich! Ich lese die Seite.");
    expect(r.message.toolCalls).toEqual([{ id: "toolu_01", name: "get_page", arguments: { page_id: "p1" } }]);
    expect(r.stopReason).toBe("tool_use");
    expect(r.usage).toEqual({ inputTokens: 25, outputTokens: 42 });
    // Blöcke bleiben für die Tool-Schleife erhalten, Thinking mit Signatur.
    expect((r.message.rawContent as { signature?: string }[])[0]?.signature).toBe("EqQBCgIYAhIM");
    const req = f.requests[0]!;
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.body.stream).toBe(true);
    expect(req.headers["x-api-key"]).toBe("sk-secret");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.headers.Accept).toBe("text/event-stream");
  });

  it("Request wie die Swift-Vorlage: System getrennt, Tool-Ergebnisse in einem Nutzer-Turn, adaptives Thinking", () => {
    const p = new AnthropicProvider({ apiKey: "k", effort: "high" });
    const { body, headers } = p.request(
      [
        { role: "system", content: "sys" }, { role: "user", content: "q" },
        { role: "assistant", content: "t", toolCalls: [{ id: "a", name: "search", arguments: { query: "x" } }, { id: "b", name: "read_page", arguments: {} }] },
        { role: "tool", content: "ra", toolCallID: "a" }, { role: "tool", content: "rb", toolCallID: "b" },
      ],
      { model: "claude-opus-5-5", tools: [{ name: "search", description: "d", inputSchema: { type: "object" } }], maxTokens: 4096 },
    );
    expect(body.system).toBe("sys");
    expect(body.messages).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "text", text: "t" }, { type: "tool_use", id: "a", name: "search", input: { query: "x" } }, { type: "tool_use", id: "b", name: "read_page", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ra" }, { type: "tool_result", tool_use_id: "b", content: "rb" }] },
    ]);
    expect(body.tools).toEqual([{ name: "search", description: "d", input_schema: { type: "object" } }]);
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.max_tokens).toBe(16_000);
    expect(body.output_config).toEqual({ effort: "high" });
    expect(headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
    expect(body.fallbacks).toBe("default");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBeUndefined();
    // ältere Modelle: kein adaptives Thinking, kein Fallback
    const old = p.request([{ role: "user", content: "q" }], { model: "claude-3-haiku", tools: [], maxTokens: 100 });
    expect(old.body.thinking).toBeUndefined();
    expect(old.body.max_tokens).toBe(100);
    expect(old.headers["anthropic-beta"]).toBeUndefined();
    // rohe Blöcke werden unverändert zurückgeschickt
    const raw = p.request([{ role: "assistant", content: "x", rawContent: [{ type: "thinking", thinking: "t", signature: "s" }] }], { model: "m", tools: [], maxTokens: 1 });
    expect(raw.body.messages).toEqual([{ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }] }]);
    expect(new AnthropicProvider({ apiKey: "k", browser: true }).request([], { model: "m", tools: [], maxTokens: 1 }).headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });

  it("ohne Schlüssel kein Aufruf", async () => {
    const f = fakeFetch([]);
    const p = new AnthropicProvider({ apiKey: "", fetch: f.fetch });
    await expect(p.stream(user, { model: "m", tools: [], maxTokens: 1 })).rejects.toMatchObject({ kind: "missingKey" });
    expect(f.requests).toHaveLength(0);
  });

  it("wiederholt Überlast und Rate-Limit, achtet auf retry-after", async () => {
    const slept: number[] = [];
    const { p, f } = provider([
      { status: 429, headers: { "retry-after": "2" }, parts: [bytes("rate limited")] },
      { status: 529, parts: [bytes('{"type":"error","error":{"type":"overloaded_error"}}')] },
      ok("anthropic-stream.sse"),
    ], slept);
    const r = await p.stream(user, { model: "claude-opus-5-5", tools: [], maxTokens: 1000 });
    expect(r.message.content).toBe("Grüß dich! Ich lese die Seite.");
    expect(f.requests).toHaveLength(3);
    expect(slept, "erst retry-after, dann Backoff 1 s × 2¹").toEqual([2, 2]);
  });

  it("gibt nach vier Versuchen auf und wiederholt Client-Fehler nie", async () => {
    const busy = provider(Array.from({ length: 6 }, () => ({ status: 503, parts: [bytes("busy")] })));
    await expect(busy.p.stream(user, { model: "m", tools: [], maxTokens: 10 })).rejects.toBeInstanceOf(AIError);
    expect(busy.f.requests).toHaveLength(4);
    const bad = provider([{ status: 400, parts: [bytes("bad request")] }, { status: 200, parts: [] }]);
    await expect(bad.p.stream(user, { model: "m", tools: [], maxTokens: 10 })).rejects.toMatchObject({ kind: "http", status: 400, body: "bad request" });
    expect(bad.f.requests).toHaveLength(1);
  });

  it("Netzabbruch vor dem ersten Token wird wiederholt, danach nicht", async () => {
    const okData = fixture("anthropic-stream.sse");
    const first = provider([{ fail: new TypeError("network connection lost") }, ok("anthropic-stream.sse")]);
    const r = await first.p.stream(user, { model: "m", tools: [], maxTokens: 10 });
    expect(r.message.content.startsWith("Grüß")).toBe(true);
    // Abbruch, nachdem Text gezeigt wurde: kein Retry (er würde den Text wiederholen).
    const text = new TextDecoder().decode(okData);
    const half = bytes(text.slice(0, text.indexOf("dich!") + 5 + 40));
    const second = provider([{ status: 200, parts: [half], failAfter: new TypeError("network connection lost") }, ok("anthropic-stream.sse")]);
    const log: ProviderEvent[] = [];
    await expect(second.p.stream(user, { model: "m", tools: [], maxTokens: 10, onEvent: (e) => log.push(e) })).rejects.toMatchObject({ kind: "network" });
    expect(second.f.requests).toHaveLength(1);
    expect(log).toContainEqual({ type: "textDelta", text: "Grüß " });
  });

  it("Überlast-Ereignis mitten im Strom wird wiederholt, solange nichts gezeigt wurde", async () => {
    const overloaded = 'event: message_start\ndata: {"type":"message_start","message":{"content":[],"usage":{"input_tokens":1}}}\n\nevent: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
    const { p, f } = provider([{ status: 200, parts: [bytes(overloaded)] }, ok("anthropic-stream.sse")]);
    const r = await p.stream(user, { model: "m", tools: [], maxTokens: 10 });
    expect(r.stopReason).toBe("tool_use");
    expect(f.requests).toHaveLength(2);
  });

  it("Abbruch per AbortSignal: kein Retry, AbortError", async () => {
    const c = new AbortController();
    const f = fakeFetch([{ status: 503, parts: [bytes("busy")] }, ok("anthropic-stream.sse")]);
    const p = new AnthropicProvider({ apiKey: "k", fetch: f.fetch, retry: instant() });
    p.retry.sleep = async () => { c.abort(); };
    await expect(p.stream(user, { model: "m", tools: [], maxTokens: 10, signal: c.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(f.requests).toHaveLength(1);
  });

  it("Fehlermeldungen enthalten nie den Schlüssel", async () => {
    const { p } = provider([{ status: 401, parts: [bytes('{"error":{"message":"invalid x-api-key"}}')] }]);
    const e = await p.stream(user, { model: "m", tools: [], maxTokens: 10 }).catch((x: unknown) => x as Error);
    expect(String((e as Error).message)).not.toContain("sk-secret");
    expect(JSON.stringify(e)).not.toContain("sk-secret");
  });

  it("Ablehnung (stop_reason refusal) wird lesbar", () => {
    const r = AnthropicProvider.parse({ content: [], stop_reason: "refusal", stop_details: { category: "cyber" }, usage: {} });
    expect(r.message.content).toBe("Claude declined this request (cyber).");
  });
});

describe("OpenAIProvider", () => {
  const provider = (replies: Reply[], opts: { base?: string; field?: "auto" | "max_tokens" | "max_completion_tokens"; slept?: number[] } = {}) => {
    const f = fakeFetch(replies);
    return { p: new OpenAIProvider({ apiKey: "k", fetch: f.fetch, retry: instant(opts.slept), ...(opts.base ? { baseURL: opts.base } : {}), ...(opts.field ? { tokenField: opts.field } : {}) }), f };
  };

  it("streamt Text und setzt Tool-Calls zusammen", async () => {
    const { p, f } = provider([ok("openai-stream.sse", 11)]);
    const log: ProviderEvent[] = [];
    const r = await p.stream(user, { model: "gpt-4.1", tools: [], maxTokens: 100, onEvent: (e) => log.push(e) });
    expect(log.filter((e) => e.type === "textDelta")).toEqual([{ type: "textDelta", text: "Hallo " }, { type: "textDelta", text: "Welt." }]);
    expect(log.filter((e) => e.type !== "textDelta")).toEqual([
      { type: "toolStart", id: "call_1", name: "search" },
      { type: "toolInputDelta", id: "call_1", json: '{"query":' }, { type: "toolInputDelta", id: "call_1", json: '"notes"}' },
    ]);
    expect(r.message.content).toBe("Hallo Welt.");
    expect(r.message.toolCalls).toEqual([{ id: "call_1", name: "search", arguments: { query: "notes" } }]);
    expect(r.stopReason).toBe("tool_calls");
    expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 9 });
    expect(f.requests[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(f.requests[0]!.headers.Authorization).toBe("Bearer k");
    expect(f.requests[0]!.body.max_completion_tokens).toBe(100);
    expect(f.requests[0]!.body.stream_options).toEqual({ include_usage: true });
  });

  it("das Token-Feld folgt dem Host", async () => {
    const ollama = provider([ok("openai-stream.sse")], { base: "http://127.0.0.1:11434/v1" });
    await ollama.p.stream(user, { model: "llama3.1", tools: [], maxTokens: 50 });
    expect(ollama.f.requests[0]!.body.max_tokens).toBe(50);
    expect(ollama.f.requests[0]!.body.max_completion_tokens).toBeUndefined();
    expect(ollama.f.requests[0]!.body.stream_options, "ältere Server lehnen unbekannte Stream-Optionen ab").toBeUndefined();
    expect(OpenAIProvider.ollama().resolvedTokenField).toBe("max_tokens");
    expect(OpenAIProvider.ollama().id).toBe("ollama");
    expect(new OpenAIProvider({ apiKey: "k" }).resolvedTokenField).toBe("max_completion_tokens");
    const forced = provider([ok("openai-stream.sse")], { base: "http://lmstudio.local/v1", field: "max_completion_tokens" });
    await forced.p.stream(user, { model: "x", tools: [], maxTokens: 7 });
    expect(forced.f.requests[0]!.body.max_completion_tokens).toBe(7);
  });

  it("Rate-Limit, dann Erfolg", async () => {
    const slept: number[] = [];
    const { p } = provider([{ status: 429, headers: { "retry-after-ms": "1500" }, parts: [] }, ok("openai-stream.sse")], { slept });
    const r = await p.stream(user, { model: "gpt-4.1", tools: [], maxTokens: 100 });
    expect(r.message.content).toBe("Hallo Welt.");
    expect(slept).toEqual([1.5]);
  });

  it("Nachrichten: Tool-Calls als function mit JSON-String, Tool-Antworten mit tool_call_id", () => {
    const p = new OpenAIProvider({ apiKey: "k" });
    const body = p.requestBody(
      [{ role: "system", content: "s" }, { role: "assistant", content: "", toolCalls: [{ id: "c", name: "search", arguments: { query: "x" } }] }, { role: "tool", content: "r", toolCallID: "c" }],
      { model: "m", tools: [{ name: "search", description: "d", inputSchema: { type: "object" } }], maxTokens: 5 },
    );
    expect(body.messages).toEqual([
      { role: "system", content: "s" },
      { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "search", arguments: '{"query":"x"}' } }] },
      { role: "tool", tool_call_id: "c", content: "r" },
    ]);
    expect(body.tools).toEqual([{ type: "function", function: { name: "search", description: "d", parameters: { type: "object" } } }]);
  });

  it("reasoning_content wird Thinking", async () => {
    const sse = 'data: {"choices":[{"index":0,"delta":{"reasoning_content":"hm"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const { p } = provider([{ status: 200, parts: [bytes(sse)] }]);
    const log: ProviderEvent[] = [];
    const r = await p.stream(user, { model: "m", tools: [], maxTokens: 5, onEvent: (e) => log.push(e) });
    expect(log).toEqual([{ type: "thinkingDelta", text: "hm" }, { type: "textDelta", text: "ok" }]);
    expect(r.thinking).toBe("hm");
  });
});
