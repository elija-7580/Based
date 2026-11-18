// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Seiten-Editor für Agenten (Agent-Parität 2/7): einzelne Blöcke lesen und ändern – verschieben, Spalten, Farben,
// Turn into, Bilder und Dateien einfügen, Tabellen. Die Logik liegt im Kern (`blockOutline`, `runBlockScript`);
// hier stehen Name, Beschreibung und die Antwort.
import { BLOCK_SCRIPT_HELP, blockHandles, blockOutline, isBoardPage, runBlockScript, workspaceFiles } from "@based/core";
import { limitSchema, needStr, obj, offsetSchema, optNum, pageID, PAGE_URI, ToolError, type ToolDef } from "./base.js";
import type { ToolCtx } from "./context.js";

export function blockTools(ctx: ToolCtx): ToolDef[] {
  const { store } = ctx;
  const editable = (id: string) => {
    const b = ctx.page(id);
    if (isBoardPage(b)) throw new ToolError("That page is a whiteboard. Use read_board and draw_board.");
    return b;
  };
  return [
    {
      group: "blocks", write: false, aliases: { page_id: "id" },
      spec: {
        name: "read_blocks",
        description:
          "A page as an outline: one line per block with a short handle, kind, text and {style}; indentation shows nesting (list items, toggles, columns). " +
          "Use the handles in edit_blocks. Long texts are cut (… (+N)); read_page has the full Markdown.",
        inputSchema: obj({ id: pageID, limit: { ...limitSchema, description: "Max lines (default 200)" }, offset: offsetSchema }, ["id"]),
      },
      run: (a) => {
        const id = needStr(a, "id");
        editable(id);
        return blockOutline(store, id, { offset: optNum(a, "offset", 0), limit: Math.max(1, optNum(a, "limit", 200)), pageLink: (pid) => ({ title: ctx.title(pid), url: PAGE_URI + pid }) });
      },
    },
    {
      group: "blocks", write: true, aliases: { page_id: "id" },
      spec: {
        name: "edit_blocks",
        description: [
          "Change a page block by block with a short script: insert at a place, edit, move, put side by side in columns, colour, turn into another kind, add images and files, edit tables. Read the handles with read_blocks first.",
          BLOCK_SCRIPT_HELP,
          "Example: h2 s: Summary {after=1a2b}\\ncallout: **Ship on Friday** {bg=blue icon=🚀}\\nmove 3c4d {right=s}\\nset 5e6f {type=todo checked}",
        ].join("\n"),
        inputSchema: obj({ id: pageID, script: { type: "string", minLength: 1 } }, ["id", "script"]),
      },
      run: (a) => {
        const id = needStr(a, "id");
        editable(id);
        ctx.writable(id);
        let known: ReturnType<typeof workspaceFiles> | undefined;
        const r = runBlockScript(store, id, needStr(a, "script"), {
          importer: ctx.importer(),
          files: (ref) => ctx.fileInfo(ref, (known ??= workspaceFiles(store)).get(ref)),
        });
        const did = r.added + r.changed + r.moved + r.removed;
        if (did === 0 && r.errors.length > 0) throw new ToolError(["Nothing was changed.", ...r.errors.map((e) => `- ${e}`)].join("\n"));
        const handles = blockHandles(store, id);
        const names = [...r.names].map(([n, bid]) => {
          const b = store.blocks.get(bid);
          const db = r.databases.get(bid);
          return `${n}=${handles.get(bid) ?? bid}${b && (b.type === "page" || b.type === "databasePage") ? ` (page id: ${bid})` : ""}${db ? ` (database id: ${db})` : ""}`;
        });
        return [
          `Edited “${ctx.title(id)}”: ${r.added} added, ${r.changed} changed, ${r.moved} moved, ${r.removed} removed.`,
          ...(names.length ? [`Handles: ${names.join(" ")}`] : []),
          ...(r.errors.length ? ["Skipped:", ...r.errors.map((e) => `- ${e}`)] : []),
        ].join("\n");
      },
    },
  ];
}
