// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-93 / BSD-508: Whiteboards als Text – wenige Token; die Anordnung rechnet Based (core whiteboard/agent.ts).
// Elija 18.11.: Agenten können auf dem Board alles, was ein Mensch kann (Farben, Stellen, Zeichnen, Bilder, Dateien).
import {
  boardBackground, boardFileParts, boardHandles, boardObjectFromBlock, boardObjectsOf, boardObjectToBlock, boardOutline, insertBoardPage, isBoardPage, isPageLike, keyOf,
  makeRecordID, planBoardScript, titleOf, workspaceFiles, type Block,
} from "@based/core";
import { limitSchema, needStr, obj, offsetSchema, optNum, optStr, pageID, paged, S, type ToolDef } from "./base.js";
import type { ToolCtx } from "./context.js";

/** Das Nötigste; die ganze Grammatik steht in `based_guide` (Thema boards). */
const BOARD_SCRIPT_SHORT = [
  "One statement per line. Create: note a: text | box a: text | oval a: text | diamond a: text | text a: text | page a: <page id> | image a: <file ref> | file a: <file ref> | ink a: <SVG path>",
  "Connect: a -> b: optional label. Group: frame f: Title { a b c }. Change: set <handle>: text | set <handle> {attrs} | del <handle> | copy <handle> as c | background dots|lines|grid|plain",
  "Attributes go last in braces: {color=green fill=blue at=120,40 size=200x100}. Text is Markdown. Colours, ink, PDFs, copying between boards: based_guide topic `boards`.",
].join("\n");

export function boardTools(ctx: ToolCtx): ToolDef[] {
  const { store } = ctx;
  return [
    {
      group: "boards", write: false, aliases: { page_id: "id" },
      spec: { name: "read_board", description: "A whiteboard as compact text: one line per object (short handle, kind, text, @x,y WxH, {style}), connectors as `a -> b: label [handle]`. Use the handles in draw_board.", inputSchema: obj({ id: pageID }, ["id"]) },
      run: (a) => {
        const id = needStr(a, "id");
        ctx.page(id, true);
        if (!isBoardPage(store.blocks.get(id))) throw new Error("That page is not a whiteboard. Use read_page.");
        return boardOutline(boardObjectsOf(store, id), (pid) => titleOf(store, pid) || undefined, boardBackground(store, id));
      },
    },
    {
      group: "files", write: false,
      spec: {
        name: "list_files",
        description: "Files already in the workspace (images, PDFs, attachments) with their ref: ref, name, type, size, image size. Use the ref in draw_board (image a: <ref> / file a: <ref>) and edit_blocks. Filter by name with query.",
        inputSchema: obj({ query: S, limit: limitSchema, offset: offsetSchema }),
      },
      run: (a) => {
        const q = optStr(a, "query")?.toLowerCase();
        const files = [...workspaceFiles(store).values()].map((f) => ctx.fileInfo(f.ref, f)!).filter((f) => !q || f.name.toLowerCase().includes(q));
        files.sort((x, y) => x.name.localeCompare(y.name));
        const lines = files.map((f) => {
          const parts = boardFileParts(f);
          const what = f.pages?.length ? `PDF, ${f.pages.length} page${f.pages.length === 1 ? "" : "s"}` : f.width && f.height ? `${f.width}x${f.height}` : parts[0]!.kind === "image" ? "image" : (f.mime || "file");
          return `${f.ref} "${f.name}" ${what}${f.size ? ` ${Math.max(1, Math.round(f.size / 1024))} KB` : ""}`;
        });
        return lines.length ? paged(lines, Math.min(500, Math.max(1, optNum(a, "limit", 50))), optNum(a, "offset", 0)) : (q ? `No file matches “${q}”.` : "No files in this workspace yet. Use upload_file.");
      },
    },
    {
      group: "boards", write: true, aliases: { page_id: "id", parent_id: "parent" },
      spec: {
        name: "draw_board",
        description: ["Add to or change a whiteboard with a short script. Based lays new objects out beside what is there unless they have at=. Omit `id` to create a new board (`title`, `parent` optional).", BOARD_SCRIPT_SHORT].join("\n"),
        inputSchema: obj({ id: pageID, script: { type: "string", minLength: 1 }, title: S, parent: pageID }, ["script"]),
      },
      run: (a) => {
        const given = optStr(a, "id");
        const parent = optStr(a, "parent");
        if (given !== undefined) { ctx.writable(given); if (!isBoardPage(store.blocks.get(given))) throw new Error("That page is not a whiteboard."); }
        else if (parent !== undefined) ctx.page(parent);
        const existing = given ? boardObjectsOf(store, given) : [];
        let known: ReturnType<typeof workspaceFiles> | undefined;
        const files = (ref: string) => ctx.fileInfo(ref, (known ??= workspaceFiles(store)).get(ref));
        const boardObjects = (id: string) => {
          try { ctx.page(id, true); } catch { return undefined; }
          return isBoardPage(store.blocks.get(id)) ? boardObjectsOf(store, id) : undefined;
        };
        const plan = planBoardScript(needStr(a, "script"), existing, () => makeRecordID(), { files, boardObjects });
        // Seitenkarten: nur vorhandene Seiten, mit ihrem Titel als Text (für Suche und Vorschau).
        plan.add = plan.add.filter((o) => {
          if (o.kind !== "page") return true;
          const b = o.ref ? store.blocks.get(o.ref) : undefined;
          if (!isPageLike(b) || b?.trashedAt !== undefined) { plan.errors.push(`page ${o.ref ?? ""} — no such page`); return false; }
          o.text = titleOf(store, o.ref!) || "Untitled";
          return true;
        });
        const kept = new Set(plan.add.map((o) => o.id));
        plan.add = plan.add.filter((o) => o.kind !== "connector" || ((kept.has(o.from.id) || existing.some((e) => e.id === o.from.id)) && (kept.has(o.to.id) || existing.some((e) => e.id === o.to.id))));
        const page = store.transact("Agent: draw on board", (tx) => {
          const pid = given ?? insertBoardPage(store, tx, { ...(parent ? { parent } : {}), title: optStr(a, "title") ?? "Untitled board" });
          const now = store.now();
          const all = new Map([...existing, ...plan.add].map((o) => [o.id, o]));
          for (const o of plan.add) tx.put({ kind: "block", data: boardObjectToBlock(o, pid, now, undefined, all) });
          for (const [id, fields] of plan.patch) {
            const block = store.blocks.get(id);
            const cur = block ? boardObjectFromBlock(block) : undefined;
            if (block && cur) tx.put({ kind: "block", data: boardObjectToBlock({ ...cur, ...fields } as typeof cur, pid, now, block) });
          }
          for (const id of plan.remove) if (store.blocks.get(id)) tx.remove(keyOf("block", id));
          if (plan.background) {
            const bg = plan.background;
            tx.update(pid, (b) => {
              const props = (b.props ?? {}) as Record<string, unknown>;
              b.props = { ...props, board: { ...((props.board as Record<string, unknown> | undefined) ?? {}), bg } } as Block["props"];
            });
          }
          return pid;
        });
        const handles = boardHandles(boardObjectsOf(store, page));
        const names = [...plan.names].filter(([, id]) => handles.has(id)).map(([n, id]) => `${n}=${handles.get(id)!}`).join(" ");
        return [
          `${given ? "Updated" : "Created"} board (id: ${page}): ${plan.add.length} added, ${plan.patch.size} changed, ${plan.remove.length} removed${plan.background ? `, background ${plan.background}` : ""}.`,
          ...(names ? [`Handles: ${names}`] : []),
          ...(plan.errors.length ? ["Skipped:", ...plan.errors.map((e) => `- ${e}`)] : []),
        ].join("\n");
      },
    },
  ];
}
