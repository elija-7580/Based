// BSD-223 Teil 2: mehrere Coding-Agent-Sitzungen auf einem Rechner (Server oder Desktop-Sidecar). Plattformneutral:
// den Prozessstart liefert die Hülle (`connect`). Jede Sitzung hat ein Ereignis-Log (ChatEvents mit laufender
// Nummer), auf das beliebig viele Geräte per `events(since)` warten können (Long-Poll); die Freigabe-Inbox ist
// gemeinsam, jede Änderung zählt `inboxVersion` hoch. Agentenwechsel = neue Sitzung mit `handoffFrom`: der Verlauf
// der alten Sitzung geht als Transkript an den neuen Agenten.
import type { ChatEvent, StoredChatEvent } from "../events.js";
import { runTurn } from "../engine.js";
import type { ChatMessage } from "../messages.js";
import { historyFromEvents } from "../history.js";
import { Permissions, parseMode } from "../agents/permissions.js";
import type { PermissionMode } from "../engine.js";
import { pathWithin, normalizePath, type AcpMcpServer, type AgentDefinition } from "./agents.js";
import type { AcpClient, AcpCommand } from "./client.js";
import { AcpEngine } from "./engine.js";
import { withCodexEffort } from "./chatgpt.js";
import type { ComputeLevel } from "../routing.js";
import { PermissionInbox, type InboxItem } from "./inbox.js";

export type CodingSessionState = "starting" | "idle" | "running" | "failed" | "closed";

export interface CodingSessionView {
  id: string;
  agentId: string;
  agentName: string;
  cwd: string;
  state: CodingSessionState;
  /** Sitzungs-ID beim Agenten (zum Fortsetzen). */
  acpSessionId: string | undefined;
  mode: PermissionMode;
  /** Modi des Agenten (ACP `availableModes`, z. B. Default/Plan bei Claude Code); ⇧Tab schaltet durch (BSD-313). */
  modes: { id: string; name: string }[];
  /** Aktueller Modus des Agenten. */
  agentMode: string | undefined;
  /** BSD-313: Slash-Befehle, die der Agent gemeldet hat. */
  commands: AcpCommand[];
  createdAt: number;
  /** Anzahl Ereignisse (nächstes `since`). */
  eventCount: number;
  error: string | undefined;
  handoffFrom: string | undefined;
}

export interface ConnectedAgent {
  client: AcpClient;
  stop(): void;
}

export interface CodingSessionsOptions {
  agents: () => readonly AgentDefinition[];
  /** Prozess starten und `initialize` machen (Hülle). `roots`: Ordner, in denen der Agent Dateien lesen/schreiben darf. */
  connect: (agent: AgentDefinition, cwd: string, roots: readonly string[], permissions: () => Permissions) => Promise<ConnectedAgent>;
  /** Nur in diesen Ordnern dürfen Sitzungen laufen. */
  roots: readonly string[];
  mcpServers?: () => readonly AcpMcpServer[];
  /** BSD-257: MCP-Server für Chat-Sitzungen (z. B. die Werkzeuge des Workspaces über /mcp). */
  chatMcpServers?: () => readonly AcpMcpServer[];
  /** Globale Regeln (Text wie in den Einstellungen). */
  rules?: () => string | undefined;
  now?: () => number;
  /** Höchstens so viele offene Sitzungen (Standard 8). */
  maxSessions?: number;
}

export class CodingError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

interface Waiter { resolve: () => void }

class Session {
  readonly events: StoredChatEvent[] = [];
  state: CodingSessionState = "starting";
  error: string | undefined;
  engine: AcpEngine | undefined;
  agentProcess: ConnectedAgent | undefined;
  turn: AbortController | undefined;
  waiters: Waiter[] = [];
  /** Verlauf früherer Agenten (Agentenwechsel), geht beim ersten Prompt als Transkript mit. */
  handoffHistory: ChatMessage[] = [];
  constructor(
    readonly id: string,
    readonly agent: AgentDefinition,
    readonly cwd: string,
    public mode: PermissionMode,
    readonly createdAt: number,
    readonly handoffFrom: string | undefined,
  ) {}
  wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const x of w) x.resolve();
  }
}

export class CodingSessions {
  readonly inbox: PermissionInbox;
  /** BSD-314: wird mit der ID gerufen, wenn eine Sitzung endet (z. B. ihr Terminal schließen). */
  readonly onClosed = new Set<(id: string) => void>();
  private readonly sessions = new Map<string, Session>();
  private counter = 0;
  private inboxVer = 0;
  private inboxWaiters: Waiter[] = [];

  constructor(private readonly o: CodingSessionsOptions) {
    this.inbox = new PermissionInbox(o.now);
    this.inbox.subscribe(() => {
      this.inboxVer++;
      const w = this.inboxWaiters;
      this.inboxWaiters = [];
      for (const x of w) x.resolve();
    });
  }

  get inboxVersion(): number { return this.inboxVer; }

  /** Erlaubte Ordner (der erste dient Chat-Sitzungen als Arbeitsordner, BSD-257). */
  get roots(): readonly string[] { return this.o.roots; }

  agents(): AgentDefinition[] {
    return this.o.agents().filter((a) => a.enabled);
  }

  list(): CodingSessionView[] {
    return [...this.sessions.values()].map((s) => this.view(s));
  }

  get(id: string): CodingSessionView | undefined {
    const s = this.sessions.get(id);
    return s ? this.view(s) : undefined;
  }

  /** Sitzung anlegen und Agenten starten. `handoffFrom`: Verlauf dieser Sitzung geht an den neuen Agenten. */
  async create(input: { agentId: string; cwd: string; mode?: string | undefined; resume?: string | undefined; handoffFrom?: string | undefined; effort?: ComputeLevel | undefined; purpose?: "chat" | "coding" | undefined }): Promise<CodingSessionView> {
    const found = this.agents().find((a) => a.id === input.agentId);
    // BSD-257: Denkstufe (Low/Auto/High) als Codex-Konfig-Override; andere Agenten bleiben gleich.
    const agent = found ? withCodexEffort(found, input.effort) : undefined;
    if (!agent) throw new CodingError(`unknown or disabled agent: ${input.agentId}`, 400);
    if (!input.cwd.startsWith("/")) throw new CodingError("cwd must be an absolute path", 400);
    const cwd = normalizePath(input.cwd);
    if (!this.o.roots.some((r) => pathWithin(r, cwd))) throw new CodingError("cwd is outside the allowed folders", 403);
    const open = [...this.sessions.values()].filter((s) => s.state !== "closed" && s.state !== "failed").length;
    if (open >= (this.o.maxSessions ?? 8)) throw new CodingError("too many open sessions", 429);
    const from = input.handoffFrom !== undefined ? this.sessions.get(input.handoffFrom) : undefined;
    if (input.handoffFrom !== undefined && !from) throw new CodingError("handoff session not found", 404);
    const mode = (input.mode !== undefined ? parseMode(input.mode) : undefined) ?? "askEdits";
    const s = new Session(`cs-${++this.counter}`, agent, cwd, mode, (this.o.now ?? Date.now)(), from?.id);
    this.sessions.set(s.id, s);
    const permissions = () => this.permissionsFor(s);
    if (from) s.handoffHistory = [...from.handoffHistory, ...historyFromEvents(from.events)];
    try {
      const proc = await this.o.connect(agent, cwd, [cwd], permissions);
      s.agentProcess = proc;
      // BSD-313: Befehle und Modus kommen auch außerhalb eines Turns; wartende Geräte (Long-Poll) erfahren davon.
      proc.client.onStateChange = () => s.wake();
      s.engine = new AcpEngine({
        agent,
        connect: async () => proc.client,
        cwd,
        mcpServers: [...(this.o.mcpServers?.() ?? []), ...(input.purpose === "chat" ? this.o.chatMcpServers?.() ?? [] : [])],
        resumeSessionId: input.resume,
        inbox: this.inbox,
        permissions,
        handoffFrom: from?.agent.name,
      });
      await s.engine.ensureSession();
      s.state = "idle";
    } catch (e) {
      s.state = "failed";
      s.error = e instanceof Error ? e.message : String(e);
      s.agentProcess?.stop();
    }
    s.wake();
    return this.view(s);
  }

  setMode(id: string, mode: string): CodingSessionView {
    const s = this.require(id);
    const m = parseMode(mode);
    if (!m) throw new CodingError("mode must be ask, askEdits, free or plan", 400);
    s.mode = m;
    return this.view(s);
  }

  /** BSD-313: Modus des Agenten setzen (ACP `session/set_mode`), z. B. per ⇧Tab. */
  async setAgentMode(id: string, modeId: string): Promise<CodingSessionView> {
    const s = this.require(id);
    const client = s.agentProcess?.client;
    if (!client || s.state === "closed" || s.state === "failed") throw new CodingError(`session is ${s.state}`, 409);
    if (!client.availableModes.some((m) => m.id === modeId)) throw new CodingError(`unknown mode: ${modeId}`, 400);
    await client.setMode(modeId);
    return this.view(s);
  }

  /**
   * BSD-313: @Dateien → `file://`-Verweise. Nur relative Pfade unterhalb des Arbeitsordners (kein `..`, nichts
   * Absolutes): was nicht passt, lehnt die Anfrage ab, statt still etwas anderes zu schicken.
   */
  private fileLinks(cwd: string, files: readonly string[]): { uri: string; name: string }[] {
    return files.map((f) => {
      const rel = f.replace(/^\.\/+/, "");
      const abs = normalizePath(cwd + "/" + rel);
      if (rel === "" || rel.startsWith("/") || !pathWithin(cwd, abs) || abs === cwd) throw new CodingError(`file is outside the session folder: ${f}`, 403);
      return { uri: "file://" + abs.split("/").map(encodeURIComponent).join("/"), name: rel };
    });
  }

  /** Turn starten; Ereignisse kommen über `events`. Läuft schon einer: 409. `files`: @Dateien relativ zum Arbeitsordner. */
  prompt(id: string, text: string, files: readonly string[] = []): void {
    const s = this.require(id);
    const links = this.fileLinks(s.cwd, files);
    if (s.state === "running") throw new CodingError("a turn is already running", 409);
    if (s.state !== "idle" || !s.engine) throw new CodingError(`session is ${s.state}`, 409);
    const engine = s.engine;
    const history = [...s.handoffHistory, ...historyFromEvents(s.events)];
    const ctl = new AbortController();
    s.turn = ctl;
    s.state = "running";
    const push = (e: StoredChatEvent) => { s.events.push(e); s.wake(); };
    push({ type: "userMessage", text: links.length > 0 ? `${text}\n\n${links.map((l) => "@" + l.name).join(" ")}` : text, at: (this.o.now ?? Date.now)() });
    void (async () => {
      try {
        for await (const e of runTurn(engine, { prompt: text, history, ...(links.length > 0 ? { files: links } : {}) }, ctl.signal)) push(e as ChatEvent);
      } finally {
        s.turn = undefined;
        if (s.state === "running") s.state = s.agentProcess && !s.agentProcess.client.peer.closed ? "idle" : "failed";
        if (s.state === "failed") s.error ??= "The agent process exited.";
        s.wake();
      }
    })();
  }

  cancel(id: string): void {
    this.require(id).turn?.abort();
  }

  /** Sitzung beenden: Turn stoppen, offene Fragen abbrechen, Prozess beenden. Das Log bleibt lesbar. */
  close(id: string): void {
    const s = this.require(id);
    s.turn?.abort();
    if (s.engine?.sessionId) this.inbox.cancelSession(s.engine.sessionId);
    s.agentProcess?.stop();
    s.state = "closed";
    s.wake();
    for (const fn of this.onClosed) fn(id);
  }

  closeAll(): void {
    for (const s of this.sessions.values()) if (s.state !== "closed") this.close(s.id);
  }

  /**
   * Ereignisse ab `since`. Gibt es keine neuen und läuft die Sitzung noch, wird bis `waitMs` gewartet (Long-Poll);
   * `signal` bricht das Warten ab (Client weg).
   */
  async events(id: string, since: number, waitMs = 0, signal?: AbortSignal): Promise<{ events: StoredChatEvent[]; next: number; state: CodingSessionState; session: CodingSessionView }> {
    const s = this.require(id);
    if (since >= s.events.length && waitMs > 0 && (s.state === "running" || s.state === "starting" || s.state === "idle")) {
      await this.wait(s.waiters, waitMs, signal);
    }
    const from = Math.min(Math.max(0, since), s.events.length);
    return { events: s.events.slice(from), next: s.events.length, state: s.state, session: this.view(s) };
  }

  /** Offene Freigaben; wartet bis `waitMs`, wenn `since` der aktuelle Stand ist. */
  async pendingPermissions(since: number | undefined, waitMs = 0, signal?: AbortSignal): Promise<{ version: number; items: InboxItem[] }> {
    if (since !== undefined && since === this.inboxVer && waitMs > 0) await this.wait(this.inboxWaiters, waitMs, signal);
    return { version: this.inboxVer, items: this.inbox.pending() };
  }

  answer(itemId: string, optionId: string | undefined): boolean {
    return this.inbox.resolve(itemId, optionId);
  }

  private wait(list: Waiter[], ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); signal?.removeEventListener("abort", done); const i = list.indexOf(w); if (i >= 0) list.splice(i, 1); resolve(); };
      const w: Waiter = { resolve: done };
      const t = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      list.push(w);
    });
  }

  private permissionsFor(s: Session): Permissions {
    return Permissions.from(this.o.rules?.() ?? "", s.mode);
  }

  private require(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new CodingError("session not found", 404);
    return s;
  }

  private view(s: Session): CodingSessionView {
    return {
      id: s.id,
      agentId: s.agent.id,
      agentName: s.agent.name,
      cwd: s.cwd,
      state: s.state,
      acpSessionId: s.engine?.sessionId,
      mode: s.mode,
      modes: s.agentProcess?.client.availableModes ?? [],
      agentMode: s.agentProcess?.client.currentMode,
      commands: s.agentProcess?.client.availableCommands ?? [],
      createdAt: s.createdAt,
      eventCount: s.events.length,
      error: s.error,
      handoffFrom: s.handoffFrom,
    };
  }
}
