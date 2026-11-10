import { readFileSync } from "node:fs";
import { MemoryPersistence, WorkspaceStore } from "@based/core";
import { RetryPolicy, type AIProvider, type AIResponse, type ChatEvent, type ChatMessage, type FetchLike, type ProviderEvent, type StreamOptions } from "../src/index.js";

export const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
export const fixtureText = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
export const bytes = (s: string) => new TextEncoder().encode(s);

/** Teilt Daten in Stücke von `size` Bytes (schneidet Zeilen, „\r\n“ und Mehrbyte-Zeichen). */
export function chunks(d: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < d.length; i += size) out.push(d.slice(i, i + size));
  return out;
}

export type Reply =
  | { status: number; headers?: Record<string, string>; parts: Uint8Array[]; failAfter?: Error }
  | { fail: Error };

/** HTTP nach Drehbuch: jede Anfrage nimmt die nächste Antwort; Anfragen werden aufgezeichnet. */
export function fakeFetch(replies: Reply[]) {
  const requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    const next = replies.shift();
    if (!next) throw new TypeError("cannot connect");
    if ("fail" in next) throw next.fail;
    const parts = [...next.parts];
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        const p = parts.shift();
        if (p) c.enqueue(p);
        else if (next.failAfter) c.error(next.failAfter);
        else c.close();
      },
    });
    return new Response(body, { status: next.status, headers: next.headers ?? {} });
  };
  return { fetch, requests };
}

export function instant(slept: number[] = []): RetryPolicy {
  return new RetryPolicy({ jitter: () => 0, sleep: async (s) => void slept.push(s) });
}

export function memoryStore(node = "t"): WorkspaceStore {
  let t = 1000;
  return new WorkspaceStore({ node, persistence: new MemoryPersistence(), now: () => (t += 1) });
}

export async function collect(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

export type Scripted = { text?: string; thinking?: string; stop?: string; calls?: { id: string; name: string; arguments: Record<string, unknown> }[]; error?: unknown; usage?: { inputTokens: number; outputTokens: number } };

/** Anbieter nach Drehbuch: streamt Text wortweise und liefert die Antwort; merkt sich, was er gesehen hat. */
export class ScriptedProvider implements AIProvider {
  readonly id = "fake";
  readonly displayName = "Fake";
  readonly models = ["m"];
  readonly seen: ChatMessage[][] = [];
  readonly seenOptions: StreamOptions[] = [];
  constructor(private readonly script: Scripted[]) {}
  async stream(messages: ChatMessage[], opts: StreamOptions): Promise<AIResponse> {
    this.seen.push(messages.map((m) => ({ ...m })));
    this.seenOptions.push(opts);
    const step = this.script.shift();
    if (!step) throw new Error("script ran out");
    if (step.error !== undefined) throw step.error;
    const emit = (e: ProviderEvent) => opts.onEvent?.(e);
    if (step.thinking) emit({ type: "thinkingDelta", text: step.thinking });
    const words = (step.text ?? "").split(" ");
    words.forEach((w, i) => { if (step.text) emit({ type: "textDelta", text: i === 0 ? w : " " + w }); });
    for (const c of step.calls ?? []) {
      emit({ type: "toolStart", id: c.id, name: c.name });
      emit({ type: "toolInputDelta", id: c.id, json: JSON.stringify(c.arguments) });
    }
    await Promise.resolve();
    const r: AIResponse = {
      message: { role: "assistant", content: step.text ?? "", toolCalls: (step.calls ?? []).map((c) => ({ ...c, arguments: c.arguments as never })) },
      usage: step.usage ?? { inputTokens: 1, outputTokens: 1 },
      thinking: step.thinking ?? "",
    };
    if (step.stop) r.stopReason = step.stop;
    return r;
  }
}
