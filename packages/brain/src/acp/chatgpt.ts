// BSD-257: „Mit ChatGPT anmelden“ – Chat und Agenten laufen über die offizielle Codex-CLI und deren Login
// („Sign in with ChatGPT“, `codex login`). Based registriert keinen eigenen OAuth-Client, liest keine Token und
// speichert keine Zugangsdaten: die Anmeldung erkennt es nur an `codex login status`, die Turns laufen als
// ACP-Sitzung (BSD-223) mit dem Codex-Adapter auf dem Rechner, auf dem Codex angemeldet ist (based-server bzw.
// Desktop-Sidecar). Modellwahl Low/Auto/High (BSD-242) bildet auf die Denkstufe von Codex ab.
// Plattformneutral: der Client spricht die /coding-Routen (`CodingClient`), der Prozessstart liegt in acp-node.
import { EventChannel, type ChatEngine, type ChatRequest, type PermissionMode, type ToolPolicy } from "../engine.js";
import type { ChatEvent, StoredChatEvent } from "../events.js";
import { isTerminal } from "../events.js";
import { AbortError } from "../messages.js";
import type { ComputeLevel } from "../routing.js";
import type { AgentDefinition } from "./agents.js";
import { handoffTranscript } from "./engine.js";
import type { InboxItem } from "./inbox.js";
import type { CodingSessionState, CodingSessionView } from "./sessions.js";

/** Wie die Codex-CLI angemeldet ist. `apiKey` zählt nicht als ChatGPT-Login (Based will das Abo nutzen). */
export type CodexLogin = "chatgpt" | "apiKey" | "none" | "unknown";

/**
 * Ausgabe von `codex login status` deuten (stdout und stderr zusammen; Exit-Code 0 = angemeldet). Bekannte Texte:
 * „Logged in using ChatGPT“, „Logged in using an API key - sk-…“, „Not logged in“.
 */
export function parseCodexLoginStatus(output: string, exitCode: number | null): CodexLogin {
  const t = output.toLowerCase();
  if (t.includes("not logged in")) return "none";
  if (t.includes("logged in")) {
    if (t.includes("chatgpt")) return "chatgpt";
    if (t.includes("api key")) return "apiKey";
    return exitCode === 0 ? "chatgpt" : "unknown";
  }
  if (exitCode !== null && exitCode !== 0 && t.trim() === "") return "none";
  return "unknown";
}

/** Denkstufe von Codex je Modellwahl (BSD-242). */
export const CODEX_EFFORT: Readonly<Record<ComputeLevel, "low" | "medium" | "high">> = { low: "low", auto: "medium", high: "high" };

/** Modellnamen, die der Anbieter „ChatGPT“ im Chat anbietet (= die drei Stufen). */
export const CHATGPT_MODELS: readonly ComputeLevel[] = ["auto", "low", "high"];

export const isComputeLevel = (v: unknown): v is ComputeLevel => v === "low" || v === "auto" || v === "high";

/**
 * Agent mit Denkstufe: hängt `-c model_reasoning_effort="…"` an (Codex-Konfig-Override, den auch der ACP-Adapter
 * annimmt). Nur für Codex; andere Agenten bleiben unverändert. Ein vorhandener Override wird ersetzt.
 */
export function withCodexEffort(agent: AgentDefinition, level: ComputeLevel | undefined): AgentDefinition {
  if (agent.id !== "codex" || level === undefined) return agent;
  const args: string[] = [];
  for (let i = 0; i < agent.args.length; i++) {
    if (agent.args[i] === "-c" && agent.args[i + 1]?.startsWith("model_reasoning_effort=")) { i++; continue; }
    args.push(agent.args[i]!);
  }
  return { ...agent, args: [...args, "-c", `model_reasoning_effort="${CODEX_EFFORT[level]}"`] };
}

/** Antwort von `GET /coding/chatgpt`. */
export interface ChatGPTStatus {
  /** Codex ist installiert, mit ChatGPT angemeldet und es gibt einen Ordner für Chat-Sitzungen. */
  ready: boolean;
  installed: boolean;
  version: string | undefined;
  login: CodexLogin;
  /** Ein Satz für die Oberfläche. */
  summary: string;
  /** Befehl fürs Terminal, der das Problem behebt (`codex login`, Installation …). */
  fix: string | undefined;
  /** Agent-ID der Codex-Sitzung (Standard „codex“). */
  agent: string;
  /** Arbeitsordner für Chat-Sitzungen (erster `--coding-root`). */
  cwd: string | undefined;
}

/** Zustand aus den Funden (rein; der Server liefert Pfad, Version, Login). */
export function chatgptStatus(input: { agentEnabled: boolean; path: string | undefined; version: string | undefined; login: CodexLogin; cwd: string | undefined; install: string }): ChatGPTStatus {
  const base = { installed: input.path !== undefined, version: input.version, login: input.login, agent: "codex", cwd: input.cwd };
  if (!input.agentEnabled) return { ...base, ready: false, summary: "The Codex agent is turned off on this server.", fix: undefined };
  if (!input.path) return { ...base, ready: false, summary: "The Codex CLI is not installed on the server. Install it, then sign in with ChatGPT.", fix: input.install };
  if (input.login === "none") return { ...base, ready: false, summary: "Codex is installed but not signed in. Run `codex login` on the server and choose “Sign in with ChatGPT”.", fix: "codex login" };
  if (input.login === "apiKey") return { ...base, ready: false, summary: "Codex is signed in with an API key, not with ChatGPT. Run `codex logout`, then `codex login` and choose “Sign in with ChatGPT”.", fix: "codex logout && codex login" };
  if (input.login === "unknown") return { ...base, ready: false, summary: "Couldn't tell whether Codex is signed in (`codex login status` gave no clear answer). Run `codex login` on the server.", fix: "codex login" };
  if (!input.cwd) return { ...base, ready: false, summary: "Codex is signed in with ChatGPT, but the server has no folder for agents. Start based-server with --coding-root <folder>.", fix: undefined };
  return { ...base, ready: true, summary: `Signed in with ChatGPT through Codex${input.version ? ` (${input.version})` : ""}.`, fix: undefined };
}

// MARK: Chat-Engine über den Server

/** Was die Engine vom Server braucht (erfüllt `CodingClient`). */
export interface CodexChatBackend {
  chatgpt(): Promise<ChatGPTStatus>;
  create(input: { agent: string; cwd: string; mode?: string; effort?: ComputeLevel; purpose?: "chat" | "coding" }): Promise<CodingSessionView>;
  session(id: string): Promise<CodingSessionView>;
  prompt(id: string, prompt: string): Promise<void>;
  events(id: string, since: number, waitMs?: number, signal?: AbortSignal): Promise<{ events: StoredChatEvent[]; next: number; state: CodingSessionState }>;
  inbox(since?: number, waitMs?: number, signal?: AbortSignal): Promise<{ version: number; items: InboxItem[] }>;
  answer(itemId: string, optionId: string | undefined): Promise<void>;
  cancel(id: string): Promise<void>;
  close(id: string): Promise<void>;
}

export interface CodexChatEngineOptions {
  backend: CodexChatBackend;
  level: ComputeLevel;
  /** Zuordnung Chat → Server-Sitzung (je Stufe), damit Folge-Turns dieselbe Codex-Sitzung nutzen. */
  sessions: Map<string, string>;
  /** Schlüssel des Chats (z. B. Chat-ID); ohne: jede Engine eine neue Sitzung. */
  key?: string | undefined;
  policy?: ToolPolicy | undefined;
  /** Feste Anweisungen (z. B. Meeting-Zusammenfassung), gehen wie Agent-Anweisungen mit. */
  system?: string | undefined;
  /** Long-Poll-Wartezeit je Anfrage (Standard 20 s). */
  waitMs?: number;
  /** Höchstens so viele Chat-Sitzungen offen halten; ältere werden beendet (Standard 2; der Server erlaubt 8). */
  keepSessions?: number;
}

const sessionMode = (m: PermissionMode | undefined): string => m ?? "askEdits";

/** Erste Option einer Art (`allow_once`, sonst irgendein allow; Ablehnen analog). */
function optionFor(item: InboxItem, allow: boolean): string | undefined {
  const want = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const k of want) {
    const o = item.options.find((x) => x.kind === k);
    if (o) return o.optionId;
  }
  return undefined;
}

/**
 * ChatEngine, deren Turns eine Codex-Sitzung auf dem Server ausführt. Ereignisse kommen per Long-Poll; Freigaben
 * dieser Sitzung beantwortet die Chat-Karte (`policy.approve`), nicht die Coding-Inbox.
 */
export class CodexChatEngine implements ChatEngine {
  constructor(private readonly o: CodexChatEngineOptions) {}

  get label(): string { return `ChatGPT (Codex, ${this.o.level})`; }

  run(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    const ch = new EventChannel<ChatEvent>();
    void this.turn(request, signal, (e) => ch.push(e)).then(() => ch.close(), (e) => ch.close(e));
    return ch;
  }

  private cacheKey(): string | undefined {
    return this.o.key !== undefined ? `${this.o.key}\n${this.o.level}` : undefined;
  }

  /** Bestehende Sitzung des Chats (noch nutzbar) oder neue; `fresh` = der Agent kennt den Verlauf noch nicht. */
  private async session(signal: AbortSignal): Promise<{ view: CodingSessionView; fresh: boolean }> {
    const b = this.o.backend;
    const key = this.cacheKey();
    const known = key !== undefined ? this.o.sessions.get(key) : undefined;
    if (known) {
      const view = await b.session(known).catch(() => undefined);
      if (view && (view.state === "idle" || view.state === "running")) return { view, fresh: false };
      this.o.sessions.delete(key!);
    }
    const status = await b.chatgpt();
    if (!status.ready || !status.cwd) throw new Error(status.summary + (status.fix ? ` (${status.fix})` : ""));
    if (signal.aborted) throw new AbortError();
    const view = await b.create({ agent: status.agent, cwd: status.cwd, mode: sessionMode(this.o.policy?.mode), effort: this.o.level, purpose: "chat" });
    if (view.state === "failed") throw new Error(`Codex could not start: ${view.error ?? "unknown error"}`);
    if (key !== undefined) {
      this.o.sessions.set(key, view.id);
      const keep = this.o.keepSessions ?? 2;
      for (const [k, id] of [...this.o.sessions]) {
        if (this.o.sessions.size <= keep) break;
        this.o.sessions.delete(k);
        void b.close(id).catch(() => undefined);
      }
    }
    return { view, fresh: true };
  }

  private async turn(request: ChatRequest, signal: AbortSignal, emit: (e: ChatEvent) => void): Promise<void> {
    if (signal.aborted) throw new AbortError();
    const b = this.o.backend;
    const { view, fresh } = await this.session(signal);
    const parts: string[] = [];
    const system = [this.o.system, request.system].filter((x): x is string => !!x?.trim()).join("\n\n");
    if (system) parts.push(`# Instructions\n\n${system}`);
    if (fresh && (request.history?.length ?? 0) > 0) parts.push(handoffTranscript(request.history!, "Based"));
    parts.push(request.prompt);
    let since = view.eventCount;
    await b.prompt(view.id, parts.join("\n\n"));

    const stop = new AbortController();
    const onAbort = () => { stop.abort(); void b.cancel(view.id).catch(() => undefined); };
    signal.addEventListener("abort", onAbort, { once: true });
    const approvals = this.answerPermissions(view, stop.signal);
    try {
      for (;;) {
        if (signal.aborted) throw new AbortError();
        const r = await b.events(view.id, since, this.o.waitMs ?? 20_000, stop.signal);
        since = r.next;
        let ended = false;
        for (const e of r.events) {
          if (e.type === "userMessage") continue;
          emit(e as ChatEvent);
          if (isTerminal(e)) ended = true;
        }
        if (ended) return;
        if (r.state !== "running" && r.events.length === 0) {
          if (r.state === "failed" || r.state === "closed") throw new Error("The Codex session ended.");
          return;
        }
      }
    } catch (e) {
      if (signal.aborted) throw new AbortError();
      throw e;
    } finally {
      signal.removeEventListener("abort", onAbort);
      stop.abort();
      await approvals.catch(() => undefined);
      // Ohne Chat-Schlüssel (Einzelaufruf): Sitzung gleich wieder beenden.
      if (this.cacheKey() === undefined) await b.close(view.id).catch(() => undefined);
    }
  }

  /** Offene Freigaben genau dieser Sitzung an die Chat-Karte geben, bis der Turn endet. */
  private async answerPermissions(view: CodingSessionView, signal: AbortSignal): Promise<void> {
    const b = this.o.backend;
    const handled = new Set<string>();
    let version: number | undefined;
    while (!signal.aborted) {
      let r: { version: number; items: InboxItem[] };
      try {
        r = await b.inbox(version, this.o.waitMs ?? 20_000, signal);
      } catch {
        if (signal.aborted) return;
        await new Promise((res) => setTimeout(res, 500));
        continue;
      }
      version = r.version;
      const acp = view.acpSessionId ?? (await b.session(view.id).catch(() => view)).acpSessionId;
      for (const item of r.items) {
        if (handled.has(item.id) || item.sessionId !== acp) continue;
        handled.add(item.id);
        const approve = this.o.policy?.approve;
        const ok = approve ? await approve({ id: item.toolCallId, name: item.title, arguments: { kind: item.kind, ...(item.argument ? { argument: item.argument } : {}), detail: item.detail } }) : false;
        if (signal.aborted) return;
        await b.answer(item.id, optionFor(item, ok)).catch(() => undefined);
      }
    }
  }
}
