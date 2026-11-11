// MCP über das offizielle TS-SDK (docs/mcp.md). Erster Schnitt: Seiten lesen/suchen/auflisten/anlegen/bearbeiten,
// Papierkorb, Anleitung; Ressourcen based://docs/<topic> und based://page/<id>. Transporte: stdio (main.ts --stdio)
// und Streamable HTTP unter POST /mcp (zustandslos, JSON-Antworten, Bearer-Token über den Router).
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PRIVATE, backlinksTo, duplicatePages, isPageLike, movePages, replaceInRichText, setFavorite } from "@based/core";
import { PAGE_URI, ToolError, type Pages } from "./pages.js";
import { Databases } from "./databases.js";
import { getProjectText, getRunText, inboxText, listProjectsText, listRunsText } from "./runs.js";

export const SERVER_NAME = "based";
export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS = `Based is a Notion-like workspace (pages, blocks, databases). Pages are read and written as Markdown.
- Find pages with \`search\` or \`list_pages\`, read them with \`read_page\` (ids are UUIDs; links look like based://page/<id>).
- Create with \`create_page\`, add content with \`append_markdown\`; use \`replace_page_content\` only when the user wants a rewrite.
- Deleting moves pages to the Trash (\`trash_page\`, restorable with \`restore_page\`).
- Agent runs: \`list_runs\`, \`get_run\`; \`inbox\` shows what needs the user; projects: \`list_projects\`, \`get_project\`.
- Databases: \`list_databases\`, \`database_schema\`, \`query_database\`; write rows with \`add_row\` / \`update_row\` (properties by name, plain text values).
- Schema and views: \`create_database\`, \`update_database\`, \`list_views\`, \`create_view\`, \`update_view\`, \`delete_view\`.
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
  const dbs = new Databases(pages.store);
  const values = z.record(z.string(), z.string()).describe("Property name → plain text value (empty string clears; options by name; multi-select comma-separated; dates YYYY-MM-DD)");

  // MARK: Läufe und Inbox (BSD-221 Teil 3a; BSD-160-Records, nur lesen)
  server.registerTool(
    "list_runs",
    {
      description: "Agent runs (chat turns, main agent, sub-agents, schedules), newest first, with status, kind, start time and cost",
      inputSchema: { status: z.string().optional().describe("Queued, Running, Needs you, Done, Failed or Cancelled"), limit },
      annotations: { readOnlyHint: true },
    },
    guarded(({ status, limit: n }: { status?: string | undefined; limit?: number | undefined }) => text(listRunsText(pages.store, { status, limit: n }))),
  );
  server.registerTool(
    "get_run",
    { description: "One run: status, agent, times, usage and cost, instructions, result and sub-runs", inputSchema: { run_id: z.string() }, annotations: { readOnlyHint: true } },
    guarded(({ run_id }: { run_id: string }) => text(getRunText(pages.store, run_id))),
  );
  server.registerTool(
    "inbox",
    { description: "What needs the user: runs waiting for an answer or approval", inputSchema: {}, annotations: { readOnlyHint: true } },
    guarded(() => text(inboxText(pages.store))),
  );
  server.registerTool(
    "list_projects",
    { description: "Projects with status, goal and run count; filter by status (active, paused, done)", inputSchema: { status: z.string().optional(), limit }, annotations: { readOnlyHint: true } },
    guarded(({ status, limit: n }: { status?: string | undefined; limit?: number | undefined }) => text(listProjectsText(pages.store, { status, limit: n }))),
  );
  server.registerTool(
    "get_project",
    { description: "One project: status, goal, budget, project page and recent runs (by id or name)", inputSchema: { project_id: z.string() }, annotations: { readOnlyHint: true } },
    guarded(({ project_id }: { project_id: string }) => text(getProjectText(pages.store, project_id))),
  );

  // MARK: Datenbanken (BSD-221)
  server.registerTool(
    "list_databases",
    { description: "Databases with ids, row counts and property schemas", inputSchema: { limit, offset }, annotations: { readOnlyHint: true } },
    guarded(({ limit: n, offset: o }: { limit?: number | undefined; offset?: number | undefined }) => text(paged(dbs.list(), n ?? 50, o ?? 0))),
  );
  server.registerTool(
    "database_schema",
    { description: "Properties of a database with types and allowed values", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
    guarded(({ id }: { id: string }) => text(dbs.schema(id))),
  );
  server.registerTool(
    "query_database",
    {
      description: "Rows of a database with property values as text. Optional text search across all cells and sort by a property name.",
      inputSchema: { id: z.string(), search: z.string().optional(), sort: z.string().optional(), descending: z.boolean().optional(), limit, offset },
      annotations: { readOnlyHint: true },
    },
    guarded((a: { id: string; search?: string | undefined; sort?: string | undefined; descending?: boolean | undefined; limit?: number | undefined; offset?: number | undefined }) =>
      text(paged(dbs.query(a.id, { search: a.search, sort: a.sort, descending: a.descending }), a.limit ?? 50, a.offset ?? 0))),
  );
  server.registerTool(
    "add_row",
    { description: "Add a row to a database; set properties by name with plain strings. Returns the row id.", inputSchema: { id: z.string(), values } },
    guarded(({ id, values: v }: { id: string; values: Record<string, string> }) => {
      const rowID = dbs.addRow(id, v);
      return text(`Added row ${rowID} (${PAGE_URI}${rowID}).`);
    }),
  );
  server.registerTool(
    "update_row",
    { description: "Change properties of a database row by name with plain strings", inputSchema: { id: z.string().describe("Row id"), values } },
    guarded(({ id, values: v }: { id: string; values: Record<string, string> }) => {
      dbs.updateRow(id, v);
      return text(`Updated row ${id}.`);
    }),
  );

  // BSD-221 Teil 3b: Schema und Ansichten (Namen und Argumente wie Swift AgentTools).
  const viewArgs = {
    name: z.string().optional().describe("View name"),
    filters: z.array(z.object({ property: z.string(), op: z.string().optional(), value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional() })).optional()
      .describe("[{property, op, value}] — op: equals, notEquals, contains, notContains, isEmpty, isNotEmpty, greater, less, before, after, onOrBefore, onOrAfter"),
    filter_mode: z.enum(["and", "or"]).optional(),
    sorts: z.array(z.object({ property: z.string(), direction: z.string().optional() })).optional().describe("[{property, direction: ascending|descending}]"),
    group_by: z.string().optional().describe("Property name to group by (empty string clears)"),
  };
  server.registerTool(
    "create_database",
    {
      description: "Create a database, inline inside a page or as a full page. Properties: name → type (text, number, select, multiSelect, status, date, person, files, checkbox, url, email, phone, relation, place).",
      inputSchema: {
        title: z.string(), parent_id: z.string().optional().describe("Parent page id (omit for workspace root)"),
        inline: z.boolean().optional().describe("Embed in the parent page (default true when parent_id is given)"),
        properties: z.record(z.string(), z.string()).optional().describe("name → property type"),
        view: z.string().optional().describe("First view layout: table, board, list, gallery, calendar, timeline"),
      },
    },
    guarded((a: Parameters<Databases["createDatabase"]>[0]) => text(dbs.createDatabase(a))),
  );
  server.registerTool(
    "update_database",
    {
      description: "Rename a database, or add, rename, retype or delete properties, or add select options.",
      inputSchema: {
        database_id: z.string(), title: z.string().optional(),
        add_properties: z.record(z.string(), z.string()).optional().describe("name → type"),
        rename_properties: z.record(z.string(), z.string()).optional().describe("old name → new name"),
        change_types: z.record(z.string(), z.string()).optional().describe("name → new type"),
        delete_properties: z.array(z.string()).optional(),
        add_options: z.record(z.string(), z.array(z.string())).optional().describe("select/status property name → option names"),
      },
    },
    guarded((a: Parameters<Databases["updateDatabase"]>[0]) => text(dbs.updateDatabase(a))),
  );
  server.registerTool(
    "list_views",
    { description: "List the views of a database with their layout, filters, sorts and grouping.", inputSchema: { database_id: z.string() } },
    guarded(({ database_id }: { database_id: string }) => text(dbs.listViews(database_id))),
  );
  server.registerTool(
    "create_view",
    { description: "Add a view (table, board, list, gallery, calendar, timeline, map, form) to a database, optionally with filters, sorts and grouping.", inputSchema: { database_id: z.string(), type: z.string(), ...viewArgs } },
    guarded((a: Parameters<Databases["createView"]>[0]) => text(dbs.createView(a))),
  );
  server.registerTool(
    "update_view",
    { description: "Change a view's name, layout, filters, sorts or grouping. Passing filters/sorts replaces them; pass [] to clear.", inputSchema: { view_id: z.string(), type: z.string().optional(), ...viewArgs } },
    guarded((a: Parameters<Databases["updateViewTool"]>[0]) => text(dbs.updateViewTool(a))),
  );
  server.registerTool(
    "delete_view",
    { description: "Delete a view of a database (the last view stays).", inputSchema: { view_id: z.string() } },
    guarded(({ view_id }: { view_id: string }) => text(dbs.deleteViewTool(view_id))),
  );

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

  // MARK: Seiten-Werkzeuge wie die Swift-App (BSD-221 Teil 2, AgentTools.swift)
  const store = pages.store;
  const pageOf = (id: string) => {
    if (!isPageLike(store.blocks.get(id))) throw new ToolError(`No page ${id}`);
    return id;
  };

  server.registerTool(
    "find_replace",
    {
      description: "Replace text inside a page's blocks (like editing a passage) without rewriting the whole page. Matches are case-sensitive; formatting around the passage is kept.",
      inputSchema: { id: z.string(), find: z.string().min(1), replace: z.string(), all: z.boolean().optional().describe("Replace every match (default: first only)") },
    },
    guarded(({ id, find, replace, all }: { id: string; find: string; replace: string; all?: boolean | undefined }) => {
      pageOf(id);
      const changes: { id: string; text: ReturnType<typeof replaceInRichText>["text"] }[] = [];
      let count = 0;
      const visit = (parent: string): boolean => {
        for (const cid of store.children(parent)) {
          const b = store.blocks.get(cid);
          if (!b || isPageLike(b)) continue;
          if (b.text !== undefined) {
            const r = replaceInRichText(b.text, find, replace, { all: all === true });
            if (r.count > 0) {
              changes.push({ id: cid, text: r.text });
              count += r.count;
              if (all !== true) return true;
            }
          }
          if (visit("b:" + cid)) return true;
        }
        return false;
      };
      visit("b:" + id);
      if (count === 0) return text(`No match for that text in ${pages.title(id)}.`);
      store.transact("MCP: find and replace", (tx) => {
        for (const c of changes) {
          tx.update(c.id, (x) => {
            if (c.text === "" || (Array.isArray(c.text) && c.text.length === 0)) delete x.text;
            else x.text = c.text;
          });
        }
      });
      return text(`Replaced ${count} match(es) in ${pages.title(id)}.`);
    }),
  );

  server.registerTool(
    "move_page",
    { description: "Move a page under another page, or to the top level (Private) when parent_id is omitted.", inputSchema: { id: z.string(), parent_id: z.string().optional() } },
    guarded(({ id, parent_id }: { id: string; parent_id?: string | undefined }) => {
      pageOf(id);
      if (parent_id !== undefined) pageOf(parent_id);
      const ok = movePages(store, [id], parent_id !== undefined ? { kind: "page", id: parent_id } : { kind: "top", section: PRIVATE });
      if (!ok) throw new ToolError(`Couldn't move ${pages.title(id)} there (into itself or one of its sub-pages?).`);
      return text(`Moved ${pages.title(id)}${parent_id !== undefined ? ` under ${pages.title(parent_id)}` : " to the top level"}.`);
    }),
  );

  server.registerTool(
    "duplicate_page",
    { description: "Duplicate a page with all its content (placed right after the original).", inputSchema: { id: z.string() } },
    guarded(({ id }: { id: string }) => {
      pageOf(id);
      const copy = duplicatePages(store, [id])[0];
      if (!copy) throw new ToolError(`Could not duplicate ${id}`);
      return text(`Duplicated as ${pages.title(copy)} (id: ${copy}) [link: ${PAGE_URI}${copy}]`);
    }),
  );

  server.registerTool(
    "backlinks",
    { description: "Pages that link to or mention a page.", inputSchema: { id: z.string(), limit, offset }, annotations: { readOnlyHint: true } },
    guarded(({ id, limit: n, offset: o }: { id: string; limit?: number | undefined; offset?: number | undefined }) => {
      pageOf(id);
      const ids = backlinksTo(store, id);
      return text(ids.length === 0 ? "No backlinks." : paged(ids.map(line), n ?? 50, o ?? 0));
    }),
  );

  server.registerTool(
    "set_favorite",
    { description: "Add a page to or remove it from Favorites.", inputSchema: { id: z.string(), favorite: z.boolean().describe("true to add, false to remove") } },
    guarded(({ id, favorite }: { id: string; favorite: boolean }) => {
      pageOf(id);
      setFavorite(store, [id], favorite);
      return text(`${favorite ? "Added" : "Removed"} ${pages.title(id)} ${favorite ? "to" : "from"} Favorites.`);
    }),
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
