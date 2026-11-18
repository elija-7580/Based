// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Import für Agenten (Matrix V6): dieselben Importer wie in der App (packages/core/src/interop/prepare-files.ts) –
// Notion-Export (ZIP/HTML/CSV), Markdown, HTML, Word, Obsidian, Evernote, OPML, Based-Archiv. Quellen: Dateien aus dem
// Dateispeicher (`upload_file`), Text direkt, und über stdio ein Pfad (Datei oder Ordner) auf diesem Rechner.
// Der Reimport-Schutz des Kerns gilt wie in der App (Notion-Export, Archiv); einfache Dateien haben keine Kennung
// und werden bei jedem Import neue Seiten.
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  commitImportPayload, fetchTransport, LimitedAssetSink, MemoryAssetSink, NotionWorkspaceImport, parseNotionTargets, preparedImportToWire, prepareFiles, remapAssetRefs,
  workspaceFiles, type ImportFile, type ImportPayload,
} from "@based/core";
import { PAGE_URI, ToolError, type ToolCtx, type ToolDef } from "@based/brain";
import type { AssetStore } from "./assets.js";
import { assetFileInfo, storeBytes } from "./board-files.js";

const MAX_FILES = 20_000;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const str = (description?: string) => ({ type: "string", ...(description ? { description } : {}) }) as const;

function readRange(path: string, offset: number, length: number): Uint8Array {
  const buf = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try { return buf.subarray(0, readSync(fd, buf, 0, length, offset)); } finally { closeSync(fd); }
}

/** Datei oder Ordner (rekursiv) von der Platte; Pfade relativ zum gewählten Eintrag, wie beim Ablegen in der App. */
function readLocal(path: string): ImportFile[] {
  if (!isAbsolute(path)) throw new ToolError("path must be absolute.");
  const root = resolve(path);
  let st;
  try { st = statSync(root); } catch { throw new ToolError(`No such file or folder: ${root}`); }
  if (st.isFile()) return [{ path: basename(root), data: readFileSync(root) }];
  if (!st.isDirectory()) throw new ToolError(`${root} is neither a file nor a folder.`);
  const out: ImportFile[] = [];
  let bytes = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue; // .git, .obsidian, .DS_Store
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const size = statSync(full).size;
        bytes += size;
        if (out.length >= MAX_FILES || bytes > MAX_TOTAL_BYTES) throw new ToolError(`That folder is too large to import in one go (more than ${MAX_FILES} files or 2 GB). Import a subfolder.`);
        // erst beim Lesen laden: ein großer Export liegt nie ganz im Speicher
        out.push({ path: `${basename(root)}/${relative(root, full).split("\\").join("/")}`, source: { size, read: (offset: number, length: number) => readRange(full, offset, length) } });
      }
    }
  };
  walk(root);
  if (out.length === 0) throw new ToolError(`${root} is empty.`);
  return out;
}

/** Vorbereiteten Import schreiben: Dateien in den Speicher, Verweise auf den SHA-256, Records, Bericht als Text. */
async function finishImport(ctx: ToolCtx, assets: AssetStore, payload: ImportPayload, parent: string | undefined): Promise<string> {
  const { store } = ctx;
        // Bilder und Anhänge in den Dateispeicher (inhaltsadressiert), Verweise auf den SHA-256 umschreiben.
  const map = new Map<string, string>();
  let failed = 0;
  for (const f of payload.files ?? []) {
    try { map.set(f.id, (await storeBytes(assets, Buffer.from(f.data), f.name, f.mime)).slice("based-asset:".length)); } catch { failed += 1; }
  }
  const rest: ImportPayload = { ...payload, notion: remapAssetRefs(payload.notion, map), archives: payload.archives.map((x) => ({ ...x, read: remapAssetRefs(x.read, map) })) };
  delete rest.files;
  if (store.isReadOnly) throw new ToolError("The workspace is read-only right now. Nothing was imported.");
  const s = commitImportPayload(store, rest, parent ? "b:" + parent : "w");
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  const parts = [s.pages ? n(s.pages, "page") : "", s.databases ? n(s.databases, "database") : "", s.rows ? n(s.rows, "row") : "", s.assets ? n(s.assets, "file") : "", s.archiveRecords ? `${s.archiveRecords} archive records` : ""].filter(Boolean);
  const lines = [parts.length ? `Imported ${parts.join(", ")}.` : "Nothing new was imported."];
  if (s.keptLocalChanges || s.keptLocalAdditions) lines.push(`Kept what was changed in Based since the last import (${s.keptLocalChanges} changed, ${s.keptLocalAdditions} added blocks).`);
  for (const id of s.rootIDs.slice(0, 30)) lines.push(`- ${ctx.title(id)} (id: ${id}) ${PAGE_URI}${id}`);
  if (s.rootIDs.length > 30) lines.push(`… ${s.rootIDs.length - 30} more`);
  if (failed) lines.push(`${n(failed, "attached file")} couldn't be stored and will show as missing.`);
  const warnings = [...new Set(s.warnings)];
  if (warnings.length) lines.push("Notes:", ...warnings.slice(0, 12).map((w) => `- ${w}`), ...(warnings.length > 12 ? [`… ${warnings.length - 12} more`] : []));
  return lines.join("\n");
}

/** Stand des Notion-Imports dieses Servers (einer zur Zeit). */
interface NotionJob { state: "running" | "done" | "failed" | "cancelled"; startedAt: number; fraction: number; message: string; result?: string; cancelled?: boolean }
const notionJobs = new WeakMap<object, NotionJob>();

export function importTools(assets: AssetStore, local: boolean): (ctx: ToolCtx) => ToolDef[] {
  return (ctx) => [
    {
      group: "files", write: true, wait: true,
      spec: {
        name: "import_files",
        description: [
          "Import files into the workspace as pages and databases, with the importers of the app: Notion export (ZIP, HTML, CSV), Markdown, HTML, Word (.docx), Obsidian vault, Evernote (.enex), OPML, CSV/JSON Lines (become databases), Based archive (.based.zip, .jsonl).",
          `Sources: \`refs\` (files stored with upload_file), \`text\` with \`name\` (e.g. notes.md)${local ? ", or `path` (a file or folder on this computer)" : ""}.`,
          "`parent`: page to import under (default: top level). A Notion export or Based archive imported again updates what is there; other files become new pages each time. Returns the new top pages.",
        ].join(" "),
        inputSchema: {
          type: "object", additionalProperties: false, required: [],
          properties: {
            refs: { type: "array", items: str(), maxItems: 50, description: "File refs (based-asset:…)" },
            text: str("Content of one text file"), name: str("File name for `text`, with extension"),
            ...(local ? { path: str("Absolute path of a file or folder") } : {}),
            parent: str("Page id to import under"),
          },
        },
      },
      run: async (a) => {
        const { store } = ctx;
        const parent = typeof a.parent === "string" ? ctx.writable(a.parent).id : undefined;
        const files: ImportFile[] = [];
        if (typeof a.path === "string") {
          if (!local) throw new ToolError("path only works when the client runs on the same computer (stdio). Use upload_file and refs.");
          files.push(...readLocal(a.path));
        }
        if (typeof a.text === "string") {
          const name = typeof a.name === "string" && a.name.trim() ? a.name.trim().replace(/[\\/]/g, "-") : "Imported.md";
          files.push({ path: name, data: new TextEncoder().encode(a.text) });
        }
        const known = workspaceFiles(store);
        for (const ref of (a.refs as string[] | undefined) ?? []) {
          const hash = /^based-asset:([0-9a-f]{64})$/.exec(ref)?.[1];
          const at = hash ? assets.locate(hash) : undefined;
          if (!at) throw new ToolError(`No stored file ${ref} (upload_file stores one, list_files shows them).`);
          const name = assetFileInfo(assets, ref)?.name ?? known.get(ref)?.name ?? `file-${hash!.slice(0, 8)}`;
          files.push({ path: name.replace(/[\\/]/g, "-"), data: readFileSync(at.path) });
        }
        if (files.length === 0) throw new ToolError(local ? "Give refs, text or path." : "Give refs or text.");

        let payload: ImportPayload;
        try { payload = prepareFiles(files, { assets: new MemoryAssetSink(), maxAssetBytes: assets.maxBytes }); }
        catch (e) { throw new ToolError(`Couldn't read that: ${e instanceof Error ? e.message : String(e)}`); }
        return finishImport(ctx, assets, payload, parent);
      },
    },
    {
      group: "files", write: true,
      spec: {
        name: "notion_import",
        description: "Import from Notion through its API, in the background. action start: `links` (Notion page or database links; empty = everything shared with the integration), `parent`. action status: progress and, when done, the result. action cancel. Needs the Notion integration token on the server (BASED_NOTION_TOKEN); you never see it. Importing again updates in place.",
        inputSchema: {
          type: "object", additionalProperties: false, required: ["action"],
          properties: { action: { type: "string", enum: ["start", "status", "cancel"] }, links: { type: "array", items: str(), maxItems: 100 }, parent: str("Page id to import under") },
        },
      },
      run: (a) => {
        const { store } = ctx;
        const job = notionJobs.get(store);
        const status = (j: NotionJob) => (j.state === "running" ? `Running since ${new Date(j.startedAt).toISOString().slice(11, 16)} UTC: ${Math.round(j.fraction * 100)} % – ${j.message || "starting"}` : `${j.state === "done" ? "Done" : j.state === "failed" ? "Failed" : "Cancelled"}. ${j.result ?? ""}`.trim());
        if (a.action === "status") return job ? status(job) : "No Notion import has run on this server since it started.";
        if (a.action === "cancel") {
          if (!job || job.state !== "running") return "No Notion import is running.";
          job.cancelled = true;
          return "Cancelling: nothing of this import will be written.";
        }
        const token = process.env.BASED_NOTION_TOKEN?.trim();
        if (!token) throw new ToolError("The Notion token isn't set on this server. The user has to start the Based server with BASED_NOTION_TOKEN (an internal integration token from notion.so/my-integrations) and share the pages with that integration.");
        if (job?.state === "running") throw new ToolError(`A Notion import is already running (${status(job)}).`);
        const parent = typeof a.parent === "string" ? ctx.writable(a.parent).id : undefined;
        const targets = parseNotionTargets(((a.links as string[] | undefined) ?? []).join("\n"));
        if (((a.links as string[] | undefined) ?? []).length > 0 && targets.length === 0) throw new ToolError("None of the links is a Notion page or database link.");
        const next: NotionJob = { state: "running", startedAt: Date.now(), fraction: 0, message: "" };
        notionJobs.set(store, next);
        const imp = new NotionWorkspaceImport(token, fetchTransport());
        imp.onProgress = (fraction, message) => { next.fraction = fraction; next.message = message; };
        void (async () => {
          const builder = await imp.fetch(targets);
          if (next.cancelled) { next.state = "cancelled"; return; }
          const payload: ImportPayload = { notion: undefined, archives: [], notes: [], assets: 0 };
          if (builder.isEmpty) {
            const warnings = builder.report().warnings;
            payload.notes.push(...(warnings.length ? warnings : ["Nothing was imported. Make sure the pages are shared with the integration (••• → Connections)."]));
          } else {
            const sink = new MemoryAssetSink();
            builder.resolveAssets(new LimitedAssetSink(sink, assets.maxBytes));
            payload.assets = sink.files.size;
            payload.files = [...sink.files].map(([id, f]) => ({ id, name: f.ref.name, ...(f.ref.mime ? { mime: f.ref.mime } : {}), data: f.data }));
            payload.notion = preparedImportToWire({ builder, markdown: undefined, notes: [] });
          }
          next.result = await finishImport(ctx, assets, payload, parent);
          next.fraction = 1;
          next.state = "done";
        })().catch((e: unknown) => {
          next.state = "failed";
          // Meldung der Notion-API ohne Token (der Client schreibt es nie in Fehlertexte)
          next.result = e instanceof Error ? e.message : String(e);
        });
        return `Started the Notion import${targets.length ? ` of ${targets.length} link${targets.length === 1 ? "" : "s"}` : " of everything shared with the integration"}. It runs in the background; ask with notion_import {action: "status"}.`;
      },
    },
  ];
}
