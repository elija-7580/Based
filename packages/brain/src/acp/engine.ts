// BSD-223: Coding-Agent-Sitzung als ChatEngine (ADR 0005: ein ChatEvent-Strom für alle Engines). Damit zeigen
// Chat-Ansicht, Transkript (BSD-77) und Konsole einen ACP-Agenten genauso wie ein API-Modell.
// - Updates → ChatEvents: Text/Thinking als Deltas, Tool-Calls als toolUse/toolResult (Diffs im Input), Plan als
//   eigener Tool-Eintrag „plan“, Verbrauch als usage.
// - Freigaben: erst Berechtigungen (Modus + Regeln), dann die Inbox; solange gefragt wird: permissionRequest.
// - Agentenwechsel: eine neue Sitzung mit Verlauf bekommt beim ersten Prompt das bisherige Transkript als Ressource
//   (Transkript-Übergabe, wie Swift „handoff“).
// - Abbruch: `session/cancel`, offene Fragen der Sitzung werden abgebrochen.
import type { JSONValue } from "@based/core";
import { EventChannel, type ChatEngine, type ChatRequest } from "../engine.js";
import type { ChatEvent } from "../events.js";
import type { ChatMessage } from "../messages.js";
import { AbortError } from "../messages.js";
import { Permissions } from "../agents/permissions.js";
import type { AcpMcpServer, AgentDefinition } from "./agents.js";
import type { AcpClient, AcpDiff, AcpPromptBlock, AcpStopReason, AcpUpdate } from "./client.js";
import { autoDecide, type AcpPermissionRequest, type PermissionInbox } from "./inbox.js";

export const PLAN_TOOL_ID = "acp-plan";
export const HANDOFF_URI = "based://handoff/transcript.md";

/** Bisheriges Gespräch als Markdown für den neuen Agenten (Tool-Ergebnisse gekürzt, Systemtext weg). */
export function handoffTranscript(history: readonly ChatMessage[], fromAgent?: string): string {
  const lines: string[] = [`# Conversation so far${fromAgent ? ` (with ${fromAgent})` : ""}`, ""];
  for (const m of history) {
    if (m.role === "system") continue;
    if (m.role === "user") lines.push(`## User`, "", m.content, "");
    else if (m.role === "assistant") {
      if (m.content.trim() !== "") lines.push(`## Assistant`, "", m.content, "");
      for (const c of m.toolCalls ?? []) lines.push(`- tool \`${c.name}\` ${JSON.stringify(c.arguments).slice(0, 300)}`);
    } else if (m.role === "tool") {
      const t = m.content.length > 1500 ? m.content.slice(0, 1500) + "…" : m.content;
      lines.push("```", t, "```", "");
    }
  }
  lines.push("Continue from here. The user's next message follows.");
  return lines.join("\n");
}

/** Unified-Diff-artige Kurzform für die Anzeige im Tool-Ergebnis (zeilenweise, ohne Kontextsuche). */
export function diffText(d: AcpDiff): string {
  const old = d.oldText === "" ? [] : d.oldText.split("\n");
  const neu = d.newText === "" ? [] : d.newText.split("\n");
  let a = 0;
  while (a < old.length && a < neu.length && old[a] === neu[a]) a++;
  let b = 0;
  while (b < old.length - a && b < neu.length - a && old[old.length - 1 - b] === neu[neu.length - 1 - b]) b++;
  const out = [`--- ${d.path}`, `+++ ${d.path}`, `@@ -${a + 1},${old.length - a - b} +${a + 1},${neu.length - a - b} @@`];
  for (const l of old.slice(a, old.length - b)) out.push(`-${l}`);
  for (const l of neu.slice(a, neu.length - b)) out.push(`+${l}`);
  return out.join("\n");
}

const STOP_TEXT: Partial<Record<AcpStopReason, string>> = {
  max_tokens: "The agent stopped: token limit reached.",
  max_turn_requests: "The agent stopped: too many steps in one turn.",
  refusal: "The agent refused to continue.",
};

export interface AcpEngineOptions {
  agent: AgentDefinition;
  /** Liefert einen initialisierten Client (Prozess gestartet, `initialize` erledigt). */
  connect: () => Promise<AcpClient>;
  cwd: string;
  mcpServers?: readonly AcpMcpServer[];
  /** Bestehende Sitzung fortsetzen (`session/load`, falls der Agent es kann). */
  resumeSessionId?: string | undefined;
  inbox: PermissionInbox;
  /** Modus + Regeln; ohne: „askEdits“ ohne Regeln. Funktion = jeweils aktueller Stand (Modus änderbar). */
  permissions?: Permissions | (() => Permissions) | undefined;
  /** Name des vorherigen Agenten bei einem Wechsel (für die Übergabe). */
  handoffFrom?: string | undefined;
}

export class AcpEngine implements ChatEngine {
  private client: AcpClient | undefined;
  private handedOff = false;
  /** Laufende Sitzung (nach dem ersten Turn). */
  sessionId: string | undefined;

  constructor(private readonly o: AcpEngineOptions) {}

  get label(): string { return this.o.agent.name; }

  /** Verbinden und Sitzung anlegen/laden (idempotent). */
  async ensureSession(): Promise<AcpClient> {
    if (this.client?.sessionId) return this.client;
    const c = this.client ?? (await this.o.connect());
    this.client = c;
    const resume = this.o.resumeSessionId;
    if (resume && c.loadSessionSupported) {
      await c.loadSession(resume, this.o.cwd, this.o.mcpServers ?? []);
      this.handedOff = true;
    } else {
      await c.newSession(this.o.cwd, this.o.mcpServers ?? []);
    }
    this.sessionId = c.sessionId;
    return c;
  }

  run(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    const ch = new EventChannel<ChatEvent>();
    void this.turn(request, signal, (e) => ch.push(e)).then(() => ch.close(), (e) => ch.close(e));
    return ch;
  }

  private async turn(request: ChatRequest, signal: AbortSignal, emit: (e: ChatEvent) => void): Promise<void> {
    if (signal.aborted) throw new AbortError();
    const c = await this.ensureSession();
    const sessionId = c.sessionId!;
    emit({ type: "started", model: this.o.agent.name, sessionID: sessionId });

    const blocks: AcpPromptBlock[] = [];
    if (!this.handedOff && (request.history?.length ?? 0) > 0) {
      blocks.push({ type: "resource", uri: HANDOFF_URI, text: handoffTranscript(request.history!, this.o.handoffFrom) });
    }
    this.handedOff = true;
    if (request.system?.trim()) blocks.push({ type: "resource", uri: "based://instructions.md", text: request.system });
    blocks.push({ type: "text", text: request.prompt });
    for (const f of request.files ?? []) blocks.push({ type: "resource_link", uri: f.uri, name: f.name });

    let text = "";
    const tools = new Map<string, { title: string; input: JSONValue; diffs: AcpDiff[]; output: string | undefined }>();
    c.onUpdate = (u, sid) => { if (sid === sessionId || sid === "") this.map(u, emit, tools, (t) => { text += t; }); };
    c.onPermission = (req) => this.permission(req, signal, emit);

    const onAbort = () => { c.cancel(); this.o.inbox.cancelSession(sessionId); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const reason = await c.prompt(blocks);
      if (signal.aborted || reason === "cancelled") throw new AbortError();
      for (const [id, t] of tools) if (t.output === undefined) emit({ type: "toolResult", id, output: "", isError: false });
      const stop = STOP_TEXT[reason];
      if (stop) emit({ type: "notice", text: stop });
      emit({ type: "text", text });
      emit({ type: "result", text, sessionID: sessionId, isError: reason === "refusal" });
    } finally {
      signal.removeEventListener("abort", onAbort);
      c.onUpdate = undefined;
      c.onPermission = undefined;
    }
  }

  private map(u: AcpUpdate, emit: (e: ChatEvent) => void, tools: Map<string, { title: string; input: JSONValue; diffs: AcpDiff[]; output: string | undefined }>, addText: (t: string) => void): void {
    switch (u.type) {
      case "agentText":
        if (u.text !== "") { addText(u.text); emit({ type: "textDelta", text: u.text }); }
        break;
      case "agentThought":
        if (u.text !== "") emit({ type: "thinkingDelta", text: u.text });
        break;
      case "toolCall": {
        const input = withDiffs(u.input, u.diffs);
        tools.set(u.id, { title: u.title, input, diffs: u.diffs, output: undefined });
        emit({ type: "toolUse", id: u.id, name: u.title, input });
        if (u.status === "completed" || u.status === "failed") this.finishTool(u.id, u.status, undefined, emit, tools);
        break;
      }
      case "toolCallUpdate": {
        let t = tools.get(u.id);
        if (!t) { t = { title: u.title ?? "tool", input: {}, diffs: [], output: undefined }; tools.set(u.id, t); emit({ type: "toolUse", id: u.id, name: t.title, input: {} }); }
        if (u.diffs.length > 0 || (u.title && u.title !== t.title)) {
          t.diffs = [...t.diffs, ...u.diffs];
          t.title = u.title ?? t.title;
          t.input = withDiffs(t.input, u.diffs);
          emit({ type: "toolUse", id: u.id, name: t.title, input: t.input });
        }
        if (u.output !== undefined) t.output = u.output;
        if (u.status === "completed" || u.status === "failed") this.finishTool(u.id, u.status, u.output, emit, tools);
        break;
      }
      case "plan": {
        const out = u.entries.map((e) => `${e.status === "completed" ? "[x]" : e.status === "in_progress" ? "[~]" : "[ ]"} ${e.content}`).join("\n");
        emit({ type: "toolUse", id: PLAN_TOOL_ID, name: "Plan", input: { entries: u.entries.length } });
        emit({ type: "toolResult", id: PLAN_TOOL_ID, output: out, isError: false });
        break;
      }
      case "usage":
        emit({ type: "usage", inputTokens: u.inputTokens, outputTokens: u.outputTokens, ...(u.costUSD !== undefined ? { costUSD: u.costUSD } : { estimated: true }), model: this.o.agent.name });
        break;
      case "notice":
        if (u.text) emit({ type: "notice", text: u.text });
        break;
      case "modeChanged":
        emit({ type: "notice", text: `Mode: ${u.modeId}` });
        break;
      default:
        break;
    }
  }

  private finishTool(id: string, status: string, output: string | undefined, emit: (e: ChatEvent) => void, tools: Map<string, { title: string; input: JSONValue; diffs: AcpDiff[]; output: string | undefined }>): void {
    const t = tools.get(id);
    if (!t) return;
    const parts = [output ?? t.output ?? "", ...t.diffs.map(diffText)].filter((x) => x !== "");
    t.output = parts.join("\n\n");
    emit({ type: "toolResult", id, output: t.output, isError: status === "failed" });
  }

  private async permission(req: AcpPermissionRequest, signal: AbortSignal, emit: (e: ChatEvent) => void): Promise<string | undefined> {
    const p = typeof this.o.permissions === "function" ? this.o.permissions() : this.o.permissions;
    const d = autoDecide(req, p ?? new Permissions());
    if (d.effect !== "ask") {
      if (d.effect === "deny") emit({ type: "notice", text: `Denied “${req.title}”: ${d.reason}` });
      return d.optionId;
    }
    emit({ type: "permissionRequest", id: req.toolCallId, name: req.title });
    return this.o.inbox.ask(this.o.agent.name, req, signal);
  }
}

function withDiffs(input: JSONValue, diffs: readonly AcpDiff[]): JSONValue {
  if (diffs.length === 0) return input;
  const base = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const prev = Array.isArray(base.diffs) ? base.diffs : [];
  return { ...base, ...(base.path === undefined ? { path: diffs[0]!.path } : {}), diffs: [...prev, ...diffs.map((d) => ({ path: d.path, oldText: d.oldText, newText: d.newText }))] };
}
