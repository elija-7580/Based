// BSD-159 / BSD-74: Werkzeuge über den Workspace (Seiten suchen/lesen/anlegen/ändern, Datenbanken abfragen, Zeilen
// anlegen/ändern) als Registry, ausgeführt auf dem WorkspaceStore (im Web: im Store-Worker). Namen und Verhalten wie
// in docs/mcp.md (Swift `AgentTools`, TS-Server `pages.ts`).
//
// BSD-74: Jedes Schreib-Werkzeug ist genau eine `store.transact` – ein Undo-Schritt, alles oder nichts (wirft der
// Rumpf, dreht der Store alles zurück; kein Zwischenstand im Sync). `find_replace` ersetzt lauf-weise im RichText
// (`replaceInRichText`), Fett/Kursiv/Links/Erwähnungen bleiben.
import {
  attachSearchIndex, addRow, cellText, insertPage, isPageLike, isTrashed, keyOf, makeBlock, makeRecordID, MarkdownExporter, MarkdownImporter,
  parseCSVValue, plainText, QueryEngine, replaceInRichText, rowsOf, sortKeys, titleOf, titleProperty, toRichText,
  type Block, type BlockProps, type Database, type JSONValue, type MarkdownBlock, type PropertySchema, type PropertyValue, type Tx, type WorkspaceStore,
} from "@based/core";
import type { ToolHost, ToolResult } from "./engine.js";
import type { ToolSpec } from "./messages.js";

export const PAGE_URI = "based://page/";

/** Fehler, den ein Werkzeug dem Modell als Antwort (isError) zurückgibt. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

type Args = { [key: string]: JSONValue };

interface ToolDef {
  spec: ToolSpec;
  write: boolean;
  run: (args: Args) => string;
}

const obj = (properties: Record<string, JSONValue>, required: string[] = []): JSONValue => ({ type: "object", properties, required, additionalProperties: false });
const S = { type: "string" } as const;
const pageID = { type: "string", description: "Page id (UUID)" } as const;
const limitSchema = { type: "integer", minimum: 1, maximum: 500, description: "Max items (default 50)" } as const;
const offsetSchema = { type: "integer", minimum: 0, description: "Skip this many items" } as const;

/** Markdown-Blöcke in einer Transaktion schreiben; `firstID` = ID des ersten Blocks (Idempotenz im Ausführer). */
export function putMarkdownBlocks(store: WorkspaceStore, tx: Tx, items: MarkdownBlock[], parent: string, keys: string[], firstID?: string) {
  items.forEach((item, i) => {
    const props: BlockProps = { ...item.props };
    if (item.type === "table" && props.tableColumns === undefined) props.tableColumns = 2;
    const id = i === 0 && firstID ? firstID : makeRecordID();
    tx.put({ kind: "block", data: makeBlock({ id, type: item.type, parent, sk: keys[i]!, text: toRichText(item.text), props, createdBy: store.userID }, store.now()) });
    if (item.children.length > 0) putMarkdownBlocks(store, tx, item.children, "b:" + id, sortKeys(store, "b:" + id, { kind: "end" }, item.children.length));
  });
}

/** Liste mit `limit`/`offset`, Rest als „… N more (offset: K)“. */
function paged(lines: string[], limit: number, offset: number): string {
  const slice = lines.slice(offset, offset + limit);
  const rest = lines.length - offset - slice.length;
  const out = slice.length > 0 ? slice.join("\n") : "(none)";
  return rest > 0 ? `${out}\n… ${rest} more (offset: ${offset + slice.length})` : out;
}

export interface WorkspaceToolsOptions {
  /** Eigene Suche (z. B. der Index, den der Store-Host ohnehin pflegt). Ohne: eigener Volltextindex. */
  search?: (query: string, limit: number) => { pageID: string; snippet?: string | undefined }[];
}

export class WorkspaceTools implements ToolHost {
  private readonly defs = new Map<string, ToolDef>();
  private ownIndex: ReturnType<typeof attachSearchIndex> | undefined;

  constructor(readonly store: WorkspaceStore, private readonly opts: WorkspaceToolsOptions = {}) {
    for (const d of this.build()) this.defs.set(d.spec.name, d);
  }

  dispose() {
    this.ownIndex?.dispose();
    this.ownIndex = undefined;
  }

  get specs(): ToolSpec[] {
    return [...this.defs.values()].map((d) => d.spec);
  }

  isWrite(name: string): boolean {
    return this.defs.get(name)?.write ?? true;
  }

  call(name: string, input: JSONValue): Promise<ToolResult> {
    return Promise.resolve(this.callSync(name, input));
  }

  /** Synchron (der Store ist es auch); Fehler eines Werkzeugs werden zur Antwort, nie zu einem halben Schreiben. */
  callSync(name: string, input: JSONValue): ToolResult {
    const def = this.defs.get(name);
    if (!def) return { text: `Unknown tool ${name}`, isError: true };
    const args: Args = input !== null && typeof input === "object" && !Array.isArray(input) ? input : {};
    try {
      if (def.write && this.store.isReadOnly) throw new ToolError("The workspace is read-only right now (saving failed). Nothing was changed.");
      const revision = this.store.revision;
      const text = def.run(args);
      // Ein Schreiben, das der Store abgewiesen hat (schreibgeschützt), darf nicht als Erfolg gemeldet werden.
      if (def.write && this.store.isReadOnly && this.store.revision === revision) throw new ToolError("Saving failed; nothing was changed.");
      return { text, isError: false };
    } catch (e) {
      if (e instanceof ToolError) return { text: e.message, isError: true };
      return { text: `Tool ${name} failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  }

  // MARK: Helfer

  private importer() {
    return new MarkdownImporter({
      // Links auf based://page/<id> oder eine bekannte Seiten-ID werden Erwähnungen.
      resolveLink: (target) => {
        const id = target.startsWith(PAGE_URI) ? target.slice(PAGE_URI.length) : target;
        return isPageLike(this.store.blocks.get(id)) ? id : undefined;
      },
    });
  }

  private exporter() {
    return new MarkdownExporter(this.store, { pageLink: (id) => ({ title: titleOf(this.store, id), url: PAGE_URI + id }) });
  }

  private page(id: string, allowTrashed = false): Block {
    const b = this.store.blocks.get(id);
    if (!b || !isPageLike(b)) throw new ToolError(`No page with id ${id}`);
    if (!allowTrashed && isTrashed(this.store, id)) throw new ToolError(`Page ${id} is in the Trash`);
    return b;
  }

  private database(id: string): Database {
    const db = this.store.databases.get(id);
    if (!db) throw new ToolError(`No database with id ${id} (list_databases shows the ids)`);
    return db;
  }

  private line = (id: string) => `- ${titleOf(this.store, id) || "Untitled"} (id: ${id})`;

  private search(query: string, limit: number): { pageID: string; snippet?: string | undefined }[] {
    if (this.opts.search) return this.opts.search(query, limit);
    this.ownIndex ??= attachSearchIndex(this.store);
    return this.ownIndex.index.search(query, {}, "bestMatch", limit * 2);
  }

  /** Inhaltsblöcke einer Seite in Dokumentreihenfolge, ohne Unterseiten und deren Inhalt. */
  private contentBlocks(pageID: string): Block[] {
    const out: Block[] = [];
    const visit = (parent: string) => {
      for (const id of this.store.children(parent)) {
        const b = this.store.blocks.get(id);
        if (!b || isPageLike(b)) continue;
        out.push(b);
        visit("b:" + id);
      }
    };
    visit("b:" + pageID);
    return out;
  }

  /** `{Name: "Wert"}` → Werte nach Property-ID; unbekannte Namen und nicht lesbare Werte sind Fehler (nichts wird geschrieben). */
  private rowValues(db: Database, properties: JSONValue | undefined): { title?: string; set: Record<string, PropertyValue>; clear: string[] } {
    const out: { title?: string; set: Record<string, PropertyValue>; clear: string[] } = { set: {}, clear: [] };
    if (properties === undefined || properties === null) return out;
    if (typeof properties !== "object" || Array.isArray(properties)) throw new ToolError("properties must be an object {\"Property name\": \"value\"}");
    const titleProp = titleProperty(db);
    for (const [name, raw] of Object.entries(properties)) {
      const p: PropertySchema | undefined = db.properties.find((x) => x.name === name) ?? db.properties.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!p) throw new ToolError(`No property “${name}” in this database. Properties: ${db.properties.map((x) => x.name).join(", ")}`);
      let s = raw === null ? "" : typeof raw === "string" ? raw : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : undefined;
      if (s === undefined) throw new ToolError(`Property “${name}”: give the value as a plain string`);
      if (p.id === titleProp.id || p.type === "title") { out.title = s; continue; }
      if (["formula", "rollup", "createdTime", "lastEditedTime", "createdBy", "lastEditedBy", "uniqueID", "relation", "person", "files", "button"].includes(p.type)) {
        throw new ToolError(`Property “${name}” (${p.type}) can't be set with a plain string`);
      }
      if (p.type === "checkbox") s = /^(true|yes|x|✓|1|checked)$/i.test(s.trim()) ? "Yes" : s.trim() === "" ? "" : "No";
      if (s.trim() === "" && p.type !== "checkbox") { out.clear.push(p.id); continue; }
      const v = parseCSVValue(s, p);
      if (v === undefined) {
        const hint = p.type === "select" || p.type === "status" || p.type === "multiSelect" ? ` Options: ${(p.options ?? []).map((o) => o.name).join(", ")}` : "";
        throw new ToolError(`Property “${name}” (${p.type}): can't read “${s}”.${hint}`);
      }
      out.set[p.id] = v;
    }
    return out;
  }

  private rowLine(engine: QueryEngine, db: Database, row: Block): string {
    const titleProp = titleProperty(db);
    const cells: string[] = [];
    for (const p of db.properties) {
      if (p.id === titleProp.id || p.type === "title" || p.type === "button") continue;
      const v = engine.value(row, p, db);
      // Nicht gesetzte Checkboxen sind kein Inhalt.
      if (v.t === "bool" && !v.v) continue;
      const t = (v.t === "bool" ? "yes" : cellText(this.store, v)).replace(/\n/g, " ");
      if (t !== "") cells.push(`${p.name}: ${t}`);
    }
    return `- ${plainText(row.text) || "Untitled"} (id: ${row.id})${cells.length ? " — " + cells.join("; ") : ""}`;
  }

  // MARK: Die Werkzeuge

  private build(): ToolDef[] {
    const store = this.store;
    const str = (a: Args, k: string): string | undefined => (typeof a[k] === "string" ? (a[k] as string) : undefined);
    const need = (a: Args, k: string): string => {
      const v = str(a, k);
      if (v === undefined || v === "") throw new ToolError(`Missing argument ${k}`);
      return v;
    };
    const num = (a: Args, k: string, fallback: number): number => (typeof a[k] === "number" ? Math.max(0, Math.floor(a[k] as number)) : fallback);

    return [
      {
        write: false,
        spec: { name: "search", description: "Search titles and full text of pages and database rows. Returns ids and snippets.", inputSchema: obj({ query: S, limit: limitSchema }, ["query"]) },
        run: (a) => {
          const limit = Math.max(1, num(a, "limit", 20));
          const seen = new Set<string>();
          const lines: string[] = [];
          for (const h of this.search(need(a, "query"), limit)) {
            if (seen.has(h.pageID) || !isPageLike(store.blocks.get(h.pageID)) || isTrashed(store, h.pageID)) continue;
            seen.add(h.pageID);
            lines.push(this.line(h.pageID) + (h.snippet ? `\n  ${h.snippet.replace(/\n/g, " ")}` : ""));
            if (lines.length >= limit) break;
          }
          return lines.length > 0 ? lines.join("\n") : "No pages found.";
        },
      },
      {
        write: false,
        spec: { name: "read_page", description: "A page as Markdown, with its properties when it is a database row.", inputSchema: obj({ page_id: pageID }, ["page_id"]) },
        run: (a) => {
          const id = need(a, "page_id");
          this.page(id, true);
          const md = this.exporter().export(id);
          return isTrashed(store, id) ? `(in the Trash)\n\n${md}` : md;
        },
      },
      {
        write: false,
        spec: { name: "list_pages", description: "Top-level pages, or the sub-pages of a page.", inputSchema: obj({ parent_id: pageID, limit: limitSchema, offset: offsetSchema }) },
        run: (a) => {
          const parent = str(a, "parent_id");
          if (parent !== undefined) this.page(parent);
          const ids = store.children(parent === undefined ? "w" : "b:" + parent).filter((id) => {
            const b = store.blocks.get(id);
            return isPageLike(b) && b?.trashedAt === undefined;
          });
          return paged(ids.map(this.line), Math.max(1, num(a, "limit", 50)), num(a, "offset", 0));
        },
      },
      {
        write: true,
        spec: {
          name: "create_page",
          description: "New page from Markdown under a parent page (or at the top level). A leading “# Title” line becomes the title when title is omitted.",
          inputSchema: obj({ title: S, markdown: S, parent_id: pageID }),
        },
        run: (a) => {
          const parent = str(a, "parent_id");
          if (parent !== undefined) this.page(parent);
          let title = str(a, "title");
          let body = str(a, "markdown") ?? "";
          if (title === undefined) {
            const split = MarkdownImporter.splitTitle(body);
            title = split.title;
            body = split.body;
          }
          const blocks = this.importer().parse(body);
          const id = store.transact("Agent: new page", (tx) => {
            const pid = insertPage(store, tx, { ...(parent ? { parent } : {}), ...(title ? { title } : {}) });
            if (blocks.length > 0) putMarkdownBlocks(store, tx, blocks, "b:" + pid, sortKeys(store, "b:" + pid, { kind: "end" }, blocks.length));
            return pid;
          });
          return `Created page “${title ?? "Untitled"}” (id: ${id})`;
        },
      },
      {
        write: true,
        spec: { name: "append_markdown", description: "Append Markdown blocks to the end of a page.", inputSchema: obj({ page_id: pageID, markdown: S }, ["page_id", "markdown"]) },
        run: (a) => {
          const id = need(a, "page_id");
          this.page(id);
          const blocks = this.importer().parse(need(a, "markdown"));
          if (blocks.length === 0) return "Nothing to append.";
          store.transact("Agent: append", (tx) => putMarkdownBlocks(store, tx, blocks, "b:" + id, sortKeys(store, "b:" + id, { kind: "end" }, blocks.length)));
          return `Appended ${blocks.length} block${blocks.length === 1 ? "" : "s"} to “${titleOf(store, id)}”`;
        },
      },
      {
        write: true,
        spec: {
          name: "replace_page_content",
          description: "Replace the whole body of a page with Markdown (sub-pages and databases stay). Only when the user wants a rewrite.",
          inputSchema: obj({ page_id: pageID, markdown: S }, ["page_id", "markdown"]),
        },
        run: (a) => {
          const id = need(a, "page_id");
          this.page(id);
          const blocks = this.importer().parse(str(a, "markdown") ?? "");
          const content = store.children("b:" + id).filter((k) => {
            const b = store.blocks.get(k);
            return b !== undefined && !isPageLike(b) && b.type !== "databaseInline";
          });
          let removed = 0;
          // BSD-74: Löschen und Einfügen in EINER Transaktion (Swift `setBody` waren zwei: zwei Undo-Schritte, kurz leere Seite im Sync).
          store.transact("Agent: replace content", (tx) => {
            for (const k of content) {
              for (const d of [...store.descendants(k).reverse(), k]) {
                if (isPageLike(store.blocks.get(d))) throw new ToolError("This page has sub-pages nested inside its blocks; replacing would delete them. Use find_replace or append_markdown instead.");
                tx.remove(keyOf("block", d));
                removed += 1;
              }
            }
            if (blocks.length > 0) putMarkdownBlocks(store, tx, blocks, "b:" + id, sortKeys(store, "b:" + id, { kind: "end" }, blocks.length));
          });
          return `Replaced the content of “${titleOf(store, id)}” (${removed} blocks removed, ${blocks.length} added)`;
        },
      },
      {
        write: true,
        spec: {
          name: "find_replace",
          description: "Replace a passage inside a page's text blocks. Formatting (bold, links, mentions) around the passage is kept. Fails without changes when the text is not found.",
          inputSchema: obj({ page_id: pageID, find: S, replace: S, all: { type: "boolean", description: "Replace every occurrence (default: only the first)" } }, ["page_id", "find", "replace"]),
        },
        run: (a) => {
          const id = need(a, "page_id");
          this.page(id);
          const find = need(a, "find");
          const replace = str(a, "replace") ?? "";
          const all = a.all === true;
          const changes: { id: string; text: Block["text"] }[] = [];
          let count = 0;
          for (const b of this.contentBlocks(id)) {
            if (b.text === undefined) continue;
            const r = replaceInRichText(b.text, find, replace, { all });
            if (r.count === 0) continue;
            changes.push({ id: b.id, text: r.text });
            count += r.count;
            if (!all) break;
          }
          if (count === 0) throw new ToolError(`“${find}” was not found in “${titleOf(store, id)}”. Nothing was changed.`);
          store.transact("Agent: find and replace", (tx) => {
            for (const c of changes) {
              tx.update(c.id, (x) => {
                if (c.text === undefined || c.text === "" || (Array.isArray(c.text) && c.text.length === 0)) delete x.text;
                else x.text = c.text;
              });
            }
          });
          return `Replaced ${count} occurrence${count === 1 ? "" : "s"} in “${titleOf(store, id)}”`;
        },
      },
      {
        write: true,
        spec: { name: "update_page", description: "Change a page's title or emoji icon (empty icon removes it).", inputSchema: obj({ page_id: pageID, title: S, icon: S }, ["page_id"]) },
        run: (a) => {
          const id = need(a, "page_id");
          const b = this.page(id);
          const title = str(a, "title"), icon = str(a, "icon");
          if (title === undefined && icon === undefined) throw new ToolError("Give a title or an icon");
          const dbID = b.type === "databasePage" ? b.props?.databaseID : undefined;
          const db = dbID ? store.databases.get(dbID) : undefined;
          store.transact("Agent: update page", (tx) => {
            if (title !== undefined && db) tx.put({ kind: "database", data: { ...structuredClone(db), title } });
            tx.update(id, (x) => {
              if (title !== undefined && !db) {
                if (title === "") delete x.text;
                else x.text = title;
              }
              if (icon !== undefined) {
                if (icon === "") {
                  if (x.props) delete x.props.icon;
                } else x.props = { ...(x.props ?? {}), icon };
              }
              if (x.props && Object.keys(x.props).length === 0) delete x.props;
            });
          });
          return `Updated “${titleOf(store, id)}”`;
        },
      },
      {
        write: false,
        spec: { name: "list_databases", description: "Databases with ids and their properties (name: type, options for selects).", inputSchema: obj({ limit: limitSchema, offset: offsetSchema }) },
        run: (a) => {
          const lines: string[] = [];
          for (const db of store.databases.values()) {
            if (db.blockID && (!store.blocks.has(db.blockID) || isTrashed(store, db.blockID))) continue;
            const props = db.properties.map((p) => {
              const options = p.type === "select" || p.type === "status" || p.type === "multiSelect" ? ` [${(p.options ?? []).map((o) => o.name).join(", ")}]` : "";
              return `${p.name}: ${p.type}${options}`;
            });
            lines.push(`- ${plainText(db.title) || "Untitled"} (id: ${db.id}, ${rowsOf(store, db.id).length} rows)\n  ${props.join("; ")}`);
          }
          return paged(lines, Math.max(1, num(a, "limit", 50)), num(a, "offset", 0));
        },
      },
      {
        write: false,
        spec: { name: "query_database", description: "Rows of a database with their property values as text.", inputSchema: obj({ database_id: S, limit: limitSchema, offset: offsetSchema }, ["database_id"]) },
        run: (a) => {
          const db = this.database(need(a, "database_id"));
          const engine = new QueryEngine(store);
          const rows = rowsOf(store, db.id).filter((r) => r.trashedAt === undefined && r.props?.isTemplate !== true);
          return paged(rows.map((r) => this.rowLine(engine, db, r)), Math.max(1, num(a, "limit", 50)), num(a, "offset", 0));
        },
      },
      {
        write: true,
        spec: {
          name: "add_row",
          description: "Add a row to a database. Set properties by name with plain strings (dates as YYYY-MM-DD, checkboxes as true/false, multi-selects comma-separated).",
          inputSchema: obj({ database_id: S, title: S, properties: { type: "object", additionalProperties: { type: "string" } } }, ["database_id"]),
        },
        run: (a) => {
          const db = this.database(need(a, "database_id"));
          // Erst alles prüfen und umwandeln, dann in einer Transaktion schreiben (`addRow` ist eine).
          const v = this.rowValues(db, a.properties);
          const title = str(a, "title") ?? v.title;
          const id = addRow(store, db.id, { ...(title ? { title } : {}), values: v.set });
          if (!id) throw new ToolError("The row could not be added");
          return `Added row “${title ?? "Untitled"}” (id: ${id}) to “${plainText(db.title) || "Untitled"}”`;
        },
      },
      {
        write: true,
        spec: {
          name: "update_row",
          description: "Change a database row: title and/or properties by name with plain strings (an empty string clears a property).",
          inputSchema: obj({ row_id: S, title: S, properties: { type: "object", additionalProperties: { type: "string" } } }, ["row_id"]),
        },
        run: (a) => {
          const id = need(a, "row_id");
          const row = store.blocks.get(id);
          if (!row || !row.parent.startsWith("d:")) throw new ToolError(`No database row with id ${id}`);
          const db = this.database(row.parent.slice(2));
          const v = this.rowValues(db, a.properties);
          const title = str(a, "title") ?? v.title;
          if (title === undefined && Object.keys(v.set).length === 0 && v.clear.length === 0) throw new ToolError("Give a title or properties to change");
          store.transact("Agent: update row", (tx) => tx.update(id, (x) => {
            if (title !== undefined) {
              if (title === "") delete x.text;
              else x.text = title;
            }
            const values = { ...(x.values ?? {}) };
            for (const [k, val] of Object.entries(v.set)) values[k] = val;
            for (const k of v.clear) delete values[k];
            if (Object.keys(values).length > 0) x.values = values;
            else delete x.values;
          }));
          return `Updated row “${titleOf(store, id) || "Untitled"}”`;
        },
      },
    ];
  }
}
