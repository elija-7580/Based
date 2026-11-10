// BSD-222: Werkzeuge aller verbundenen MCP-Server als ein ToolHost für Chat und Agenten (mit `combineToolHosts`
// neben den Workspace-Werkzeugen). Namen wie in Claude Code: `mcp__<connection>__<tool>` – eindeutig, nur
// [A-Za-z0-9_-], höchstens 64 Zeichen (Grenze der Modell-APIs). Freigaben laufen über die normale Policy
// (`executeTool`): ein Werkzeug ohne `readOnlyHint` gilt als schreibend, „Ask before edits“ fragt also nach.
import type { JSONValue } from "@based/core";
import type { ToolHost, ToolResult } from "../engine.js";
import type { ToolSpec } from "../messages.js";
import type { McpConnection, McpTool } from "./client.js";

export const MCP_TOOL_PREFIX = "mcp__";
const MAX_NAME = 64;

/** Kurzname einer Connection für Werkzeugnamen („GitHub (work)“ → „github_work“). */
export function connectionSlug(name: string): string {
  const s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (s || "server").slice(0, 20);
}

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

interface Entry {
  connection: McpConnection;
  tool: McpTool;
  spec: ToolSpec;
}

export class McpToolHost implements ToolHost {
  private entries = new Map<string, Entry>();

  /** `connections`: verbundene Server (Werkzeuge schon geladen); Reihenfolge = Vorrang bei Namensgleichheit. */
  constructor(connections: readonly McpConnection[]) {
    const slugs = new Set<string>();
    for (const c of connections) {
      let slug = connectionSlug(c.name);
      for (let i = 2; slugs.has(slug); i++) slug = `${connectionSlug(c.name).slice(0, 17)}_${i}`;
      slugs.add(slug);
      for (const t of c.tools) {
        let name = `${MCP_TOOL_PREFIX}${slug}__${sanitize(t.name)}`;
        if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME);
        for (let i = 2; this.entries.has(name); i++) name = `${name.slice(0, MAX_NAME - String(i).length - 1)}_${i}`;
        const description = `[${c.name}] ${t.description}`.trim();
        this.entries.set(name, { connection: c, tool: t, spec: { name, description, inputSchema: t.inputSchema } });
      }
    }
  }

  get specs(): readonly ToolSpec[] {
    return [...this.entries.values()].map((e) => e.spec);
  }

  isWrite(name: string): boolean {
    return !(this.entries.get(name)?.tool.readOnly ?? false);
  }

  /** Connection und Originalname hinter einem Werkzeugnamen (Anzeige im Chat). */
  origin(name: string): { connection: string; tool: string } | undefined {
    const e = this.entries.get(name);
    return e ? { connection: e.connection.name, tool: e.tool.name } : undefined;
  }

  call(name: string, input: JSONValue, signal?: AbortSignal): Promise<ToolResult> {
    const e = this.entries.get(name);
    if (!e) return Promise.resolve({ text: `Unknown tool ${name}`, isError: true });
    return e.connection.call(e.tool.name, input, signal);
  }
}
