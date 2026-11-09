// Import schreiben und Exporte bauen – im Store-Worker (der Store liegt dort). Die Vorbereitung eines Imports läuft
// vorher im Import-Worker (importer.ts); hier landen nur noch Records.
import {
  commitPreparedImport,
  importArchiveRecords,
  planWorkspaceExport,
  preparedImportFromWire,
  topLevelPages,
  writeArchivePackage,
  writeExportZip,
  type WorkspaceStore,
} from "@based/core";
import type { ImportPayload } from "./importer.js";

export interface ImportSummary {
  pages: number;
  databases: number;
  rows: number;
  /** Records aus Based-Archiven (geschrieben). */
  archiveRecords: number;
  /** Archiv-Records, die hier schon neuer waren (bleiben). */
  keptNewer: number;
  /** Reimport-Schutz: in Based geänderte bzw. hinzugefügte Blöcke, die bleiben. */
  keptLocalChanges: number;
  keptLocalAdditions: number;
  /** Übersprungenes, Fehler, Hinweise. */
  warnings: string[];
  /** Neue oberste Seiten (zum Öffnen). */
  rootIDs: string[];
}

export type ExportFormat = "markdown" | "html";
export type WorkspaceExportFormat = ExportFormat | "archive";

export interface ExportFile {
  name: string;
  mime: string;
  data: Uint8Array;
  /** Kurzer Bericht (fehlende Dateien u. Ä.). */
  summary: string;
}

/** Vorbereiteten Import schreiben: Notion/Markdown über `commitPreparedImport` (Reimport-Schutz), Archive mit
 * Herkunft „import“ (Stempel bleiben). */
export function commitImportPayload(store: WorkspaceStore, payload: ImportPayload, parent = "w"): ImportSummary {
  const s: ImportSummary = { pages: 0, databases: 0, rows: 0, archiveRecords: 0, keptNewer: 0, keptLocalChanges: 0, keptLocalAdditions: 0, warnings: [...payload.notes], rootIDs: [] };
  for (const a of payload.archives) {
    const r = importArchiveRecords(store, a.read);
    s.archiveRecords += r.imported;
    s.keptNewer += r.keptNewer;
    if (r.keptNewer > 0) s.warnings.push(`${a.name}: kept ${r.keptNewer} newer record${r.keptNewer === 1 ? "" : "s"} from this workspace`);
  }
  if (payload.notion) {
    const r = commitPreparedImport(store, preparedImportFromWire(payload.notion), { parent });
    s.pages += r.pages;
    s.databases += r.databases;
    s.rows += r.rows;
    s.keptLocalChanges += r.keptLocalChanges;
    s.keptLocalAdditions += r.keptLocalAdditions;
    s.warnings.push(...r.warnings);
    s.rootIDs.push(...r.rootIDs.filter((id) => store.blocks.has(id)));
  }
  if (store.isReadOnly) throw new Error(store.writeFailure?.message || "The workspace is read-only.");
  return s;
}

const enc = new TextEncoder();
const today = () => new Date().toISOString().slice(0, 10);
const missingNote = (n: number) => (n > 0 ? `${n} attached file${n === 1 ? "" : "s"} missing on this device.` : "");

/** Eine Seite als Markdown (Datenbank: CSV) oder eigenständiges HTML; Links auf Unterseiten wie im Workspace-Export. */
export function exportPage(store: WorkspaceStore, pageID: string, format: ExportFormat): ExportFile {
  const page = store.blocks.get(pageID);
  if (!page) throw new Error("This page doesn't exist.");
  const plan = planWorkspaceExport(store, [page], format);
  const file = plan.files[0];
  if (!file) throw new Error("Nothing to export.");
  const name = file.path.split("/").at(-1)!;
  const mime = format === "html" ? "text/html" : name.endsWith(".csv") ? "text/csv" : "text/markdown";
  return { name, mime: mime + ";charset=utf-8", data: enc.encode(file.contents), summary: `Exported “${name}”.` };
}

/** Ganzer Workspace: ZIP mit Markdown oder HTML (und `assets/`) oder ein verlustfreies Based-Archiv. */
export function exportWorkspace(store: WorkspaceStore, format: WorkspaceExportFormat): ExportFile {
  const readAsset = () => undefined; // im Browser gibt es (noch) keinen Dateispeicher
  if (format === "archive") {
    const r = writeArchivePackage(store, readAsset);
    const base = (store.workspace.name.trim() || "Workspace").replace(/[\\/:*?"<>|]/g, "-");
    return { name: `${base} ${today()}.based.zip`, mime: "application/zip", data: r.zip, summary: [`Archived ${r.records} records.`, missingNote(r.missing.length)].filter(Boolean).join(" ") };
  }
  const plan = planWorkspaceExport(store, topLevelPages(store), format);
  const { zip, report } = writeExportZip(plan, readAsset);
  const label = format === "html" ? "HTML" : "Markdown";
  const summary = [`Exported ${report.pages} page${report.pages === 1 ? "" : "s"}.`, missingNote(report.failures.length)].filter(Boolean).join(" ");
  return { name: `Based Export ${label} ${today()}.zip`, mime: "application/zip", data: zip, summary };
}
