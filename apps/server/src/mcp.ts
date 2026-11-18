// MCP über das offizielle TS-SDK (docs/mcp.md). Transporte: stdio (main.ts --stdio) und Streamable HTTP unter
// POST /mcp (zustandslos, JSON-Antworten, Bearer-Token über den Router).
//
// Agent-Parität (docs/agent-parity.md, Regel 1): Hier ist KEIN Werkzeug gebaut. Alle Werkzeuge leben in
// `WorkspaceTools` (@based/brain); dieser Server meldet sie mit Name, Beschreibung und Schema an und reicht Aufrufe
// durch – dazu die Berechtigungsregeln, der Autor des Clients, Prompts (Skills) und Ressourcen.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PAGE_URI, type Pages } from "./pages.js";
import type { AssetStore } from "./assets.js";
import { AgentBrain, AGENT_TYPE, defaultMainAgent, getRecord, GUIDE, MAIN_AGENT_ID, mainArgument, pagePathCandidates, Permissions, targetPage, type AgentData, unwrap } from "@based/brain";
import type { Author, JSONValue, WorkspaceStore } from "@based/core";

export { GUIDE } from "@based/brain";

export const SERVER_NAME = "based";
export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS = `Based is a Notion-like workspace (pages, blocks, databases). Pages are read and written as Markdown.
- Start with \`recall\` when you need context: one call returns what Based remembers about the user, matching pages with a passage, and how they are connected. \`about_me\` gives the user's profile; \`related\` lists a page's neighbours.
- Skills are the user's reusable instructions: \`list_skills\`, then \`load_skill\` before following one (they are also offered as prompts).
- When the user tells you something durable about themselves, their projects or people, save it with \`remember\` (one fact per call, link the pages it is about).
- Find pages with \`search\` or \`list_pages\`, read them with \`read_page\` (ids are UUIDs; links look like based://page/<id>).
- Create with \`create_page\`, add content with \`append_markdown\`; use \`replace_page_content\` only when the user wants a rewrite.
- To change single blocks (insert at a place, move, columns, colours, turn into, images, tables): \`read_blocks\` gives every block a short handle, \`edit_blocks\` takes a short script.
- Every writing call is one step; \`undo_last\` takes your last one back.
- Page look and place: \`update_page\` (icon, cover, font, width, lock), \`move_page\` (under a page, into a section, before/after another page); \`get_workspace\` shows the sections.
- Deleting moves pages to the Trash (\`trash_page\`, restorable with \`restore_page\`).
- Agent runs: \`list_runs\`, \`get_run\`; \`inbox\` shows what needs the user (\`resolve_inbox\` answers an approval, only if the user allowed it); \`ask_main_agent\` hands Based's main agent a task; projects: \`list_projects\`, \`get_project\`, \`create_project\`, \`update_project_status\`.
- Databases: \`list_databases\`, \`database_schema\`, \`query_database\`; write rows with \`add_row\` / \`update_row\` (properties by name, plain text values).
- Schema and views: \`create_database\`, \`update_database\`, \`list_views\`, \`create_view\`, \`update_view\`, \`delete_view\`.
- Writing tools follow the user's permission rules in Based; a refused call says why – don't retry it, tell the user.
- Call \`based_guide\` for details (topics: overview, markdown, brain, safety).`;

const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }] });
const fail = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }], isError: true });

/**
 * BSD-221 Teil 3e (BSD-98): Berechtigungsregeln des Hauptagenten (Settings → Agents & AI) gelten auch für Schreib-
 * zugriffe über MCP – wie im Chat (`ruleVerdict` mit Werkzeug „based.<name>“, Hauptargument und Seitenpfaden).
 * `deny` lehnt ab; `ask` auch, denn ein MCP-Client kann in Based nicht nachfragen. Ohne Regeln: nichts ändert sich.
 * Gibt die Ablehnung als Text zurück oder `undefined`.
 */
export function mcpRuleRefusal(store: WorkspaceStore, tool: string, args: unknown): string | undefined {
  const main = getRecord<AgentData>(store, AGENT_TYPE, MAIN_AGENT_ID)?.data ?? defaultMainAgent();
  const rules = main.permissions?.rules ?? "";
  if (!rules.trim()) return undefined;
  const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const target = targetPage(input);
  const v = Permissions.from(rules, main.permissions.mode).ruleVerdict({ tool: "based." + tool, argument: mainArgument(input), ...(target ? { paths: pagePathCandidates(store, target) } : {}) });
  if (v?.effect === "deny") return `Not allowed by the permission rules in Based (${v.reason}).`;
  if (v?.effect === "ask") return `This needs the user's approval in Based (${v.reason}). MCP clients can't ask for it – do it from Based, or change the rule in Settings → Agents & AI.`;
  return undefined;
}

/** BSD-522: Autor für Schreibzugriffe über MCP – der Name, den der Client beim Verbinden nennt. */
export function mcpActor(server: McpServer): Author {
  const name = server.server.getClientVersion()?.name?.trim();
  return { kind: "agent", name: name ? name.slice(0, 80) : "MCP client" };
}

/** `?tools=all` (HTTP) bzw. BASED_MCP_TOOLS=all (stdio); alles andere: die kurze Liste. */
export const mcpToolList = (v: string | null | undefined): "compact" | "all" => (v?.trim().toLowerCase() === "all" ? "all" : "compact");

export interface McpServerOptions {
  /** Dateispeicher: Agenten wählen Dateien aus (Maße, PDF-Seiten aus den Bytes) und laden welche hoch. */
  assets?: AssetStore | undefined;
  /** stdio: der Client läuft auf diesem Rechner – upload_file darf lokale Pfade lesen. */
  localFiles?: boolean;
  /**
   * Welche Werkzeuge die Liste zeigt: "compact" (Standard) = Kernwerkzeuge plus more_tools/run_tool, das spart rund
   * drei Viertel der Token je Gespräch; "all" = jedes Werkzeug (für Clients, die selbst nachladen, z. B. Claude Code).
   * Aufrufbar ist immer alles.
   */
  toolList?: "compact" | "all" | undefined;
}

/** Ein MCP-Server über den Seiten des Workspaces. Pro HTTP-Anfrage neu (zustandslos), für stdio einmal. */
export function createMcpServer(pages: Pages, opts: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const tools = pages.tools({ assets: opts.assets, localFiles: opts.localFiles });

  // MARK: Werkzeuge – aus der einen Schicht, mit ihrem JSON-Schema (keine zweite Beschreibung hier).
  server.server.registerCapabilities({ tools: {} });
  const listed = () => (opts.toolList === "all" ? tools.all : tools.compact);
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: listed().map((d) => ({
      name: d.spec.name,
      description: d.spec.description,
      inputSchema: d.spec.inputSchema as { type: "object"; [k: string]: unknown },
      annotations: d.write ? { readOnlyHint: false, destructiveHint: d.destructive === true } : { readOnlyHint: true },
    })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    // run_tool {name, args} meint das Werkzeug darin: Regeln, Rückfragen und Herkunft gelten für dieses.
    const { name, input: args } = unwrap(req.params.name, (req.params.arguments ?? {}) as JSONValue);
    // Jedes schreibende Werkzeug prüft vorher die Regeln (BSD-221 Teil 3e) – neue Werkzeuge automatisch.
    if (tools.isWrite(name) && tools.def(name)) {
      const refused = mcpRuleRefusal(pages.store, name, args);
      if (refused) return fail(refused);
    }
    // BSD-522: alles, was ein MCP-Client schreibt, gilt als von einem Agenten (Seite „ai“ bzw. „mixed“, Autor je Block).
    const r = await tools.call(name, args, undefined, mcpActor(server));
    return r.isError ? fail(r.text) : text(r.text);
  });

  // MARK: Skills als Prompts (BSD-221 Teil 3e): jeder eingeschaltete Skill aus dem Agent Brain, wie in der Mac-App
  // (docs/mcp.md „Prompts“). Name klein mit Bindestrichen; optionales Argument `input` wird angehängt.
  {
    const used = new Set<string>();
    for (const skill of new AgentBrain(pages.store).skills(true)) {
      const base = skill.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "skill";
      let name = base;
      for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
      used.add(name);
      server.registerPrompt(name, { title: skill.name, description: skill.description || `Skill “${skill.name}” from Based`, argsSchema: { input: z.string().optional().describe("What to apply the skill to") } },
        ({ input }: { input?: string | undefined }) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: skill.body + (input?.trim() ? `\n\n---\n${input.trim()}` : "") } }] }));
    }
  }

  // Ressourcen
  for (const topic of Object.keys(GUIDE)) {
    server.registerResource(`guide-${topic}`, `based://docs/${topic}`, { title: `Based guide: ${topic}`, mimeType: "text/markdown" }, (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE[topic]! }],
    }));
  }
  server.registerResource(
    "page",
    new ResourceTemplate(`${PAGE_URI}{id}`, {
      list: () => ({
        resources: pages.allPages(500).map((id) => ({ uri: PAGE_URI + id, name: pages.title(id), mimeType: "text/markdown" })),
      }),
    }),
    { title: "Based page", mimeType: "text/markdown" },
    (uri, vars) => {
      const id = String(Array.isArray(vars.id) ? vars.id[0] : vars.id);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: pages.read(id) }] };
    },
  );

  return server;
}
