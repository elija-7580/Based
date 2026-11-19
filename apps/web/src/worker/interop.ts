// Import schreiben und Exporte bauen – im Store-Worker (der Store liegt dort). Die Vorbereitung eines Imports läuft
// vorher im Import-Worker (importer.ts); hier landen nur noch Records.
import {
  archiveAssetRefs,
  exportAssetRefs,
  exportPageHTML,
  exportDocx,
  exportOPML,
  exportPageJSON,
  exportWorkspaceHTML,
  planWorkspaceExport,
  printPageHTML,
  topLevelPages,
  writeArchive,
  writeArchivePackage,
  writeExportZip,
  type AssetRef,
  type HTMLExportResult,
  type WorkspaceStore,
} from "@based/core";
import { loadAssets, type AssetStore } from "./assets.js";
export { commitImportPayload, type ImportSummary } from "@based/core";

export type ExportFormat = "markdown" | "html";
export type WorkspaceExportFormat = ExportFormat | "archive" | "pre-update";

/**
 * BSD-456: Sicherung vor dem App-Update. Bis zu dieser Dateimenge das volle Archiv (Records + Dateien); darüber –
 * oder wenn das volle Archiv scheitert (Speicher) – nur die Records (`.based.jsonl`): die Dateien liegen
 * inhaltsadressiert im Speicher der App und bleiben beim Update unberührt, die Records sind das Unersetzliche.
 * Sonst könnte ein großer Workspace nie aktualisiert werden.
 */
export const PRE_UPDATE_MAX_ASSET_BYTES = 300 * 1024 * 1024;
/** Nur für einzelne Seiten (BSD-260): Gliederung als OPML. */
export type PageExportFormat = ExportFormat | "opml" | "json" | "docx";

/** Wahl beim HTML-Export. */
export interface HTMLExportChoice {
  /** Unterseiten mit exportieren (ZIP). */
  subpages?: boolean;
  /** Bilder einbetten oder als `assets/`-Ordner beilegen. */
  images?: "embed" | "folder";
  /** Stylesheet aus den Design-Tokens (der Hauptthread baut es, der Worker hat kein DOM). */
  css?: string;
  /** BSD-260: Markdown mit YAML-Frontmatter (Titel, Zeiten, Properties) für Obsidian & Co. */
  frontmatter?: boolean;
}

/** Druckansicht einer Seite (für `print()` im Hauptthread). */
export interface PrintDocument {
  html: string;
  title: string;
  /** Bilder, die auf diesem Gerät fehlen. */
  missing: number;
}

export interface ExportFile {
  name: string;
  mime: string;
  data: Uint8Array;
  /** Kurzer Bericht (fehlende Dateien u. Ä.). */
  summary: string;
}

const enc = new TextEncoder();
const today = () => new Date().toISOString().slice(0, 10);
const missingNote = (n: number) => (n > 0 ? `${n} attached file${n === 1 ? "" : "s"} missing on this device.` : "");
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function htmlFile(r: HTMLExportResult, name = r.name): ExportFile {
  const parts = [r.kind === "html" ? `Exported “${name}”` : `Exported ${count(r.pages, "page")}`];
  if (r.assets > 0) parts[0] += ` with ${count(r.assets, "file")}`;
  const summary = [parts[0] + ".", missingNote(r.failures.length)].filter(Boolean).join(" ");
  return { name, mime: r.kind === "html" ? "text/html;charset=utf-8" : "application/zip", data: r.data, summary };
}

/**
 * Eine Seite als Markdown (Datenbank: CSV) oder HTML. HTML: eigenständige Datei mit eingebetteten Bildern, oder – mit
 * Unterseiten, `images: "folder"` oder nicht einbettbaren Anhängen – ein ZIP mit `assets/`.
 */
export async function exportPage(store: WorkspaceStore, pageID: string, format: PageExportFormat, assets?: AssetStore, choice: HTMLExportChoice = {}): Promise<ExportFile> {
  const page = store.blocks.get(pageID);
  if (!page) throw new Error("This page doesn't exist.");
  if (format === "json") {
    const r = exportPageJSON(store, pageID);
    return { name: r.name, mime: "application/json;charset=utf-8", data: enc.encode(r.json), summary: `Exported “${r.name}”.` };
  }
  if (format === "opml") {
    const r = exportOPML(store, pageID);
    return { name: r.name, mime: "text/x-opml;charset=utf-8", data: enc.encode(r.xml), summary: `Exported “${r.name}”.` };
  }
  if (format === "docx") {
    // BSD-260 Teil 6: Bilder eingebettet (soweit auf diesem Gerät vorhanden).
    const files = await loadAssets(assets, exportAssetRefs(store, [pageID], false));
    const r = exportDocx(store, pageID, { assetBytes: (ref) => files.get(ref.id) });
    return { name: r.name, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: r.data, summary: `Exported “${r.name}”.` };
  }
  if (format === "html") {
    const files = await loadAssets(assets, exportAssetRefs(store, [pageID], choice.subpages === true));
    return htmlFile(exportPageHTML(store, pageID, { ...choice, readAsset: (ref) => files.get(ref.id) }));
  }
  const plan = planWorkspaceExport(store, [page], format, { frontmatter: choice.frontmatter === true });
  const file = plan.files[0];
  if (!file) throw new Error("Nothing to export.");
  const name = file.path.split("/").at(-1)!;
  const mime = name.endsWith(".csv") ? "text/csv" : "text/markdown";
  return { name, mime: mime + ";charset=utf-8", data: enc.encode(file.contents), summary: `Exported “${name}”.` };
}

/** Druckansicht einer Seite: HTML mit eingebetteten Bildern und Druck-Regeln. */
export async function printPage(store: WorkspaceStore, pageID: string, assets?: AssetStore, css?: string): Promise<PrintDocument> {
  const files = await loadAssets(assets, exportAssetRefs(store, [pageID], false));
  const r = printPageHTML(store, pageID, { css, readAsset: (ref) => files.get(ref.id) });
  return { html: r.html, title: r.title, missing: r.failures.length };
}

/** Ganzer Workspace: ZIP mit Markdown oder HTML (und `assets/`) oder ein verlustfreies Based-Archiv. */
export async function exportWorkspace(store: WorkspaceStore, format: WorkspaceExportFormat, assets?: AssetStore, choice: HTMLExportChoice = {}): Promise<ExportFile> {
  if (format === "pre-update") {
    const refs = archiveAssetRefs(store.allRecords());
    const known = refs.reduce((n, r) => n + (r.size ?? 0), 0);
    const recordsOnly = (): ExportFile => ({ name: "pre-update.based.jsonl", mime: "application/x-ndjson", data: enc.encode(writeArchive(store)), summary: `Archived ${store.exportRecords().length} records (files stay in the app's storage).` });
    if (known > PRE_UPDATE_MAX_ASSET_BYTES) return recordsOnly();
    try {
      return await exportWorkspace(store, "archive", assets, choice);
    } catch {
      return recordsOnly();
    }
  }
  if (format === "archive") {
    const files = await loadAssets(assets, archiveAssetRefs(store.allRecords()));
    const r = writeArchivePackage(store, (ref) => files.get(ref.id));
    const base = (store.workspace.name.trim() || "Workspace").replace(/[\\/:*?"<>|]/g, "-");
    return { name: `${base} ${today()}.based.zip`, mime: "application/zip", data: r.zip, summary: [`Archived ${r.records} records${r.assets > 0 ? ` and ${count(r.assets, "file")}` : ""}.`, missingNote(r.missing.length)].filter(Boolean).join(" ") };
  }
  if (format === "html") {
    const pages = topLevelPages(store).map((p) => p.id);
    const files = await loadAssets(assets, exportAssetRefs(store, pages, true));
    return htmlFile(exportWorkspaceHTML(store, { ...choice, readAsset: (ref) => files.get(ref.id) }), `Based Export HTML ${today()}.zip`);
  }
  const plan = planWorkspaceExport(store, topLevelPages(store), format, { frontmatter: choice.frontmatter === true });
  const files = await loadAssets(assets, plan.assets.map((a) => a.ref));
  const { zip, report } = writeExportZip(plan, (ref: AssetRef) => files.get(ref.id));
  const summary = [`Exported ${count(report.pages, "page")}${report.assets > 0 ? ` and ${count(report.assets, "file")}` : ""}.`, missingNote(report.failures.length)].filter(Boolean).join(" ");
  return { name: `Based Export Markdown ${today()}.zip`, mime: "application/zip", data: zip, summary };
}
