// Seiten: suchen, lesen, auflisten, anlegen, schreiben (Markdown), umbenennen, verschieben, duplizieren, Papierkorb,
// Favoriten, Backlinks. Jedes Schreib-Werkzeug ist eine Transaktion (ein Undo-Schritt, alles oder nichts).
import {
  backlinksTo, duplicatePages, insertPage, isPageLike, isTrashed, keyOf, MarkdownImporter, movePages, pageLocation, PRIVATE, replaceInRichText, restorePages, setFavorite, sortKeys,
  trashedPages, trashPages, type Block,
} from "@based/core";
import { bool, limitSchema, needStr, obj, offsetSchema, optNum, optStr, pageID, paged, putMarkdownBlocks, S, str, ToolError, type ToolDef } from "./base.js";
import type { ToolCtx } from "./context.js";

const ID = { page_id: "id" };

export function pageTools(ctx: ToolCtx): ToolDef[] {
  const { store } = ctx;

  /** Inhaltsblöcke einer Seite in Dokumentreihenfolge, ohne Unterseiten und deren Inhalt. */
  const contentBlocks = (page: string): Block[] => {
    const out: Block[] = [];
    const visit = (parent: string) => {
      for (const id of store.children(parent)) {
        const b = store.blocks.get(id);
        if (!b || isPageLike(b)) continue;
        out.push(b);
        visit("b:" + id);
      }
    };
    visit("b:" + page);
    return out;
  };

  return [
    {
      group: "pages", write: false,
      spec: {
        name: "search",
        description:
          "Find pages and database rows by title, text, or row values (including the titles of related rows, people and options). " +
          "Words may be spread over a page and may contain typos. Returns ids, where each page lives, and a snippet. " +
          "Use `within` to search below one page or database, `title_only` for titles. For how pages are connected use `backlinks`.",
        inputSchema: obj({ query: { type: "string", minLength: 1 }, limit: limitSchema, within: str("Page or database id to search below"), title_only: bool("Match titles only") }, ["query"]),
      },
      run: (a) => {
        const limit = Math.max(1, optNum(a, "limit", 20));
        const within = optStr(a, "within");
        const filters = { ...(a.title_only === true ? { titleOnly: true } : {}), ...(within ? { inPage: within } : {}) };
        const seen = new Set<string>();
        const lines: string[] = [];
        for (const h of ctx.search(needStr(a, "query"), limit, filters)) {
          const b = store.blocks.get(h.pageID);
          if (seen.has(h.pageID) || !b || !isPageLike(b) || isTrashed(store, h.pageID)) continue;
          seen.add(h.pageID);
          const where = pageLocation(store, h.pageID);
          lines.push(`${ctx.line(h.pageID)}${where ? ` · ${b.parent.startsWith("d:") ? "row in" : "in"} ${where}` : ""}${h.snippet ? ` — ${h.snippet.replace(/\n/g, " ")}` : ""}`);
          if (lines.length >= limit) break;
        }
        return lines.length > 0 ? lines.join("\n") : "No matches.";
      },
    },
    {
      group: "pages", write: false, aliases: ID,
      spec: { name: "read_page", description: "A page as Markdown, with its properties when it is a database row.", inputSchema: obj({ id: pageID }, ["id"]) },
      run: (a) => {
        const id = needStr(a, "id");
        ctx.page(id, true);
        const md = ctx.exporter().export(id);
        return isTrashed(store, id) ? `(in the Trash)\n\n${md}` : md;
      },
    },
    {
      group: "pages", write: false, aliases: { parent_id: "parent" },
      spec: { name: "list_pages", description: "Top-level pages, or the sub-pages of `parent`.", inputSchema: obj({ parent: pageID, limit: limitSchema, offset: offsetSchema }) },
      run: (a) => {
        const parent = optStr(a, "parent");
        if (parent !== undefined) ctx.page(parent);
        const ids = store.children(parent === undefined ? "w" : "b:" + parent).filter((id) => {
          const b = store.blocks.get(id);
          return isPageLike(b) && b?.trashedAt === undefined;
        });
        return paged(ids.map(ctx.line), Math.max(1, optNum(a, "limit", 50)), optNum(a, "offset", 0));
      },
    },
    {
      group: "pages", write: true, aliases: { parent_id: "parent" },
      spec: {
        name: "create_page",
        description: "Create a page from Markdown under `parent` (or at the top level). A leading `# Title` line becomes the title when `title` is missing.",
        inputSchema: obj({ title: S, markdown: S, parent: pageID }),
      },
      run: (a) => {
        const parent = optStr(a, "parent");
        if (parent !== undefined) ctx.page(parent);
        let title = optStr(a, "title");
        let body = optStr(a, "markdown") ?? "";
        if (title === undefined) {
          const split = MarkdownImporter.splitTitle(body);
          title = split.title;
          body = split.body;
        }
        const blocks = ctx.importer().parse(body);
        const id = store.transact("Agent: new page", (tx) => {
          const pid = insertPage(store, tx, { ...(parent ? { parent } : {}), ...(title ? { title } : {}) });
          if (blocks.length > 0) putMarkdownBlocks(store, tx, blocks, "b:" + pid, sortKeys(store, "b:" + pid, { kind: "end" }, blocks.length));
          return pid;
        });
        return `Created page “${title ?? "Untitled"}” (id: ${id})`;
      },
    },
    {
      group: "pages", write: true, aliases: ID,
      spec: { name: "append_markdown", description: "Append Markdown blocks to the end of a page. To put blocks at a certain place use edit_blocks.", inputSchema: obj({ id: pageID, markdown: S }, ["id", "markdown"]) },
      run: (a) => {
        const id = needStr(a, "id");
        ctx.page(id);
        const blocks = ctx.importer().parse(needStr(a, "markdown"));
        if (blocks.length === 0) return "Nothing to append.";
        store.transact("Agent: append", (tx) => putMarkdownBlocks(store, tx, blocks, "b:" + id, sortKeys(store, "b:" + id, { kind: "end" }, blocks.length)));
        return `Appended ${blocks.length} block${blocks.length === 1 ? "" : "s"} to “${ctx.title(id)}”`;
      },
    },
    {
      group: "pages", write: true, destructive: true, aliases: ID,
      spec: {
        name: "replace_page_content",
        description: "Replace the whole body of a page with Markdown (sub-pages and databases stay). Only when the user wants a rewrite; for a passage use find_replace, for single blocks edit_blocks.",
        inputSchema: obj({ id: pageID, markdown: S }, ["id", "markdown"]),
      },
      run: (a) => {
        const id = needStr(a, "id");
        ctx.page(id);
        const blocks = ctx.importer().parse(optStr(a, "markdown") ?? "");
        const content = store.children("b:" + id).filter((k) => {
          const b = store.blocks.get(k);
          return b !== undefined && !isPageLike(b) && b.type !== "databaseInline";
        });
        let removed = 0;
        // BSD-74: Löschen und Einfügen in EINER Transaktion (nie eine leere Seite im Sync).
        store.transact("Agent: replace content", (tx) => {
          for (const k of content) {
            for (const d of [...store.descendants(k).reverse(), k]) {
              if (isPageLike(store.blocks.get(d))) throw new ToolError("This page has sub-pages nested inside its blocks; replacing would delete them. Use find_replace, edit_blocks or append_markdown instead.");
              tx.remove(keyOf("block", d));
              removed += 1;
            }
          }
          if (blocks.length > 0) putMarkdownBlocks(store, tx, blocks, "b:" + id, sortKeys(store, "b:" + id, { kind: "end" }, blocks.length));
        });
        return `Replaced the content of “${ctx.title(id)}” (${removed} blocks removed, ${blocks.length} added)`;
      },
    },
    {
      group: "pages", write: true, aliases: ID,
      spec: {
        name: "find_replace",
        description: "Replace a passage inside a page's text blocks without rewriting the page. Case-sensitive; formatting (bold, links, mentions) around the passage is kept. Fails without changes when the text is not found.",
        inputSchema: obj({ id: pageID, find: { type: "string", minLength: 1 }, replace: S, all: bool("Replace every occurrence (default: only the first)") }, ["id", "find", "replace"]),
      },
      run: (a) => {
        const id = needStr(a, "id");
        ctx.page(id);
        const find = needStr(a, "find");
        const replace = optStr(a, "replace") ?? "";
        const all = a.all === true;
        const changes: { id: string; text: Block["text"] }[] = [];
        let count = 0;
        for (const b of contentBlocks(id)) {
          if (b.text === undefined) continue;
          const r = replaceInRichText(b.text, find, replace, { all });
          if (r.count === 0) continue;
          changes.push({ id: b.id, text: r.text });
          count += r.count;
          if (!all) break;
        }
        if (count === 0) throw new ToolError(`“${find}” was not found in “${ctx.title(id)}”. Nothing was changed.`);
        store.transact("Agent: find and replace", (tx) => {
          for (const c of changes) {
            tx.update(c.id, (x) => {
              if (c.text === undefined || c.text === "" || (Array.isArray(c.text) && c.text.length === 0)) delete x.text;
              else x.text = c.text;
            });
          }
        });
        return `Replaced ${count} occurrence${count === 1 ? "" : "s"} in “${ctx.title(id)}”`;
      },
    },
    {
      group: "pages", write: true, aliases: ID,
      spec: {
        name: "update_page",
        description: "Change a page's title, emoji icon (empty string removes it) or remove its cover.",
        inputSchema: obj({ id: pageID, title: S, icon: S, remove_cover: bool("Remove the cover") }, ["id"]),
      },
      run: (a) => {
        const id = needStr(a, "id");
        const b = ctx.page(id);
        const title = optStr(a, "title"), icon = optStr(a, "icon"), removeCover = a.remove_cover === true;
        if (title === undefined && icon === undefined && !removeCover) throw new ToolError("Give a title, an icon or remove_cover.");
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
            if (removeCover && x.props) delete x.props.cover;
            if (x.props && Object.keys(x.props).length === 0) delete x.props;
          });
        });
        return `Updated “${ctx.title(id)}”`;
      },
    },
    {
      group: "pages", write: true, aliases: ID,
      spec: {
        name: "move_page",
        description: "Move a page under another page, or to the top level (Private) when parent_id is omitted.",
        inputSchema: obj({ id: pageID, parent_id: pageID }, ["id"]),
      },
      run: (a) => {
        const id = needStr(a, "id");
        ctx.page(id, true);
        const parent = optStr(a, "parent_id");
        if (parent !== undefined) ctx.page(parent, true);
        const ok = movePages(store, [id], parent !== undefined ? { kind: "page", id: parent } : { kind: "top", section: PRIVATE });
        if (!ok) throw new ToolError(`Couldn't move “${ctx.title(id)}” there (into itself or one of its sub-pages?).`);
        return `Moved “${ctx.title(id)}”${parent !== undefined ? ` under “${ctx.title(parent)}”` : " to the top level"}.`;
      },
    },
    {
      group: "pages", write: true, aliases: ID,
      spec: { name: "duplicate_page", description: "Duplicate a page with all its content (placed right after the original).", inputSchema: obj({ id: pageID }, ["id"]) },
      run: (a) => {
        const id = needStr(a, "id");
        ctx.page(id, true);
        const copy = duplicatePages(store, [id])[0];
        if (!copy) throw new ToolError(`Could not duplicate ${id}`);
        return `Duplicated as “${ctx.title(copy)}” (id: ${copy})`;
      },
    },
    {
      group: "pages", write: true, destructive: true, aliases: ID,
      spec: { name: "trash_page", description: "Move a page (with everything in it) to the Trash. Restorable with restore_page. Works for database rows too.", inputSchema: obj({ id: pageID }, ["id"]) },
      run: (a) => {
        const id = needStr(a, "id");
        ctx.page(id, true);
        return trashPages(store, [id]).length > 0 ? `Moved “${ctx.title(id)}” to the Trash.` : `“${ctx.title(id)}” is already in the Trash.`;
      },
    },
    {
      group: "pages", write: true, aliases: ID,
      spec: { name: "restore_page", description: "Bring a page back from the Trash.", inputSchema: obj({ id: pageID }, ["id"]) },
      run: (a) => {
        const id = needStr(a, "id");
        const b = ctx.page(id, true);
        if (b.trashedAt === undefined) return `“${ctx.title(id)}” is not in the Trash.`;
        restorePages(store, [id]);
        return `Restored “${ctx.title(id)}”.`;
      },
    },
    {
      group: "pages", write: false,
      spec: { name: "list_trash", description: "Pages in the Trash, most recently deleted first.", inputSchema: obj({ limit: limitSchema, offset: offsetSchema }) },
      run: (a) => paged(trashedPages(store).filter(isPageLike).map((b) => ctx.line(b.id)), Math.max(1, optNum(a, "limit", 50)), optNum(a, "offset", 0)),
    },
    {
      group: "pages", write: false, aliases: ID,
      spec: { name: "backlinks", description: "Pages that link to or mention a page.", inputSchema: obj({ id: pageID, limit: limitSchema, offset: offsetSchema }, ["id"]) },
      run: (a) => {
        const id = needStr(a, "id");
        ctx.page(id, true);
        const ids = backlinksTo(store, id);
        return ids.length === 0 ? "No backlinks." : paged(ids.map(ctx.line), Math.max(1, optNum(a, "limit", 50)), optNum(a, "offset", 0));
      },
    },
    {
      group: "pages", write: true, aliases: ID,
      spec: { name: "set_favorite", description: "Add a page to or remove it from Favorites.", inputSchema: obj({ id: pageID, favorite: bool("true to add, false to remove") }, ["id", "favorite"]) },
      run: (a) => {
        const id = needStr(a, "id");
        ctx.page(id, true);
        const on = a.favorite === true;
        setFavorite(store, [id], on);
        return `${on ? "Added" : "Removed"} “${ctx.title(id)}” ${on ? "to" : "from"} Favorites.`;
      },
    },
  ];
}
