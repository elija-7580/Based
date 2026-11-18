// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Werkzeuge, die nur der Server bauen kann, weil sie Netz, Dateisystem und den Dateispeicher brauchen. Sie stehen in
// derselben Werkzeug-Schicht wie alle anderen (`WorkspaceToolsOptions.extra`), mit den Schutzregeln aus board-files.ts.
import { ToolError, type ToolCtx, type ToolDef } from "@based/brain";
import { workspaceFiles, type JSONValue, type WorkspaceStore } from "@based/core";
import type { AssetStore } from "./assets.js";
import { assetFileInfo, fetchRemote, prepareFiles, readLocalFile, storeBytes, UploadError } from "./board-files.js";

const str = (description?: string): JSONValue => (description ? { type: "string", description } : { type: "string" });

/**
 * Vor `draw_board`, `list_files` und `edit_blocks`: die genannten Dateien genau vermessen (PDF-Seiten mit pdf.js, das
 * ist asynchron – die Werkzeuge selbst sind es nicht).
 */
export function prepareForTool(assets: AssetStore, store: WorkspaceStore): (name: string, input: JSONValue) => Promise<void> {
  return async (name, input) => {
    const a = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
    if ((name === "draw_board" || name === "edit_blocks") && typeof a.script === "string") await prepareFiles(assets, a.script.match(/[0-9a-f]{64}/g) ?? []);
    else if (name === "list_files") {
      const q = typeof a.query === "string" ? a.query.toLowerCase() : undefined;
      await prepareFiles(assets, [...workspaceFiles(store).values()].filter((f) => !q || f.name.toLowerCase().includes(q)).map((f) => f.ref));
    }
  };
}

/** `local`: der Client läuft auf diesem Rechner (stdio) – `upload_file` darf lokale Pfade lesen. */
export function fileTools(assets: AssetStore, local: boolean): (ctx: ToolCtx) => ToolDef[] {
  return (ctx) => [
    {
      group: "files", write: true, wait: true,
      spec: {
        name: "upload_file",
        description: [
          "Put a file (image, PDF, any document) into the workspace's file storage and get its ref for draw_board. Give exactly one of",
          local ? "`path` (a file on this computer), `url` (http/https; redirects are followed) or `data` (base64)." : "`url` (http/https; redirects are followed) or `data` (base64).",
          "With `board` the file is placed on that whiteboard right away (`at` = x,y top-left; a PDF becomes one object per page).",
        ].join(" "),
        inputSchema: {
          type: "object", additionalProperties: false, required: [],
          properties: {
            name: str("File name with extension (decides how it shows); default: from path or URL"),
            ...(local ? { path: str() } : {}),
            url: str(), data: str("Base64 of the bytes"), mime: str(),
            board: str("Whiteboard page id to place the file on"), at: str("x,y on the board"),
          },
        },
      },
      run: async (a, { actor }) => {
        const s = (k: string) => (typeof a[k] === "string" && a[k] !== "" ? (a[k] as string) : undefined);
        try {
          const path = local ? s("path") : undefined, url = s("url"), data = s("data");
          if ([path, url, data].filter((v) => v !== undefined).length !== 1) throw new ToolError(local ? "Give exactly one of path, url or data." : "Give exactly one of url or data.");
          let bytes: Buffer, name = s("name")?.trim() || "", mime = s("mime");
          if (path !== undefined) { const f = readLocalFile(path, assets.maxBytes); bytes = f.bytes; name ||= f.name; }
          else if (url) { const f = await fetchRemote(url, assets.maxBytes); bytes = f.bytes; name ||= f.name; mime ??= f.mime; }
          else {
            if (!/^[A-Za-z0-9+/=\s_-]+$/.test(data!)) throw new ToolError("data is not base64.");
            bytes = Buffer.from(data!, "base64");
            name ||= "file";
          }
          const ref = await storeBytes(assets, bytes, name, mime);
          await prepareFiles(assets, [ref]);
          const info = assetFileInfo(assets, ref);
          const what = info?.pages?.length ? `PDF, ${info.pages.length} page${info.pages.length === 1 ? "" : "s"}` : info?.width ? `${info.width}x${info.height}` : (info?.mime ?? mime ?? "file");
          const lines = [`Stored “${name}” (${what}, ${Math.max(1, Math.round(bytes.length / 1024))} KB): ${ref}`];
          const board = s("board");
          if (board) {
            const kind = info?.mime?.startsWith("image/") && info.mime !== "image/svg+xml" ? "image" : "file";
            const at = s("at")?.replace(/\s/g, "");
            const r = ctx.callSync("draw_board", { id: board, script: `${kind} f: ${ref}${at && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(at) ? ` {at=${at}}` : ""}` }, actor);
            lines.push(r.text);
            if (r.isError) throw new ToolError(lines.join("\n"));
          }
          return lines.join("\n");
        } catch (e) {
          if (e instanceof UploadError) throw new ToolError(e.message);
          throw e;
        }
      },
    },
  ];
}
