// BSD-243 Teil 2: Modell für Läufe auf dem Server (Zeitpläne bei geschlossener App). Eingerichtet über
// BASED_ANTHROPIC_API_KEY (+ optional BASED_AGENT_MODEL); Werkzeuge: die Workspace-Werkzeuge über den Server-Store.
// MCP-Connections der Agenten laufen auf dem Server (noch) nicht mit – sie leben in der App.
import { AnthropicProvider, ModelEngine, WorkspaceTools, type AgentRunnerOptions, type FetchLike } from "@based/brain";
import type { WorkspaceStore } from "@based/core";

export const DEFAULT_AGENT_MODEL = "claude-sonnet-5-5";

export interface ServerModelOptions {
  apiKey: string;
  /** Standardmodell, wenn der Lauf keines (oder eines anderen Anbieters) nennt. */
  model?: string | undefined;
  /** BSD-392: Modell für Läufe, deren Agent über 80 % seines Budgets ist (BASED_AGENT_LOW_MODEL); ohne: das Standardmodell. */
  lowModel?: string | undefined;
  baseURL?: string | undefined;
  fetch?: FetchLike;
}

/** Modell des Laufs („anthropic/<modell>“ oder nur „<modell>“), sonst das Standardmodell. */
export function serverModelFor(ref: string | undefined, fallback: string): string {
  if (!ref) return fallback;
  const slash = ref.indexOf("/");
  if (slash < 0) return ref.startsWith("claude") ? ref : fallback;
  return ref.slice(0, slash) === "anthropic" && ref.length > slash + 1 ? ref.slice(slash + 1) : fallback;
}

/** Engine-Fabrik für den AgentRunner des Servers. */
export function anthropicAgentEngine(store: WorkspaceStore, o: ServerModelOptions): AgentRunnerOptions["engine"] {
  const provider = new AnthropicProvider({ apiKey: o.apiKey, ...(o.baseURL ? { baseURL: o.baseURL } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) });
  const tools = new WorkspaceTools(store);
  const fallback = o.model || DEFAULT_AGENT_MODEL;
  const low = o.lowModel || fallback;
  return (req) => new ModelEngine({ provider, model: serverModelFor(req.model, req.forceLow ? low : fallback), tools, policy: req.policy });
}
