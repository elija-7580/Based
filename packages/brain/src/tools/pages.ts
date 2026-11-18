// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Seiten: suchen, lesen, auflisten, anlegen, schreiben (Markdown), umbenennen, verschieben, duplizieren, Papierkorb,
// Favoriten, Backlinks. Jedes Schreib-Werkzeug ist eine Transaktion (ein Undo-Schritt, alles oder nichts).
import {
  addStarterTemplate, COVER_COLOR_IDS, COVER_GRADIENT_COUNT, COVER_HEIGHT_MAX, COVER_HEIGHT_MIN, ICON_COLORS, parsePhosphorIcon, phosphorIcon, sectionOf, setCoverHeight, setCoverPosition,
  setPageCover, setPageFormat, setPageIcon, setPageIconImage, STARTER_TEMPLATES, workspaceFiles, type InsertPosition, type PageCoverValue, type PageDestination, type StarterTemplateID,
  backlinksTo, duplicatePages, putMarkdownBlocks, insertPage, isPageLike, isTrashed, keyOf, MarkdownImporter, movePages, pageLocation, PRIVATE, replaceInRichText, restorePages, setFavorite, sortKeys,
  trashedPages, trashPages, type Block,
} from "@based/core";
import { bool, limitSchema, needStr, obj, offsetSchema, optNum, optStr, pageID, paged, S, str, ToolError, type ToolDef } from "./base.js";
import type { ToolCtx } from "./context.js";
import { sectionFrom, sectionName } from "./workspace.js";

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
      spec: {
        name: "list_pages",
        description: "Top-level pages in sidebar order, or the sub-pages of `parent`. With teamspaces each top-level page says where it lives; `section` (private, or a teamspace name or id) lists one section.",
        inputSchema: obj({ parent: pageID, section: str("private, or a teamspace name or id"), limit: limitSchema, offset: offsetSchema }),
      },
      run: (a) => {
        const parent = optStr(a, "parent");
        if (parent !== undefined) ctx.page(parent);
        const section = optStr(a, "section");
        if (parent !== undefined && section !== undefined) throw new ToolError("Give parent or section, not both.");
        const only = section !== undefined ? sectionFrom(store, section) : undefined;
        const ids = store.children(parent === undefined ? "w" : "b:" + parent).filter((id) => {
          const b = store.blocks.get(id);
          if (!b || !isPageLike(b) || b.trashedAt !== undefined) return false;
          if (!only) return true;
          const sec = sectionOf(store, b);
          return sec.kind === only.kind && (sec.kind === "private" || sec.id === (only as { id: string }).id);
        });
        const grouped = parent === undefined && only === undefined && (store.workspace.teamspaces ?? []).length > 0;
        const line = (id: string) => (grouped ? `${ctx.line(id)} · in ${sectionName(store, sectionOf(store, store.blocks.get(id)!))}` : ctx.line(id));
        return paged(ids.map(line), Math.max(1, optNum(a, "limit", 50)), optNum(a, "offset", 0));
      },
    },
    {
      group: "pages", write: true, aliases: { parent_id: "parent" },
      spec: {
        name: "create_page",
        description:
          "Create a page from Markdown under `parent` (or at the top level, in `section`). A leading `# Title` line becomes the title when `title` is missing. " +
          "`after`: a page id to put it right behind (same place as that page). `template` instead of Markdown: " + STARTER_TEMPLATES.map((t) => t.id).join(", ") + " (ready-made pages and databases, placed at the top of Private).",
        inputSchema: obj({ title: S, markdown: S, parent: pageID, section: str("private, or a teamspace name or id (top-level pages only)"), after: pageID, template: { type: "string", enum: STARTER_TEMPLATES.map((t) => t.id) } }),
      },
      run: (a) => {
        const template = optStr(a, "template");
        if (template !== undefined) {
          if (["title", "markdown", "parent", "section", "after"].some((k) => a[k] !== undefined)) throw new ToolError("A template comes as it is: give only `template`, then rename or move the page.");
          const made = addStarterTemplate(store, template as StarterTemplateID);
          if (!made) throw new ToolError(`Could not add the template ${template}.`);
          return `Created “${ctx.title(made)}” from the template ${template} (id: ${made})`;
        }
        let parent = optStr(a, "parent");
        const after = optStr(a, "after");
        let section = optStr(a, "section") !== undefined ? sectionFrom(store, optStr(a, "section")!) : undefined;
        let position: InsertPosition = { kind: "end" };
        if (after !== undefined) {
          const sib = ctx.page(after);
          const sibParent = sib.parent.startsWith("b:") ? sib.parent.slice(2) : undefined;
          if (sib.parent.startsWith("d:")) throw new ToolError("`after` is a database row; use add_row to add rows.");
          if (parent !== undefined && parent !== sibParent) throw new ToolError("`after` is not a sub-page of `parent`.");
          parent = sibParent;
          if (parent === undefined) section ??= sectionOf(store, sib);
          position = { kind: "after", id: after };
        }
        if (parent !== undefined) {
          ctx.page(parent);
          if (section !== undefined && optStr(a, "section") !== undefined) throw new ToolError("Give parent or section, not both (a sub-page lives where its parent lives).");
        }
        let title = optStr(a, "title");
        let body = optStr(a, "markdown") ?? "";
        if (title === undefined) {
          const split = MarkdownImporter.splitTitle(body);
          title = split.title;
          body = split.body;
        }
        const blocks = ctx.importer().parse(body);
        const id = store.transact("Agent: new page", (tx) => {
          const pid = insertPage(store, tx, { ...(parent ? { parent } : {}), ...(parent === undefined && section ? { section } : {}), ...(title ? { title } : {}), position });
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
        ctx.writable(id);
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
        ctx.writable(id);
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
        ctx.writable(id);
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
        description:
          "Change a page's title, icon, cover and page options – what the page menu and the header of a page offer. " +
          `icon: an emoji, phosphor:<name>:<colour> (colours: ${ICON_COLORS.join(" ")}), a file ref or an https image URL; empty string removes it. ` +
          `cover: ${COVER_COLOR_IDS.join(" | ")} | gradient:0…${COVER_GRADIENT_COUNT - 1} | a file ref | an https image URL | none.`,
        inputSchema: obj({
          id: pageID, title: S, icon: S, cover: S,
          cover_height: { type: "number", minimum: COVER_HEIGHT_MIN, maximum: COVER_HEIGHT_MAX, description: "Height as a factor of the normal height" },
          cover_position: { type: "number", minimum: 0, maximum: 1, description: "Which part of the image shows: 0 top … 1 bottom" },
          font: { type: "string", enum: ["default", "serif", "mono"] }, small_text: bool("Smaller text on this page"), full_width: bool("Use the full width"),
          locked: bool("Lock the page against edits (the user's switch “Lock page”)"), remove_cover: bool("Same as cover: none"),
        }, ["id"]),
      },
      run: (a) => {
        const id = needStr(a, "id");
        const b = ctx.page(id);
        const title = optStr(a, "title"), icon = optStr(a, "icon");
        const cover = a.remove_cover === true ? "none" : optStr(a, "cover");
        const format = {
          ...(optStr(a, "font") !== undefined ? { font: optStr(a, "font") as "default" | "serif" | "mono" } : {}),
          ...(typeof a.small_text === "boolean" ? { smallText: a.small_text } : {}),
          ...(typeof a.full_width === "boolean" ? { fullWidth: a.full_width } : {}),
          ...(typeof a.locked === "boolean" ? { locked: a.locked } : {}),
        };
        const height = typeof a.cover_height === "number" ? a.cover_height : undefined;
        const position = typeof a.cover_position === "number" ? a.cover_position : undefined;
        if (title === undefined && icon === undefined && cover === undefined && Object.keys(format).length === 0 && height === undefined && position === undefined) throw new ToolError("Nothing to change: give a title, icon, cover or a page option.");
        let known: ReturnType<typeof workspaceFiles> | undefined;
        const asset = (ref: string) => {
          const info = ctx.fileInfo(ref, (known ??= workspaceFiles(store)).get(ref));
          if (!info) throw new ToolError(`Unknown file ${ref.slice(0, 24)}… — list_files shows the refs.`);
          if (info.mime && !info.mime.startsWith("image/")) throw new ToolError(`“${info.name}” is not an image.`);
          return { id: ref.slice("based-asset:".length), name: info.name, ...(info.mime ? { mime: info.mime } : {}), ...(info.size ? { size: Math.round(info.size) } : {}) };
        };
        // erst alles prüfen, dann schreiben
        let setIcon: (() => void) | undefined;
        if (icon !== undefined) {
          const v = icon.trim();
          if (v === "" || v === "none") setIcon = () => setPageIcon(store, id, undefined);
          else if (v.startsWith("phosphor:")) {
            const ref = parsePhosphorIcon(v);
            if (!ref) throw new ToolError("A Phosphor icon is written phosphor:<name>:<colour>, e.g. phosphor:rocket-launch:blue.");
            setIcon = () => setPageIcon(store, id, phosphorIcon(ref.name, ref.color));
          } else if (v.startsWith("based-asset:")) { const as = asset(v); setIcon = () => setPageIconImage(store, id, { asset: as }); }
          else if (/^https?:\/\//i.test(v)) setIcon = () => setPageIconImage(store, id, { url: v });
          else if (v.length > 16 || /^[\x20-\x7e]+$/.test(v)) throw new ToolError("icon takes an emoji, phosphor:<name>:<colour>, a file ref or an https image URL.");
          else setIcon = () => setPageIcon(store, id, v);
        }
        let coverValue: PageCoverValue | undefined | null = null;
        if (cover !== undefined) {
          const v = cover.trim();
          const grad = /^gradient:(\d+)$/.exec(v);
          if (v === "" || v === "none") coverValue = undefined;
          else if ((COVER_COLOR_IDS as readonly string[]).includes(v)) coverValue = { color: { _0: v } };
          else if (grad && Number(grad[1]) < COVER_GRADIENT_COUNT) coverValue = { gradient: { _0: Number(grad[1]) } };
          else if (v.startsWith("based-asset:")) coverValue = { asset: { _0: asset(v) } };
          else if (/^https?:\/\//i.test(v)) coverValue = { url: { _0: v } };
          else throw new ToolError(`cover takes ${COVER_COLOR_IDS.join(", ")}, gradient:0…${COVER_GRADIENT_COUNT - 1}, a file ref, an https image URL or none.`);
        }
        if ((height !== undefined || position !== undefined) && coverValue === undefined) throw new ToolError("cover_height and cover_position need a cover.");
        if ((height !== undefined || position !== undefined) && coverValue === null && b.props?.cover === undefined) throw new ToolError("This page has no cover; set `cover` too.");
        const dbID = b.type === "databasePage" ? b.props?.databaseID : undefined;
        const db = dbID ? store.databases.get(dbID) : undefined;
        if (title !== undefined) {
          store.transact("Agent: rename", (tx) => {
            if (db) tx.put({ kind: "database", data: { ...structuredClone(db), title } });
            else tx.update(id, (x) => { if (title === "") delete x.text; else x.text = title; });
          });
        }
        setIcon?.();
        if (coverValue !== null) setPageCover(store, id, coverValue);
        if (height !== undefined) setCoverHeight(store, id, height);
        if (position !== undefined) setCoverPosition(store, id, position);
        if (Object.keys(format).length > 0) setPageFormat(store, id, format);
        return `Updated “${ctx.title(id)}”`;
      },
    },
    {
      group: "pages", write: true, aliases: ID,
      spec: {
        name: "move_page",
        description:
          "Move one page (`id`) or several (`ids`): under another page (`parent_id`), to the top level of a section (`section`: private, or a teamspace name or id), " +
          "or right before/after another page (`before` / `after`, in that page's place). Without a destination: to the end of Private. Sub-pages move along.",
        inputSchema: obj({ id: pageID, ids: { type: "array", maxItems: 200, items: { type: "string" }, description: "Several page ids, kept in this order" }, parent_id: pageID, section: str("private, or a teamspace name or id"), before: pageID, after: pageID }),
      },
      run: (a) => {
        const ids = [...(optStr(a, "id") !== undefined ? [optStr(a, "id")!] : []), ...(Array.isArray(a.ids) ? (a.ids as string[]) : [])];
        if (ids.length === 0) throw new ToolError("Give `id` or `ids`.");
        for (const id of ids) ctx.page(id, true);
        const parent = optStr(a, "parent_id"), section = optStr(a, "section"), before = optStr(a, "before"), after = optStr(a, "after");
        if (before !== undefined && after !== undefined) throw new ToolError("Give before or after, not both.");
        if (parent !== undefined && section !== undefined) throw new ToolError("Give parent_id or section, not both.");
        let dest: PageDestination = parent !== undefined ? { kind: "page", id: ctx.page(parent, true).id } : { kind: "top", section: section !== undefined ? sectionFrom(store, section) : PRIVATE };
        let position: InsertPosition = { kind: "end" };
        const anchor = before ?? after;
        if (anchor !== undefined) {
          const sib = ctx.page(anchor);
          if (ids.includes(anchor)) throw new ToolError("A page can't be placed before or after itself.");
          if (sib.parent.startsWith("d:")) throw new ToolError("Database rows have no fixed order; sort the view instead.");
          const sibDest: PageDestination = sib.parent.startsWith("b:") ? { kind: "page", id: sib.parent.slice(2) } : { kind: "top", section: sectionOf(store, sib) };
          if (parent !== undefined && (sibDest.kind !== "page" || sibDest.id !== parent)) throw new ToolError("The page given as before/after is not a sub-page of parent_id.");
          if (section !== undefined && (sibDest.kind !== "top" || sectionName(store, sibDest.section) !== sectionName(store, sectionFrom(store, section)))) throw new ToolError("The page given as before/after is not at the top level of that section.");
          dest = sibDest;
          position = { kind: before !== undefined ? "before" : "after", id: anchor };
        }
        if (!movePages(store, ids, dest, position)) throw new ToolError(`Couldn't move ${ids.length === 1 ? `“${ctx.title(ids[0]!)}”` : "the pages"} there (into itself or one of its sub-pages?).`);
        const where = dest.kind === "page" ? `under “${ctx.title(dest.id)}”` : `to ${dest.section.kind === "private" && anchor === undefined && section === undefined ? "the top level" : sectionName(store, dest.section)}`;
        return `Moved ${ids.length === 1 ? `“${ctx.title(ids[0]!)}”` : `${ids.length} pages`} ${where}${anchor !== undefined ? ` ${before !== undefined ? "before" : "after"} “${ctx.title(anchor)}”` : ""}.`;
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
