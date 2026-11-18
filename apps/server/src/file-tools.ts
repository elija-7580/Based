// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Werkzeuge, die nur der Server bauen kann, weil sie Netz, Dateisystem und den Dateispeicher brauchen. Sie stehen in
// derselben Werkzeug-Schicht wie alle anderen (`WorkspaceToolsOptions.extra`), mit den Schutzregeln aus board-files.ts.
import { ToolError, type ToolCtx, type ToolDef } from "@based/brain";
import { LINK_PREVIEW_MAX_BYTES, parseLinkPreview, workspaceFiles, type BookmarkMeta, type JSONValue, type WorkspaceStore } from "@based/core";
import type { AssetStore } from "./assets.js";
import { assetFileInfo, fetchRemote, prepareFiles, readLocalFile, storeBytes, UploadError } from "./board-files.js";

const str = (description?: string): JSONValue => (description ? { type: "string", description } : { type: "string" });

/**
 * Vor `draw_board`, `list_files` und `edit_blocks`: die genannten Dateien genau vermessen (PDF-Seiten mit pdf.js, das
 * ist asynchron – die Werkzeuge selbst sind es nicht).
 */
export function prepareForTool(assets: AssetStore, store: WorkspaceStore, previews?: LinkPreviews): (name: string, input: JSONValue) => Promise<void> {
  return async (name, input) => {
    const a = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
    if (name === "edit_blocks" && typeof a.script === "string" && previews) await previews.prepare(a.script);
    if ((name === "draw_board" || name === "edit_blocks") && typeof a.script === "string") await prepareFiles(assets, a.script.match(/[0-9a-f]{64}/g) ?? []);
    else if (name === "list_files") {
      const q = typeof a.query === "string" ? a.query.toLowerCase() : undefined;
      await prepareFiles(assets, [...workspaceFiles(store).values()].filter((f) => !q || f.name.toLowerCase().includes(q)).map((f) => f.ref));
    }
  };
}

/**
 * Link-Vorschauen für Bookmarks, die ein Agent anlegt (Titel, Beschreibung, Bild aus dem Kopf der Seite). Geholt wird
 * mit denselben Schutzregeln wie Dateien (`fetchRemote`: nie ins eigene Netz, Weiterleitungen einzeln geprüft, Zeit
 * begrenzt) und nur der Anfang der Seite. Scheitert es, entsteht das Bookmark ohne Karte – nie ein Fehler.
 */
export class LinkPreviews {
  private readonly known = new Map<string, BookmarkMeta>();
  constructor(private readonly fetchPage: (url: string) => Promise<{ bytes: Buffer; mime?: string }> = (url) => fetchRemote(url, LINK_PREVIEW_MAX_BYTES, 8_000, undefined, true)) {}

  get = (url: string): BookmarkMeta | undefined => this.known.get(url);

  /** Vorschauen für die Bookmark-Zeilen eines Skripts holen (höchstens fünf je Aufruf, nebeneinander). */
  async prepare(script: string): Promise<void> {
    const urls = new Set<string>();
    for (const line of script.split(/\r?\n/)) {
      const m = /^\s*(?:bookmark(?:\s+[A-Za-z_][\w-]*)?|set\s+\S+)\s*:\s*(https?:\/\/\S+)/.exec(line);
      if (m && !this.known.has(m[1]!)) urls.add(m[1]!);
      if (urls.size >= 5) break;
    }
    await Promise.all([...urls].map(async (url) => {
      try {
        const page = await this.fetchPage(url);
        if (page.mime && !/html|xml/i.test(page.mime)) return;
        const meta = parseLinkPreview(page.bytes.toString("utf8"), url);
        if (Object.keys(meta).length === 0) return;
        if (this.known.size >= 200) this.known.delete(this.known.keys().next().value!);
        this.known.set(url, meta);
      } catch { /* ohne Vorschau */ }
    }));
  }
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
          "With `page` it is put into that page as an image, PDF, video, audio or file block: at the end, or right `after` a block (handle from read_blocks); `caption` optional.",
        ].join(" "),
        inputSchema: {
          type: "object", additionalProperties: false, required: [],
          properties: {
            name: str("File name with extension (decides how it shows); default: from path or URL"),
            ...(local ? { path: str() } : {}),
            url: str(), data: str("Base64 of the bytes"), mime: str(),
            board: str("Whiteboard page id to place the file on"), at: str("x,y on the board"),
            page: str("Page id to put the file into"), after: str("Block handle to put it after (with page)"), caption: str("Caption (with page)"),
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
          if (board && s("page")) throw new ToolError("Give board or page, not both.");
          if (board) {
            const kind = info?.mime?.startsWith("image/") && info.mime !== "image/svg+xml" ? "image" : "file";
            const at = s("at")?.replace(/\s/g, "");
            const r = ctx.callSync("draw_board", { id: board, script: `${kind} f: ${ref}${at && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(at) ? ` {at=${at}}` : ""}` }, actor);
            lines.push(r.text);
            if (r.isError) throw new ToolError(lines.join("\n"));
          }
          const page = s("page");
          if (page) {
            const after = s("after"), caption = s("caption");
            const attrs = [after ? `after=${after}` : "", caption ? `caption="${caption.replace(/["\\]/g, "\\$&")}"` : ""].filter(Boolean).join(" ");
            const r = ctx.callSync("edit_blocks", { id: page, script: `file f: ${ref}${attrs ? ` {${attrs}}` : ""}` }, actor);
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
