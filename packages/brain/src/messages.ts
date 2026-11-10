// Anbieter-neutrale Nachrichten, Werkzeug-Beschreibungen und Fehler (Swift BasedBrain/AI/Provider.swift).
import type { JSONValue } from "@based/core";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: JSONValue;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Vom Assistenten verlangte Tool-Calls (role = assistant). */
  toolCalls?: ToolCall[];
  /** role = tool: der Call, den diese Nachricht beantwortet. */
  toolCallID?: string;
  /**
   * Anthropic: die Inhaltsblöcke des Assistenten genau wie geliefert (Thinking mit Signatur, Text, tool_use). Wird in
   * einer Tool-Schleife unverändert zurückgeschickt – die API verlangt Thinking-Blöcke so, wie sie kamen.
   */
  rawContent?: JSONValue;
}

export const system = (content: string): ChatMessage => ({ role: "system", content });
export const user = (content: string): ChatMessage => ({ role: "user", content });
export const assistant = (content: string): ChatMessage => ({ role: "assistant", content });

/** Werkzeug-Beschreibung (für Modelle und später MCP). `inputSchema` ist ein JSON-Schema des Argument-Objekts. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JSONValue;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface AIResponse {
  message: ChatMessage;
  usage: Usage;
  stopReason?: string;
  /** Lesbare Thinking-Zusammenfassung; leer, wenn das Modell nicht gedacht hat. */
  thinking: string;
}

/** Die Antwort lief ins Längenlimit (Anthropic `max_tokens`, OpenAI `length`). */
export const isTruncated = (r: AIResponse): boolean => r.stopReason === "max_tokens" || r.stopReason === "length";

export type AIErrorKind = "missingKey" | "http" | "badResponse" | "unavailable" | "network";

/** Fehler eines Anbieters. Die Meldung enthält nie den Schlüssel (nur Status und den Antworttext des Servers). */
export class AIError extends Error {
  constructor(
    readonly kind: AIErrorKind,
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "AIError";
  }
  static missingKey(provider: string) { return new AIError("missingKey", `No API key configured for ${provider}.`); }
  static http(status: number, body: string) { return new AIError("http", `HTTP ${status}: ${body.slice(0, 400)}`, status, body); }
  static badResponse(m: string) { return new AIError("badResponse", `Unexpected response: ${m}`); }
  static unavailable(m: string) { return new AIError("unavailable", m); }
  static network(m: string) { return new AIError("network", m); }
}

/** Abbruch durch den Nutzer (AbortSignal). */
export class AbortError extends Error {
  constructor() {
    super("Stopped.");
    this.name = "AbortError";
  }
}

export const isAbort = (e: unknown): boolean => e instanceof AbortError || (e instanceof Error && e.name === "AbortError");

/** Ein Modell-Anbieter. Implementierungen: Anthropic, OpenAI-kompatibel (auch Ollama). */
export interface AIProvider {
  readonly id: string;
  readonly displayName: string;
  /** Vom Nutzer eingetragene Modelle (nichts fest verdrahtet). */
  readonly models: readonly string[];
  /**
   * Ein Modellaufruf, gestreamt: Thinking und Text kommen als `thinkingDelta`/`textDelta`, Tool-Calls als
   * `toolStart`/`toolInputDelta` über `onEvent`; zurück kommt die fertige Antwort.
   */
  stream(messages: ChatMessage[], opts: StreamOptions): Promise<AIResponse>;
}

export interface StreamOptions {
  model: string;
  tools: ToolSpec[];
  maxTokens: number;
  signal?: AbortSignal | undefined;
  onEvent?: ((e: ProviderEvent) => void) | undefined;
}

export type ProviderEvent =
  | { type: "thinkingDelta"; text: string }
  | { type: "textDelta"; text: string }
  | { type: "toolStart"; id: string; name: string }
  | { type: "toolInputDelta"; id: string; json: string };
