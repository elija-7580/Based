// MCP über das offizielle TS-SDK (docs/mcp.md). Erster Schnitt: Seiten lesen/suchen/auflisten/anlegen/bearbeiten,
// Papierkorb, Anleitung; Ressourcen based://docs/<topic> und based://page/<id>. Transporte: stdio (main.ts --stdio)
// und Streamable HTTP unter POST /mcp (zustandslos, JSON-Antworten, Bearer-Token über den Router).
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PAGE_URI, ToolError, type Pages } from "./pages.js";

export const SERVER_NAME = "based";
export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS = `Based is a Notion-like workspace (pages, blocks, databases). Pages are read and written as Markdown.
- Find pages with \`search\` or \`list_pages\`, read them with \`read_page\` (ids are UUIDs; links look like based://page/<id>).
- Create with \`create_page\`, add content with \`append_markdown\`; use \`replace_page_content\` only when the user wants a rewrite.
- Deleting moves pages to the Trash (\`trash_page\`, restorable with \`restore_page\`).
- Call \`based_guide\` for details (topics: overview, markdown, safety).`;

export const GUIDE: Record<string, string> = {
  overview: `# Based overview
A workspace holds pages. A page contains blocks (paragraphs, headings, lists, to-dos, toggles, quotes, callouts, code,
images, tables) and sub-pages. Databases hold rows; each row is a page with properties. Everything syncs between
devices through the Based server (last writer wins per record).`,
  markdown: `# Markdown in Based
Supported: # / ## / ### headings, paragraphs, - bullets, 1. numbered lists, - [ ] / - [x] to-dos, > quotes,
> [!NOTE] callouts, \`\`\`code\`\`\` blocks, tables, ---, images ![alt](url), **bold**, *italic*, ~~strike~~, \`code\`,
[links](https://…). Link to another page with [Title](based://page/<id>): it becomes a mention. Indent by 4 spaces to nest.`,
  safety: `# Safety
Prefer appending over replacing. Never empty pages or move many pages without the user asking. trash_page is reversible;
nothing here deletes forever.`,
};

const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }] });
const fail = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }], isError: true });

/** Fehler eines Werkzeugs als Antwort statt als Protokollfehler (der Client zeigt sie dem Modell). */
function guarded<A>(body: (args: A) => CallToolResult): (args: A) => CallToolResult {
  return (args) => {
    try {
      return body(args);
    } catch (e) {
      if (e instanceof ToolError) return fail(e.message);
      throw e;
    }
  };
}

/** Liste mit `limit`/`offset`, Rest als „… N more (offset: K)“. */
function paged(lines: string[], limit: number, offset: number): string {
  const slice = lines.slice(offset, offset + limit);
  const rest = lines.length - offset - slice.length;
  const out = slice.length > 0 ? slice.join("\n") : "(none)";
  return rest > 0 ? `${out}\n… ${rest} more (offset: ${offset + slice.length})` : out;
}

const limit = z.number().int().min(1).max(500).optional().describe("Max items (default 50)");
const offset = z.number().int().min(0).optional().describe("Skip this many items");

/** Ein MCP-Server über den Seiten des Workspaces. Pro HTTP-Anfrage neu (zustandslos), für stdio einmal. */
export function createMcpServer(pages: Pages): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const line = (id: string) => `- ${pages.title(id)} (id: ${id})`;

  server.registerTool(
    "based_guide",
    { description: "How Based works, by topic (overview, markdown, safety)", inputSchema: { topic: z.string().optional() }, annotations: { readOnlyHint: true } },
    guarded(({ topic }: { topic?: string | undefined }) => {
      const t = topic ?? "overview";
      const g = GUIDE[t];
      return g ? text(g) : fail(`Unknown topic ${t}. Topics: ${Object.keys(GUIDE).join(", ")}`);
    }),
  );

  server.registerTool(
    "search",
    {
      description: "Search titles and full text of pages and database rows. Returns ids and snippets.",
      inputSchema: { query: z.string().min(1), limit },
      annotations: { readOnlyHint: true },
    },
    guarded(({ query, limit: n }: { query: string; limit?: number | undefined }) => {
      const hits = pages.searchPages(query, n ?? 20);
      if (hits.length === 0) return text("No matches.");
      return text(hits.map((h) => `- ${h.title} (id: ${h.id})${h.snippet ? ` — ${h.snippet}` : ""}`).join("\n"));
    }),
  );

  server.registerTool(
    "read_page",
    { description: "A page as Markdown, with its properties when it is a database row", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
    guarded(({ id }: { id: string }) => text(pages.read(id))),
  );

  server.registerTool(
    "list_pages",
    {
      description: "Top-level pages, or the sub-pages of `parent`",
      inputSchema: { parent: z.string().optional(), limit, offset },
      annotations: { readOnlyHint: true },
    },
    guarded(({ parent, limit: n, offset: o }: { parent?: string | undefined; limit?: number | undefined; offset?: number | undefined }) =>
      text(paged(pages.list(parent).map(line), n ?? 50, o ?? 0)),
    ),
  );

  server.registerTool(
    "create_page",
    {
      description: "Create a page from Markdown under `parent` (or at the top level). A leading `# Title` line becomes the title when `title` is missing.",
      inputSchema: { title: z.string().optional(), markdown: z.string().optional(), parent: z.string().optional() },
    },
    guarded((a: { title?: string | undefined; markdown?: string | undefined; parent?: string | undefined }) => {
      const id = pages.create(a);
      return text(`Created ${pages.title(id)} (id: ${id}, ${PAGE_URI}${id})`);
    }),
  );

  server.registerTool(
    "append_markdown",
    { description: "Append Markdown blocks to the end of a page", inputSchema: { id: z.string(), markdown: z.string() } },
    guarded(({ id, markdown }: { id: string; markdown: string }) => text(`Appended ${pages.append(id, markdown)} blocks to ${pages.title(id)}.`)),
  );

  server.registerTool(
    "replace_page_content",
    {
      description: "Replace the whole body of a page with Markdown (sub-pages stay). Only when the user wants a rewrite.",
      inputSchema: { id: z.string(), markdown: z.string() },
      annotations: { destructiveHint: true },
    },
    guarded(({ id, markdown }: { id: string; markdown: string }) => {
      const r = pages.replaceContent(id, markdown);
      return text(`Replaced the content of ${pages.title(id)}: ${r.removed} blocks removed, ${r.added} added.`);
    }),
  );

  server.registerTool(
    "update_page",
    {
      description: "Change a page's title, emoji icon (empty string removes it) or remove its cover",
      inputSchema: { id: z.string(), title: z.string().optional(), icon: z.string().optional(), remove_cover: z.boolean().optional() },
    },
    guarded(({ id, title, icon, remove_cover }: { id: string; title?: string | undefined; icon?: string | undefined; remove_cover?: boolean | undefined }) => {
      pages.update(id, { title, icon, removeCover: remove_cover });
      return text(`Updated ${pages.title(id)}.`);
    }),
  );

  server.registerTool(
    "trash_page",
    { description: "Move a page (with everything in it) to the Trash. Restorable.", inputSchema: { id: z.string() }, annotations: { destructiveHint: true } },
    guarded(({ id }: { id: string }) => text(pages.trash(id) ? `Moved ${pages.title(id)} to the Trash.` : `${pages.title(id)} is already in the Trash.`)),
  );

  server.registerTool(
    "restore_page",
    { description: "Bring a page back from the Trash", inputSchema: { id: z.string() } },
    guarded(({ id }: { id: string }) => text(pages.restore(id) ? `Restored ${pages.title(id)}.` : `${pages.title(id)} is not in the Trash.`)),
  );

  server.registerTool(
    "list_trash",
    { description: "Pages in the Trash, most recently deleted first", inputSchema: { limit, offset }, annotations: { readOnlyHint: true } },
    guarded(({ limit: n, offset: o }: { limit?: number | undefined; offset?: number | undefined }) => text(paged(pages.trashList().map(line), n ?? 50, o ?? 0))),
  );

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
      try {
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: pages.read(id) }] };
      } catch (e) {
        if (e instanceof ToolError) throw new Error(e.message);
        throw e;
      }
    },
  );

  return server;
}
