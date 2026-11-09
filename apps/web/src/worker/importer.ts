// Import vorbereiten (läuft im Import-Worker, ohne Store): Dateien, Ordner oder ZIPs lesen – Notion-HTML-Export,
// Markdown/CSV, Based-Archiv (.based.zip, .jsonl). Ergebnis ist strukturiert klonbar und wird im Store-Worker
// geschrieben (`commitImportPayload`); dort greift der Reimport-Schutz des Kerns.
import {
  ImportFiles,
  isArchive,
  loadArchive,
  preparedImportToWire,
  prepareImport,
  type ArchiveReadResult,
  type PreparedImportWire,
} from "@based/core";

export interface ImportFile {
  /** Relativer Pfad („Export/Seite.html“) oder nur der Dateiname. */
  path: string;
  data: Uint8Array;
}

export interface PreparedArchive {
  name: string;
  read: ArchiveReadResult;
}

export interface ImportPayload {
  notion: PreparedImportWire | undefined;
  archives: PreparedArchive[];
  /** Hinweise für den Bericht (übersprungene Einträge, nicht übernommene Dateien). */
  notes: string[];
}

export interface PrepareOptions {
  progress?: (fraction: number) => void;
  isCancelled?: () => boolean;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** Quellen aus den gewählten Dateien: ein Dateibaum, je oberster Eintrag eine Quelle (Ordner oder Datei). */
export function prepareFiles(files: ImportFile[], opts: PrepareOptions = {}): ImportPayload {
  const out: ImportPayload = { notion: undefined, archives: [], notes: [] };
  const progress = opts.progress ?? (() => {});
  const tree = new ImportFiles();
  const roots: string[] = [];
  let archiveAssets = 0;
  for (const f of files) {
    const name = f.path.split("/").at(-1) ?? f.path;
    const lower = name.toLowerCase();
    if (lower.endsWith(".jsonl") || lower.endsWith(".based.zip") || (lower.endsWith(".zip") && isArchive(f.data))) {
      if (isArchive(f.data)) {
        const loaded = loadArchive(f.data);
        out.archives.push({ name, read: loaded.read });
        archiveAssets += loaded.assets.length;
        for (const fail of loaded.assetFailures) out.notes.push(`Skipped ${fail}`);
        if (loaded.read.skipped > 0) out.notes.push(`${name}: skipped ${plural(loaded.read.skipped, "unreadable line")}`);
        continue;
      }
      if (lower.endsWith(".jsonl")) { out.notes.push(`Skipped ${name} (not a Based archive)`); continue; }
    }
    tree.add(f.path, f.data);
    const root = f.path.replace(/^\/+/, "").split("/")[0]!;
    if (root && !roots.includes(root)) roots.push(root);
  }
  if (archiveAssets > 0) out.notes.push(`${plural(archiveAssets, "attached file")} from the archive not imported — file storage isn't available in the browser yet.`);
  progress(0.05);
  if (roots.length > 0) {
    const prepared = prepareImport(roots.map((path) => ({ files: tree, path })), {
      progress: (f) => progress(0.05 + f * 0.9),
      isCancelled: opts.isCancelled,
      userID: null,
    });
    // Ohne Dateispeicher im Browser: Bilder und Anhänge entfallen (nur externe URLs bleiben) – nicht mitschicken.
    const pending = prepared.builder?.pendingAssets.size ?? 0;
    if (pending > 0) {
      prepared.builder!.resolveAssets(undefined);
      prepared.notes.push(`${plural(pending, "image or attachment", "images or attachments")} not imported — file storage isn't available in the browser yet.`);
    }
    if (prepared.builder?.isEmpty === false || (prepared.markdown && prepared.markdown.records.length > 0)) out.notion = preparedImportToWire(prepared);
    else {
      out.notes.push(...prepared.notes, ...(prepared.markdown?.report.warnings ?? []));
      if (out.archives.length === 0) out.notes.push("Nothing to import in the chosen files.");
    }
  }
  progress(1);
  return out;
}
