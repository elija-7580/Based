// BSD-223: ACP-Client (Port von Swift `ACPClient`): Handshake, Sitzung anlegen/laden, Modus setzen, Prompt senden,
// abbrechen. Updates des Agenten (`session/update`) kommen als `AcpUpdate`; Freigaben (`session/request_permission`)
// gehen an `onPermission`; Dateizugriffe (`fs/*`) nur innerhalb von `allowedRoots` und über ein austauschbares
// Dateisystem (Node, Tauri, Test). Schreiben prüft zusätzlich die Regeln (deny/Plan-Modus blockiert).
import type { JSONValue } from "@based/core";
import type { Permissions } from "../agents/permissions.js";
import { mcpServerJSON, normalizePath, pathWithin, type AcpMcpServer } from "./agents.js";
import { toolCallArgument, type AcpPermissionOption, type AcpPermissionRequest } from "./inbox.js";
import { JsonRpcPeer, RpcError } from "./jsonrpc.js";

export const ACP_PROTOCOL_VERSION = 1;

export interface AcpDiff { path: string; oldText: string; newText: string }

export type AcpUpdate =
  | { type: "agentText"; text: string }
  | { type: "agentThought"; text: string }
  | { type: "userText"; text: string }
  | { type: "toolCall"; id: string; title: string; kind: string; status: string; input: JSONValue; diffs: AcpDiff[] }
  | { type: "toolCallUpdate"; id: string; status: string | undefined; title: string | undefined; output: string | undefined; diffs: AcpDiff[] }
  | { type: "plan"; entries: { content: string; status: string; priority: string }[] }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUSD: number | undefined }
  | { type: "notice"; text: string }
  | { type: "modeChanged"; modeId: string }
  | { type: "commands"; commands: { name: string; description: string }[] }
  | { type: "other"; kind: string };

export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | "unknown";

/** Dateizugriff der Hülle; Pfade kommen schon geprüft an. `realpath` löst Symlinks (fehlt sie: Pfad wie er ist). */
export interface AcpFileSystem {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  realpath?(path: string): Promise<string>;
}

/** Ein Inhaltsblock des Prompts (ACP `ContentBlock`). */
export type AcpPromptBlock = { type: "text"; text: string } | { type: "resource"; uri: string; text: string; mimeType?: string };

type Obj = { [k: string]: JSONValue };
const obj = (v: JSONValue | undefined): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined);
const arr = (v: JSONValue | undefined): JSONValue[] => (Array.isArray(v) ? v : []);
const s = (v: JSONValue | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const n = (v: JSONValue | undefined): number | undefined => (typeof v === "number" ? v : undefined);

/** `content` eines Tool-Calls: Diffs heraus. */
function diffsOf(content: JSONValue | undefined): AcpDiff[] {
  return arr(content).flatMap((c) => {
    const o = obj(c);
    return o && o.type === "diff" ? [{ path: s(o.path) ?? "file", oldText: s(o.oldText) ?? "", newText: s(o.newText) ?? "" }] : [];
  });
}

/** Text eines Tool-Call-Inhalts (`{type:"content", content:{type:"text"}}` oder Terminal-Ausgabe). */
function textOf(content: JSONValue | undefined): string | undefined {
  const parts = arr(content).flatMap((c) => {
    const o = obj(c);
    const inner = obj(o?.content);
    const t = s(inner?.text) ?? s(o?.text);
    return t !== undefined ? [t] : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** `session/update` → `AcpUpdate` (reine Funktion; unbekannte Arten als `other`). */
export function parseSessionUpdate(params: JSONValue | undefined): AcpUpdate | undefined {
  const u = obj(obj(params)?.update);
  if (!u) return undefined;
  const kind = s(u.sessionUpdate) ?? "";
  const text = s(obj(u.content)?.text) ?? "";
  switch (kind) {
    case "agent_message_chunk": return { type: "agentText", text };
    case "agent_thought_chunk": return { type: "agentThought", text };
    case "user_message_chunk": return { type: "userText", text };
    case "tool_call": {
      const input: Obj = { kind: s(u.kind) ?? "other" };
      const arg = toolCallArgument(u);
      if (arg !== undefined) input.path = arg;
      if (u.rawInput !== undefined) input.rawInput = u.rawInput;
      return { type: "toolCall", id: s(u.toolCallId) ?? "", title: s(u.title) ?? "tool", kind: s(u.kind) ?? "other", status: s(u.status) ?? "pending", input, diffs: diffsOf(u.content) };
    }
    case "tool_call_update":
      return { type: "toolCallUpdate", id: s(u.toolCallId) ?? "", status: s(u.status), title: s(u.title), output: textOf(u.content), diffs: diffsOf(u.content) };
    case "plan":
      return {
        type: "plan",
        entries: arr(u.entries).flatMap((e) => {
          const o = obj(e);
          const c = s(o?.content);
          return c === undefined ? [] : [{ content: c, status: s(o?.status) ?? "pending", priority: s(o?.priority) ?? "medium" }];
        }),
      };
    case "usage_update":
      return { type: "usage", inputTokens: n(u.inputTokens) ?? n(u.used) ?? 0, outputTokens: n(u.outputTokens) ?? 0, costUSD: n(obj(u.cost)?.amount) };
    case "notice": return { type: "notice", text: text || (s(u.message) ?? "") };
    case "current_mode_update": return { type: "modeChanged", modeId: s(u.currentModeId) ?? "" };
    case "available_commands_update":
      return {
        type: "commands",
        commands: arr(u.availableCommands).flatMap((c) => {
          const o = obj(c);
          const name = s(o?.name);
          return name ? [{ name, description: s(o?.description) ?? "" }] : [];
        }),
      };
    default: return { type: "other", kind };
  }
}

export interface AcpClientOptions {
  /** Nur in diesen Ordnern darf der Agent über `fs/*` lesen und schreiben. Leer = nichts. */
  allowedRoots?: readonly string[];
  fs?: AcpFileSystem | undefined;
  /** Regeln für `fs/write_text_file` (deny bzw. Plan-Modus blockiert das Schreiben); Funktion = jeweils aktueller Stand. */
  permissions?: Permissions | (() => Permissions) | undefined;
  clientVersion?: string;
}

export class AcpClient {
  sessionId: string | undefined;
  agentInfo: JSONValue = null;
  agentCapabilities: JSONValue = null;
  availableModes: { id: string; name: string }[] = [];
  currentMode: string | undefined;
  onUpdate: ((u: AcpUpdate, sessionId: string) => void) | undefined;
  /** Freigabe entscheiden: gewählte `optionId` oder `undefined` (abgebrochen). Fehlt sie: abgebrochen. */
  onPermission: ((req: AcpPermissionRequest) => Promise<string | undefined>) | undefined;

  constructor(readonly peer: JsonRpcPeer, private readonly o: AcpClientOptions = {}) {
    peer.onNotification = (method, params) => {
      if (method !== "session/update") return;
      const u = parseSessionUpdate(params);
      if (!u) return;
      if (u.type === "modeChanged") this.currentMode = u.modeId;
      this.onUpdate?.(u, s(obj(params)?.sessionId) ?? this.sessionId ?? "");
    };
    peer.onRequest = (method, params) => this.handleRequest(method, params);
  }

  get loadSessionSupported(): boolean {
    return obj(this.agentCapabilities)?.loadSession === true;
  }

  async initialize(): Promise<void> {
    const r = obj(await this.peer.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: this.o.fs !== undefined, writeTextFile: this.o.fs !== undefined }, terminal: false },
      clientInfo: { name: "Based", version: this.o.clientVersion ?? "0.3.0" },
    })) ?? {};
    this.agentInfo = r.agentInfo ?? null;
    this.agentCapabilities = r.agentCapabilities ?? null;
    const auth = arr(r.authMethods);
    // Die meisten Adapter melden sich über den Login ihrer CLI an; erste Methode versuchen, Fehler ignorieren.
    const first = s(obj(auth[0])?.id);
    if (first && !this.loadSessionSupported) await this.peer.request("authenticate", { methodId: first }).catch(() => undefined);
  }

  async newSession(cwd: string, mcpServers: readonly AcpMcpServer[] = []): Promise<string> {
    const r = obj(await this.peer.request("session/new", { cwd, mcpServers: mcpServers.map(mcpServerJSON) })) ?? {};
    const id = s(r.sessionId);
    if (!id) throw RpcError.internal("session/new returned no sessionId");
    this.sessionId = id;
    this.readModes(r.modes);
    return id;
  }

  async loadSession(id: string, cwd: string, mcpServers: readonly AcpMcpServer[] = []): Promise<void> {
    const r = obj(await this.peer.request("session/load", { sessionId: id, cwd, mcpServers: mcpServers.map(mcpServerJSON) }));
    this.sessionId = id;
    this.readModes(r?.modes);
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.sessionId) return;
    await this.peer.request("session/set_mode", { sessionId: this.sessionId, modeId });
    this.currentMode = modeId;
  }

  /** Ein Turn; Updates kommen über `onUpdate`. Kehrt zurück, wenn der Turn endet. */
  async prompt(blocks: readonly AcpPromptBlock[]): Promise<AcpStopReason> {
    if (!this.sessionId) throw RpcError.internal("No session");
    const prompt = blocks.map((b): JSONValue =>
      b.type === "text" ? { type: "text", text: b.text } : { type: "resource", resource: { uri: b.uri, mimeType: b.mimeType ?? "text/markdown", text: b.text } });
    const r = obj(await this.peer.request("session/prompt", { sessionId: this.sessionId, prompt }));
    const reason = s(r?.stopReason);
    return reason === "end_turn" || reason === "max_tokens" || reason === "max_turn_requests" || reason === "refusal" || reason === "cancelled" ? reason : "unknown";
  }

  cancel(): void {
    if (this.sessionId) this.peer.notify("session/cancel", { sessionId: this.sessionId });
  }

  private readModes(modes: JSONValue | undefined): void {
    const m = obj(modes);
    if (!m) return;
    this.availableModes = arr(m.availableModes).flatMap((x) => {
      const o = obj(x);
      const id = s(o?.id);
      return id ? [{ id, name: s(o?.name) ?? id }] : [];
    });
    this.currentMode = s(m.currentModeId) ?? this.currentMode;
  }

  /** Pfad prüfen: absolut, normalisiert, Symlinks aufgelöst, innerhalb eines erlaubten Ordners. */
  private async checkedPath(raw: JSONValue | undefined): Promise<string | undefined> {
    const p = s(raw);
    if (!p || !p.startsWith("/")) return undefined;
    let path = normalizePath(p);
    if (this.o.fs?.realpath) path = await this.o.fs.realpath(path).catch(() => path);
    return (this.o.allowedRoots ?? []).some((r) => pathWithin(r, path)) ? path : undefined;
  }

  private async handleRequest(method: string, params: JSONValue | undefined): Promise<JSONValue> {
    const p = obj(params) ?? {};
    switch (method) {
      case "session/request_permission": {
        const tc = obj(p.toolCall) ?? {};
        const options: AcpPermissionOption[] = arr(p.options).flatMap((x) => {
          const o = obj(x);
          const id = s(o?.optionId);
          return id ? [{ optionId: id, name: s(o?.name) ?? id, kind: s(o?.kind) ?? "allow_once" }] : [];
        });
        const raw = tc.rawInput ?? tc.content;
        const detail = raw === undefined ? "" : typeof raw === "string" ? raw : JSON.stringify(raw);
        const req: AcpPermissionRequest = {
          sessionId: s(p.sessionId) ?? this.sessionId ?? "",
          toolCallId: s(tc.toolCallId) ?? "",
          title: s(tc.title) ?? "Tool",
          kind: s(tc.kind) ?? "other",
          argument: toolCallArgument(tc),
          detail: detail.slice(0, 2000),
          options,
        };
        const chosen = this.onPermission ? await this.onPermission(req) : undefined;
        return chosen !== undefined ? { outcome: { outcome: "selected", optionId: chosen } } : { outcome: { outcome: "cancelled" } };
      }
      case "fs/read_text_file": {
        const path = await this.checkedPath(p.path);
        if (!path || !this.o.fs) throw new RpcError(-32001, "Read not permitted");
        let text = await this.o.fs.read(path);
        const line = n(p.line), limit = n(p.limit);
        if (line !== undefined || limit !== undefined) {
          const lines = text.split("\n");
          const start = Math.max(0, (line ?? 1) - 1);
          text = lines.slice(start, limit !== undefined ? start + limit : undefined).join("\n");
        }
        return { content: text };
      }
      case "fs/write_text_file": {
        const path = await this.checkedPath(p.path);
        const content = s(p.content);
        if (!path || !this.o.fs || content === undefined) throw new RpcError(-32001, "Write not permitted");
        const perms = typeof this.o.permissions === "function" ? this.o.permissions() : this.o.permissions;
        if (perms) {
          const v = perms.decide({ tool: "Edit", argument: path }, true);
          // „ask“ gilt hier als erlaubt: der Agent hat die Änderung selbst per request_permission erfragt.
          if (v.effect === "deny") throw new RpcError(-32001, `Write not permitted by the permission rules (${v.reason})`);
        }
        await this.o.fs.write(path, content);
        return null;
      }
      default:
        throw RpcError.methodNotFound(method);
    }
  }
}
