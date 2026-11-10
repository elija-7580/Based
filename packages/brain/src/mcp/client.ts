// BSD-222: Based als MCP-Client (Port von Swift `MCPClient`, aber über das offizielle SDK statt eigenem JSON-RPC).
// Eine Verbindung zu einem MCP-Server: verbinden, Werkzeuge auflisten (alle Seiten), Werkzeug aufrufen, trennen.
// Der Transport ist austauschbar: Streamable HTTP (Browser, Server) hier; stdio liefert die Hülle (Tauri/Server),
// Tests nehmen ein In-Memory-Paar. Geheimnisse (Token) kommen nur in den Transport, nie in Meldungen oder Logs.
import type { JSONValue } from "@based/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolResult } from "../engine.js";

export const CLIENT_INFO = { name: "Based", version: "0.3.0" } as const;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: JSONValue;
  /** Laut Server nur lesend (`annotations.readOnlyHint`); sonst gilt das Werkzeug als schreibend. */
  readOnly: boolean;
}

export type McpStatus = "idle" | "connecting" | "ready" | "failed" | "closed";

export interface HttpTransportOptions {
  /** Geheimnis für den Server (z. B. GitHub-Token); ohne: kein Auth-Header. */
  token?: string | undefined;
  /** Header für das Token (Standard `Authorization` mit `Bearer `). */
  headerName?: string | undefined;
  fetch?: typeof fetch | undefined;
}

/** Streamable-HTTP-Transport (MCP 2025-03-26 und neuer). */
export function httpTransport(url: string, opts: HttpTransportOptions = {}): Transport {
  const headers: Record<string, string> = {};
  if (opts.token) {
    const name = opts.headerName?.trim() || "Authorization";
    headers[name] = name.toLowerCase() === "authorization" ? `Bearer ${opts.token}` : opts.token;
  }
  return new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

export interface McpClientOptions {
  /** Zeitgrenze je Anfrage in ms (Standard 60 s). */
  timeoutMs?: number;
}

/** Text einer `tools/call`-Antwort (wie Swift: Text, Bild als Platzhalter, Ressource als Text oder URI). */
export function toolResultText(result: { content?: unknown; structuredContent?: unknown; toolResult?: unknown }): string {
  const content = Array.isArray(result.content) ? (result.content as Record<string, unknown>[]) : [];
  const parts = content.map((c) => {
    switch (c.type) {
      case "text": return typeof c.text === "string" ? c.text : "";
      case "image": return `[image ${typeof c.mimeType === "string" ? c.mimeType : ""}]`.replace(" ]", "]");
      case "audio": return `[audio ${typeof c.mimeType === "string" ? c.mimeType : ""}]`.replace(" ]", "]");
      case "resource": {
        const r = (c.resource ?? {}) as Record<string, unknown>;
        return typeof r.text === "string" ? r.text : typeof r.uri === "string" ? r.uri : "";
      }
      case "resource_link": return typeof c.uri === "string" ? `${typeof c.name === "string" ? c.name + ": " : ""}${c.uri}` : "";
      default: return JSON.stringify(c);
    }
  }).filter((s) => s !== "");
  if (parts.length > 0) return parts.join("\n");
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  if (result.toolResult !== undefined) return JSON.stringify(result.toolResult);
  return "";
}

/** Fehlermeldung ohne Geheimnisse (das Token steht nie in der URL; Header gibt das SDK nicht aus). */
function message(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 300 ? m.slice(0, 300) + "…" : m;
}

export class McpConnection {
  status: McpStatus = "idle";
  lastError: string | undefined;
  tools: McpTool[] = [];
  serverName: string | undefined;
  private client: Client | undefined;
  private connecting: Promise<void> | undefined;

  constructor(readonly name: string, private readonly transport: () => Transport, private readonly opts: McpClientOptions = {}) {}

  /** Verbinden und Werkzeuge laden (mehrfach aufrufbar; läuft nur einmal gleichzeitig). */
  connect(): Promise<void> {
    if (this.status === "ready") return Promise.resolve();
    this.connecting ??= this.doConnect().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async doConnect() {
    this.status = "connecting";
    this.lastError = undefined;
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    try {
      await client.connect(this.transport(), { timeout: this.opts.timeoutMs ?? 60_000 });
      this.client = client;
      this.serverName = client.getServerVersion()?.name;
      await this.refreshTools();
      this.status = "ready";
    } catch (e) {
      this.status = "failed";
      this.lastError = message(e);
      this.client = undefined;
      await client.close().catch(() => {});
      throw new Error(`${this.name}: ${this.lastError}`);
    }
  }

  /** Alle Werkzeuge (über alle Seiten der Liste). */
  async refreshTools(): Promise<McpTool[]> {
    const client = this.client;
    if (!client) throw new Error(`${this.name}: not connected`);
    const out: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const r = await client.listTools(cursor ? { cursor } : {}, { timeout: this.opts.timeoutMs ?? 60_000 });
      for (const t of r.tools) {
        out.push({
          name: t.name,
          description: t.description ?? t.title ?? "",
          inputSchema: (t.inputSchema ?? { type: "object" }) as JSONValue,
          readOnly: t.annotations?.readOnlyHint === true,
        });
      }
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    this.tools = out;
    return out;
  }

  /** Werkzeug aufrufen. Fehler (Netz, Server) kommen als `isError`, nur ein Abbruch wirft. */
  async call(tool: string, args: JSONValue, signal?: AbortSignal): Promise<ToolResult> {
    try {
      await this.connect();
      const r = await this.client!.callTool(
        { name: tool, arguments: (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown> },
        undefined,
        { timeout: this.opts.timeoutMs ?? 60_000, ...(signal ? { signal } : {}) },
      );
      return { text: toolResultText(r), isError: r.isError === true };
    } catch (e) {
      if (signal?.aborted) throw e;
      return { text: `${this.name}: ${message(e)}`, isError: true };
    }
  }

  async close() {
    const c = this.client;
    this.client = undefined;
    this.status = "closed";
    await c?.close().catch(() => {});
  }
}
