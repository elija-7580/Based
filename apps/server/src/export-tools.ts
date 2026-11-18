// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Export für Agenten (Matrix V3, V4): eine Seite oder der ganze Workspace als Datei – dieselben Exporter wie in der
// App (packages/core/interop). Die Datei landet im Dateispeicher (Antwort: Datei-Adresse) und, wenn der Client auf
// diesem Rechner läuft (stdio), auf Wunsch unter einem Pfad. Kleine Textformate kommen zusätzlich direkt zurück.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  exportDocx, exportOPML, exportPageHTML, exportPageJSON, exportWorkspaceHTML, planWorkspaceExport, topLevelPages,
  writeArchivePackage, writeExportZip, type AssetRef,
} from "@based/core";
import { ToolError, type ToolCtx, type ToolDef } from "@based/brain";
import type { AssetStore } from "./assets.js";
import { storeBytes } from "./board-files.js";

const PAGE_FORMATS = ["markdown", "html", "docx", "json", "opml"] as const;
const WORKSPACE_FORMATS = ["markdown", "html", "archive"] as const;
const INLINE_MAX = 24_000;
const enc = new TextEncoder();
const str = (description?: string) => ({ type: "string", ...(description ? { description } : {}) }) as const;

export function exportTools(assets: AssetStore, local: boolean): (ctx: ToolCtx) => ToolDef[] {
  const read = (ref: AssetRef): Uint8Array | undefined => {
    const at = assets.locate(ref.id);
    return at ? readFileSync(at.path) : undefined;
  };
  /** Datei ablegen: Dateispeicher, und lokal auf Wunsch unter `path` (Ordner oder Dateiname; nichts wird überschrieben). */
  const deliver = async (name: string, mime: string, data: Uint8Array, path: string | undefined, summary: string): Promise<string> => {
    const lines = [summary];
    if (path !== undefined) {
      if (!local) throw new ToolError("path only works when the client runs on the same computer (stdio). Leave it out to get a file ref.");
      if (!isAbsolute(path)) throw new ToolError("path must be absolute.");
      let target = resolve(path);
      if (existsSync(target) && statSync(target).isDirectory()) target = join(target, name);
      if (existsSync(target)) throw new ToolError(`${target} already exists; nothing was written.`);
      if (!existsSync(dirname(target))) throw new ToolError(`The folder ${dirname(target)} doesn't exist.`);
      writeFileSync(target, data, { flag: "wx" });
      lines.push(`Saved to ${target} (${Math.max(1, Math.round(data.length / 1024))} KB).`);
    } else if (data.length <= assets.maxBytes) {
      const ref = await storeBytes(assets, Buffer.from(data), name, mime);
      lines.push(`File “${name}” (${Math.max(1, Math.round(data.length / 1024))} KB): ${ref}`);
    } else lines.push(local ? "Too large for the file storage; give a path to save it on this computer." : "Too large for the file storage.");
    const text = /^text\/|json|opml/.test(mime) && data.length <= INLINE_MAX ? new TextDecoder().decode(data) : undefined;
    return text !== undefined ? `${lines.join("\n")}\n\n${text}` : lines.join("\n");
  };
  const missing = (n: number) => (n > 0 ? ` ${n} file${n === 1 ? " is" : "s are"} missing on this server and left out.` : "");

  return (ctx) => [
    {
      group: "files", write: false, wait: true,
      spec: {
        name: "export_page",
        description: `Export a page as a file: ${PAGE_FORMATS.join(", ")} (a database as CSV with markdown). Returns a file ref${local ? ", or saves to `path` on this computer" : ""}; small text formats also come back inline. subpages: include subpages (HTML becomes a ZIP).`,
        inputSchema: {
          type: "object", additionalProperties: false, required: ["id"],
          properties: { id: str("Page id"), format: { type: "string", enum: [...PAGE_FORMATS] }, subpages: { type: "boolean" }, ...(local ? { path: str("Absolute folder or file path") } : {}) },
        },
      },
      run: async (a) => {
        const { store } = ctx;
        const page = ctx.page(String(a.id));
        const format = (typeof a.format === "string" ? a.format : "markdown") as (typeof PAGE_FORMATS)[number];
        const path = typeof a.path === "string" ? a.path : undefined;
        const title = ctx.title(page.id);
        if (format === "json") { const r = exportPageJSON(store, page.id); return deliver(r.name, "application/json", enc.encode(r.json), path, `Exported “${title}” as JSON.`); }
        if (format === "opml") { const r = exportOPML(store, page.id); return deliver(r.name, "text/x-opml", enc.encode(r.xml), path, `Exported “${title}” as OPML.`); }
        if (format === "docx") {
          const r = exportDocx(store, page.id, { assetBytes: read });
          return deliver(r.name, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", r.data, path, `Exported “${title}” as Word.`);
        }
        if (format === "html") {
          const r = exportPageHTML(store, page.id, { subpages: a.subpages === true, readAsset: read });
          return deliver(r.name, r.kind === "html" ? "text/html" : "application/zip", r.data, path, `Exported ${r.pages} page${r.pages === 1 ? "" : "s"} as HTML${r.assets ? ` with ${r.assets} file${r.assets === 1 ? "" : "s"}` : ""}.${missing(r.failures.length)}`);
        }
        if (a.subpages === true) {
          const plan = planWorkspaceExport(store, [page], "markdown", {});
          const { zip, report } = writeExportZip(plan, read);
          return deliver(`${title.replace(/[\\/:*?"<>|]/g, "-") || "Page"}.zip`, "application/zip", zip, path, `Exported ${report.pages} page${report.pages === 1 ? "" : "s"} as Markdown${report.assets ? ` with ${report.assets} file${report.assets === 1 ? "" : "s"}` : ""}.${missing(report.failures.length)}`);
        }
        const file = planWorkspaceExport(store, [page], "markdown", {}).files[0];
        if (!file) throw new ToolError("Nothing to export.");
        const name = file.path.split("/").at(-1)!;
        return deliver(name, name.endsWith(".csv") ? "text/csv" : "text/markdown", enc.encode(file.contents), path, `Exported “${title}” as ${name.endsWith(".csv") ? "CSV" : "Markdown"}.`);
      },
    },
    {
      group: "files", write: false, wait: true,
      spec: {
        name: "export_workspace",
        description: `Export the whole workspace as one ZIP: ${WORKSPACE_FORMATS.join(", ")} (archive = lossless Based archive with all files). Returns a file ref${local ? ", or saves to `path` on this computer" : ""}.`,
        inputSchema: {
          type: "object", additionalProperties: false, required: [],
          properties: { format: { type: "string", enum: [...WORKSPACE_FORMATS] }, ...(local ? { path: str("Absolute folder or file path") } : {}) },
        },
      },
      run: async (a) => {
        const { store } = ctx;
        const format = (typeof a.format === "string" ? a.format : "markdown") as (typeof WORKSPACE_FORMATS)[number];
        const path = typeof a.path === "string" ? a.path : undefined;
        const day = new Date().toISOString().slice(0, 10);
        const base = (store.workspace.name.trim() || "Workspace").replace(/[\\/:*?"<>|]/g, "-");
        if (format === "archive") {
          const r = writeArchivePackage(store, read);
          return deliver(`${base} ${day}.based.zip`, "application/zip", r.zip, path, `Archived ${r.records} records${r.assets ? ` and ${r.assets} file${r.assets === 1 ? "" : "s"}` : ""}.${missing(r.missing.length)}`);
        }
        if (format === "html") {
          const r = exportWorkspaceHTML(store, { readAsset: read });
          return deliver(`Based Export HTML ${day}.zip`, "application/zip", r.data, path, `Exported ${r.pages} page${r.pages === 1 ? "" : "s"} as HTML.${missing(r.failures.length)}`);
        }
        const plan = planWorkspaceExport(store, topLevelPages(store), "markdown", {});
        const { zip, report } = writeExportZip(plan, read);
        return deliver(`Based Export Markdown ${day}.zip`, "application/zip", zip, path, `Exported ${report.pages} page${report.pages === 1 ? "" : "s"}${report.assets ? ` and ${report.assets} file${report.assets === 1 ? "" : "s"}` : ""} as Markdown.${missing(report.failures.length)}`);
      },
    },
  ];
}
