// BSD-199: der Redact-Schritt in der Engine-Schicht. `RedactingProvider` sitzt vor JEDEM Aufruf eines externen
// Modells (System-Prompt, Verlauf, Eingabe, Tool-Ergebnisse, die der Agent nachlädt) und tauscht in der Antwort
// (Text, Thinking, Tool-Argumente) zurück – so führen Werkzeuge mit echten Werten aus. `RedactingEngine` macht
// dasselbe für Engines ohne Anbieter-Schnittstelle (ScriptedEngine; später Server-Engines, die Text bekommen).
// CLI-Engines (Claude Code, Codex) schicken selbst an ihren Anbieter: dort nur Warnung (`redactionPlan`).
import type { ChatEngine, ChatRequest } from "../engine.js";
import type { ChatEvent } from "../events.js";
import type { AIProvider, AIResponse, ChatMessage, StreamOptions } from "../messages.js";
import type { Redactor } from "./redactor.js";

/** Wo eine Engine ihr Modell aufruft. */
export type EngineReach = "external" | "local" | "cli";

export type RedactionPlan =
  /** Platzhalter vor dem Aufruf, Rücktausch danach. */
  | "redact"
  /** Aus oder nicht nötig (lokales Modell). */
  | "off"
  /** CLI-Engine: Based kann nicht schwärzen – nur Hinweis, kein Blockieren (Entscheidung 09.11.2026). */
  | "warn";

export function redactionPlan(enabled: boolean, reach: EngineReach): RedactionPlan {
  if (!enabled || reach === "local") return "off";
  return reach === "cli" ? "warn" : "redact";
}

export const CLI_REDACT_WARNING = "Redaction is on, but this engine sends your text to its provider itself — Based can't redact it. Use an API model for private content.";

export function redactMessages(r: Redactor, messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    const out: ChatMessage = { ...m, content: r.redact(m.content).text };
    if (m.toolCalls) out.toolCalls = m.toolCalls.map((c) => ({ ...c, arguments: r.redactJSON(c.arguments) }));
    // rawContent kommt so vom Anbieter (mit Platzhaltern) und muss unverändert zurück (Thinking-Signaturen).
    return out;
  });
}

export class RedactingProvider implements AIProvider {
  constructor(private readonly inner: AIProvider, private readonly redactor: Redactor) {}

  get id() { return this.inner.id; }
  get displayName() { return this.inner.displayName; }
  get models() { return this.inner.models; }

  async stream(messages: ChatMessage[], opts: StreamOptions): Promise<AIResponse> {
    const r = this.redactor;
    const text = r.streamRestorer();
    const thinking = r.streamRestorer();
    const onEvent = opts.onEvent;
    const res = await this.inner.stream(redactMessages(r, messages), {
      ...opts,
      onEvent: onEvent && ((e) => {
        if (e.type === "textDelta") {
          const t = text.push(e.text);
          if (t) onEvent({ type: "textDelta", text: t });
        } else if (e.type === "thinkingDelta") {
          const t = thinking.push(e.text);
          if (t) onEvent({ type: "thinkingDelta", text: t });
        } else onEvent(e);
      }),
    });
    if (onEvent) {
      const t = text.flush();
      if (t) onEvent({ type: "textDelta", text: t });
      const th = thinking.flush();
      if (th) onEvent({ type: "thinkingDelta", text: th });
    }
    const message: ChatMessage = { ...res.message, content: r.restore(res.message.content) };
    if (res.message.toolCalls) message.toolCalls = res.message.toolCalls.map((c) => ({ ...c, arguments: r.restoreJSON(c.arguments) }));
    return { ...res, message, thinking: r.restore(res.thinking) };
  }
}

/** Ereignisse einer Engine zurücktauschen (Deltas gepuffert, damit kein halber Platzhalter erscheint). */
export async function* restoreEvents(r: Redactor, events: AsyncIterable<ChatEvent>): AsyncGenerator<ChatEvent> {
  let text = r.streamRestorer();
  let thinking = r.streamRestorer();
  for await (const e of events) {
    switch (e.type) {
      case "textDelta": {
        const t = text.push(e.text);
        if (t) yield { ...e, text: t };
        break;
      }
      case "thinkingDelta": {
        const t = thinking.push(e.text);
        if (t) yield { ...e, text: t };
        break;
      }
      case "text": {
        const rest = text.flush();
        if (rest) yield { type: "textDelta", text: rest };
        text = r.streamRestorer();
        yield { ...e, text: r.restore(e.text) };
        break;
      }
      case "thinking":
        thinking.flush();
        thinking = r.streamRestorer();
        yield { ...e, text: r.restore(e.text) };
        break;
      case "toolUse":
        yield { ...e, input: r.restoreJSON(e.input) };
        break;
      case "toolResult":
        yield { ...e, output: r.restore(e.output) };
        break;
      case "result":
        yield { ...e, text: r.restore(e.text) };
        break;
      default:
        yield e;
    }
  }
}

export class RedactingEngine implements ChatEngine {
  constructor(private readonly inner: ChatEngine, private readonly redactor: Redactor) {}

  get label() { return this.inner.label; }

  run(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    const r = this.redactor;
    const redacted: ChatRequest = { prompt: r.redact(request.prompt).text };
    if (request.history) redacted.history = redactMessages(r, request.history);
    if (request.system) redacted.system = r.redact(request.system).text;
    return restoreEvents(r, this.inner.run(redacted, signal));
  }
}
