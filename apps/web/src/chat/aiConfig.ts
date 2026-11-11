// BSD-159: KI-Anbieter des Nutzers (BYOK). Was nicht geheim ist (Server-Adresse, Modell-Liste, gewähltes Modell,
// Permission) liegt im localStorage; API-Schlüssel ausschließlich in der verschlüsselten Ablage (shell/secrets.ts) –
// nie im Klartext im localStorage, nie in Logs, nie im Worker. Hier wird nichts ins Netz geschickt: die Engines
// rufen den eingestellten Anbieter erst auf, wenn der Nutzer eine Nachricht sendet.
// Modellnamen sind nicht fest verdrahtet: der Nutzer trägt die Modelle seines Anbieters ein.
// BSD-257: „ChatGPT“ ist kein API-Anbieter: Based nutzt den Login der offiziellen Codex-CLI auf dem based-server
// (ACP-Sitzung, BSD-223). Kein Schlüssel, kein OAuth-Client, nichts Geheimes im Browser; die Modelle sind die
// Stufen Low/Auto/High (BSD-242).
import {
  AnthropicProvider, CHATGPT_MODELS, CodexChatEngine, CodingClient, isComputeLevel, ModelEngine, OLLAMA_BASE_URL, OpenAIProvider, routeModel,
  type AIProvider, type ChatEngine, type ComputeLevel, type PermissionMode, type RouteDecision, type RouteTask, type ToolHost, type ToolPolicy,
} from "@based/brain";
import type { SecretStore } from "../shell/secrets.js";
import { secretVault, syncConfig } from "../shell/storage.js";

export type ProviderKind = "anthropic" | "openai" | "ollama" | "compatible" | "chatgpt";

export interface ProviderInfo {
  kind: ProviderKind;
  name: string;
  hint: string;
  defaultBaseURL: string;
  /** Ohne Schlüssel nicht nutzbar. */
  needsKey: boolean;
  /** Der Schlüssel ist freiwillig (lokale/eigene Server). */
  optionalKey?: boolean;
  /** Läuft über den verbundenen based-server (ChatGPT über Codex), nicht über eine Anbieter-Adresse. */
  viaServer?: boolean;
  modelsPlaceholder: string;
}

export const PROVIDERS: readonly ProviderInfo[] = [
  { kind: "anthropic", name: "Anthropic", hint: "Claude models with your own API key", defaultBaseURL: "https://api.anthropic.com", needsKey: true, modelsPlaceholder: "Model ids from your Anthropic console, comma-separated" },
  { kind: "openai", name: "OpenAI", hint: "GPT models with your own API key", defaultBaseURL: "https://api.openai.com/v1", needsKey: true, modelsPlaceholder: "Model ids from your OpenAI account, comma-separated" },
  { kind: "ollama", name: "Ollama", hint: "Models running on this computer — nothing leaves it", defaultBaseURL: OLLAMA_BASE_URL, needsKey: false, modelsPlaceholder: "Names from “ollama list”, comma-separated" },
  { kind: "chatgpt", name: "ChatGPT", hint: "Use your ChatGPT plan through the official Codex CLI on your based-server. You sign in with `codex login` there — Based never sees or stores your login.", defaultBaseURL: "", needsKey: false, viaServer: true, modelsPlaceholder: "" },
  { kind: "compatible", name: "OpenAI-compatible server", hint: "LM Studio, OpenRouter, vLLM or any server with a /chat/completions endpoint", defaultBaseURL: "", needsKey: false, optionalKey: true, modelsPlaceholder: "Model ids your server offers, comma-separated" },
];

export const providerInfo = (kind: ProviderKind): ProviderInfo => PROVIDERS.find((p) => p.kind === kind)!;

export interface ProviderSettings {
  baseURL: string;
  models: string[];
}

export interface AiSettings {
  v: 1;
  providers: Record<ProviderKind, ProviderSettings>;
  /** Gewähltes Modell als „<anbieter>/<modell>“. */
  model?: string;
  permission: PermissionMode;
  /** BSD-245: Modus vor dem Plan-Modus. */
  planReturn?: PermissionMode;
  /** BSD-242: Low/Auto/High wählt das Modell je Aufgabe (packages/brain routeModel); ohne: das gewählte Modell. */
  compute?: ComputeLevel;
}

export interface ModelChoice {
  ref: string;
  kind: ProviderKind;
  model: string;
  /** Schlüssel vorhanden (oder keiner nötig) und Adresse gesetzt. */
  usable: boolean;
}

export interface AiState {
  settings: AiSettings;
  /** Für welche Anbieter ein Schlüssel abgelegt ist (nur das – nie der Schlüssel selbst). */
  hasKey: Record<ProviderKind, boolean>;
  loaded: boolean;
}

const STORAGE_KEY = "based.ai";
const KINDS: ProviderKind[] = ["anthropic", "openai", "ollama", "chatgpt", "compatible"];
const secretName = (kind: ProviderKind) => "ai:" + kind;

export const emptySettings = (): AiSettings => ({
  v: 1,
  providers: Object.fromEntries(KINDS.map((k) => [k, { baseURL: providerInfo(k).defaultBaseURL, models: [] }])) as unknown as Record<ProviderKind, ProviderSettings>,
  permission: "askEdits",
});

/** „a, b\nc“ → ["a", "b", "c"] (ohne Doppelte). */
export function parseModelList(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((s) => s.trim()).filter((s) => s !== ""))];
}

export function splitModelRef(ref: string): { kind: ProviderKind; model: string } | undefined {
  const i = ref.indexOf("/");
  if (i <= 0) return undefined;
  const kind = ref.slice(0, i) as ProviderKind;
  return KINDS.includes(kind) && ref.length > i + 1 ? { kind, model: ref.slice(i + 1) } : undefined;
}

function sanitize(raw: unknown): AiSettings {
  const out = emptySettings();
  if (raw === null || typeof raw !== "object") return out;
  const r = raw as Partial<AiSettings>;
  for (const k of KINDS) {
    const p = r.providers?.[k];
    if (!p || typeof p !== "object") continue;
    if (typeof p.baseURL === "string") out.providers[k].baseURL = p.baseURL;
    if (Array.isArray(p.models)) out.providers[k].models = p.models.filter((m): m is string => typeof m === "string" && m !== "" && (k !== "chatgpt" || isComputeLevel(m)));
  }
  if (typeof r.model === "string") out.model = r.model;
  if (r.permission === "ask" || r.permission === "askEdits" || r.permission === "free" || r.permission === "plan") out.permission = r.permission;
  if (r.planReturn === "ask" || r.planReturn === "askEdits" || r.planReturn === "free") out.planReturn = r.planReturn;
  if (isComputeLevel(r.compute)) out.compute = r.compute;
  return out;
}

export interface AiConfigOptions {
  storage?: Pick<Storage, "getItem" | "setItem"> | undefined;
  secrets?: () => SecretStore;
  /** Verbundener based-server (für ChatGPT über Codex); Standard: Einstellungen → Sync & server. */
  server?: () => { url: string; token: string } | undefined;
}

/** Was eine Engine außer dem Modell braucht. */
export interface EngineOptions {
  tools?: ToolHost | undefined;
  policy?: ToolPolicy | undefined;
  system?: string | undefined;
  maxSteps?: number | undefined;
  maxTokensPerReply?: number | undefined;
  /** Chat bzw. Auftrag: Folge-Turns nutzen dieselbe Codex-Sitzung. */
  key?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  wrapProvider?: ((p: AIProvider) => AIProvider) | undefined;
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export class AiConfig {
  private state: AiState;
  private listeners = new Set<() => void>();
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  private readonly secretStore: () => SecretStore;
  private readonly server: () => { url: string; token: string } | undefined;
  /** Chat → Codex-Sitzung auf dem Server (nur für diese Seite; nach Neuladen beginnt eine neue mit Transkript). */
  private readonly codexSessions = new Map<string, string>();

  constructor(opts: AiConfigOptions = {}) {
    this.storage = "storage" in opts ? opts.storage : browserStorage();
    this.secretStore = opts.secrets ?? secretVault;
    this.server = opts.server ?? (() => { const c = syncConfig.get(); return c?.url ? { url: c.url, token: c.token } : undefined; });
    let raw: unknown;
    try {
      raw = JSON.parse(this.storage?.getItem(STORAGE_KEY) ?? "null");
    } catch {
      raw = undefined;
    }
    this.state = { settings: sanitize(raw), hasKey: { anthropic: false, openai: false, ollama: false, chatgpt: false, compatible: false }, loaded: false };
  }

  getState = (): AiState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<AiState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private save(settings: AiSettings) {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // nur für diese Sitzung
    }
    this.set({ settings });
  }

  /** Aus der verschlüsselten Ablage lesen, für welche Anbieter ein Schlüssel da ist. */
  async load(): Promise<void> {
    const hasKey = { ...this.state.hasKey };
    for (const k of KINDS) {
      if (providerInfo(k).viaServer) continue;
      try {
        hasKey[k] = await this.secretStore().hasSecret(secretName(k));
      } catch {
        hasKey[k] = false;
      }
    }
    this.set({ hasKey, loaded: true });
  }

  setProvider(kind: ProviderKind, patch: Partial<ProviderSettings>) {
    const s = this.state.settings;
    const next: AiSettings = { ...s, providers: { ...s.providers, [kind]: { ...s.providers[kind], ...patch } } };
    // Ein gewähltes Modell, das es nicht mehr gibt, abwählen.
    const chosen = next.model ? splitModelRef(next.model) : undefined;
    if (chosen && chosen.kind === kind && !next.providers[kind].models.includes(chosen.model)) delete next.model;
    this.save(next);
  }

  /** Schlüssel verschlüsselt ablegen (`undefined`/leer: entfernen). */
  async setKey(kind: ProviderKind, key: string | undefined): Promise<void> {
    const value = key?.trim() || undefined;
    await this.secretStore().setSecret(secretName(kind), value);
    this.set({ hasKey: { ...this.state.hasKey, [kind]: value !== undefined } });
  }

  /** Der Schlüssel selbst – nur für den Aufruf des Anbieters, nie anzeigen oder protokollieren. */
  async key(kind: ProviderKind): Promise<string | undefined> {
    try {
      return await this.secretStore().getSecret(secretName(kind));
    } catch {
      return undefined;
    }
  }

  /** Ein bestimmtes Modell wählen – schaltet Low/Auto/High aus (genaue Wahl gewinnt immer). */
  setModel(ref: string | undefined) {
    const next = { ...this.state.settings };
    if (ref) next.model = ref;
    else delete next.model;
    delete next.compute;
    this.save(next);
  }

  /** BSD-242: Low/Auto/High einschalten (`undefined` = wieder das gewählte Modell). */
  setCompute(level: ComputeLevel | undefined) {
    const next = { ...this.state.settings };
    if (level) next.compute = level;
    else delete next.compute;
    this.save(next);
  }

  /**
   * BSD-242: Modell für eine Aufgabe. Mit Low/Auto/High nach `routeModel` (Anbieter des gewählten Modells zuerst),
   * sonst das gewählte Modell. ChatGPT (Codex) hat eigene Stufen und bleibt außen vor.
   */
  modelFor(task: RouteTask): { choice: ModelChoice | undefined; route?: RouteDecision } {
    const level = this.state.settings.compute;
    const active = this.activeModel();
    if (!level) return { choice: active };
    const usable = this.models().filter((m) => m.usable && m.kind !== "chatgpt");
    if (usable.length === 0) return { choice: active };
    const route = routeModel(task, level, usable.map((m) => ({ ref: m.ref, ...(m.kind === "ollama" ? { onDevice: true } : {}) })), { defaultModel: active?.kind === "chatgpt" ? undefined : active?.ref });
    return { choice: usable.find((m) => m.ref === route.model) ?? active, route };
  }

  setPermission(permission: PermissionMode) {
    const cur = this.state.settings;
    // BSD-245: in den Plan-Modus merkt sich den Modus davor; „Plan ausführen“ kehrt dorthin zurück.
    const planReturn = permission === "plan" && cur.permission !== "plan" ? cur.permission : cur.planReturn;
    this.save({ ...cur, permission, ...(planReturn && planReturn !== "plan" ? { planReturn } : {}) });
  }

  /** Plan-Modus verlassen (nach „Plan ausführen“): zurück zum Modus davor (Standard: Ask before edits). */
  leavePlan() {
    if (this.state.settings.permission !== "plan") return;
    this.setPermission(this.state.settings.planReturn ?? "askEdits");
  }

  /** Alle eingetragenen Modelle. */
  models(): ModelChoice[] {
    const { settings, hasKey } = this.state;
    return KINDS.flatMap((kind) => {
      const p = settings.providers[kind];
      const usable = providerInfo(kind).viaServer ? this.server() !== undefined : p.baseURL.trim() !== "" && (!providerInfo(kind).needsKey || hasKey[kind]);
      return p.models.map((model) => ({ ref: `${kind}/${model}`, kind, model, usable }));
    });
  }

  /** Das Modell, das der Chat benutzt: das gewählte, sonst das erste nutzbare. */
  activeModel(): ModelChoice | undefined {
    const all = this.models().filter((m) => m.usable);
    return all.find((m) => m.ref === this.state.settings.model) ?? all[0];
  }

  /** BSD-257: ChatGPT (über Codex) ein- oder ausschalten; eingeschaltet wird es das gewählte Modell. */
  setChatGPT(on: boolean) {
    this.setProvider("chatgpt", { models: on ? [...CHATGPT_MODELS] : [] });
    if (on) this.setModel("chatgpt/auto");
  }

  /** Client für den verbundenen based-server (ChatGPT-Status); `undefined` ohne Verbindung. */
  codingClient(fetch?: typeof globalThis.fetch): CodingClient | undefined {
    const s = this.server();
    return s ? new CodingClient({ ...s, ...(fetch ? { fetch } : {}) }) : undefined;
  }

  /** Engine für ein Modell: API-Anbieter → ModelEngine, ChatGPT → Codex-Sitzung auf dem Server. */
  async engine(choice: ModelChoice, o: EngineOptions = {}): Promise<ChatEngine> {
    if (choice.kind === "chatgpt") {
      const backend = this.codingClient(o.fetch);
      if (!backend) throw new Error("ChatGPT runs through Codex on your based-server. Connect one in Settings → Sync & server.");
      const level = isComputeLevel(choice.model) ? choice.model : "auto";
      return new CodexChatEngine({ backend, level, sessions: this.codexSessions, key: o.key, policy: o.policy, system: o.system });
    }
    let provider = await this.provider(choice, o.fetch);
    if (o.wrapProvider) provider = o.wrapProvider(provider);
    return new ModelEngine({
      provider, model: choice.model,
      ...(o.tools ? { tools: o.tools } : {}), ...(o.policy ? { policy: o.policy } : {}), ...(o.system ? { system: o.system } : {}),
      ...(o.maxSteps ? { maxSteps: o.maxSteps } : {}), ...(o.maxTokensPerReply ? { maxTokensPerReply: o.maxTokensPerReply } : {}),
    });
  }

  /** Anbieter für ein Modell bauen (liest dafür den Schlüssel aus der Ablage). */
  async provider(choice: ModelChoice, fetch?: typeof globalThis.fetch): Promise<AIProvider> {
    if (choice.kind === "chatgpt") throw new Error("ChatGPT runs as a Codex session, not as an API provider.");
    const p = this.state.settings.providers[choice.kind];
    const key = (await this.key(choice.kind)) ?? "";
    const f = fetch ? { fetch: (url: string, init: RequestInit) => fetch(url, init) } : {};
    const baseURL = p.baseURL.trim();
    switch (choice.kind) {
      case "anthropic": return new AnthropicProvider({ apiKey: key, baseURL, models: p.models, browser: true, ...f });
      case "openai": return new OpenAIProvider({ apiKey: key, baseURL, models: p.models, ...f });
      case "ollama": return OpenAIProvider.ollama({ baseURL, models: p.models, ...f });
      case "compatible": return new OpenAIProvider({ id: "compatible", displayName: "OpenAI-compatible server", apiKey: key || "none", baseURL, models: p.models, ...f });
    }
  }
}

let shared: AiConfig | undefined;
/** Die Einstellungen dieser App (ein Objekt für Chat und Einstellungen). */
export const aiConfig = (): AiConfig => (shared ??= new AiConfig());
