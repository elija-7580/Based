// BSD-317: Verzeichnis eines Notion-HTML-Exports (ZIP), ohne ihn auszupacken. Gelesen wird nur das ZIP-Verzeichnis;
// jede Datei wird erst entpackt, wenn ihre Seite an der Reihe ist, und danach wieder freigegeben – ein Export mit
// 20.000 Seiten liegt so nie ganz im Speicher. Seiten werden über die Notion-ID im Dateinamen gefunden.
// Clean-Room: nur das Dateiformat des Exports, wie ihn Notion ausliefert (HTML mit Unterseiten).
import { basename, bytesSource, dirname, extname, ImportFiles, joinPath, stripExtension, subSource, type ByteSource } from "../files.js";
import { notionIDInName } from "../importids.js";
import { DEFAULT_ZIP_LIMITS, ImportCancelled, isDirectoryEntry, isEncryptedEntry, isZip, readZipEntries, sanitizedZipPath, ZipError, zipEntryData, zipEntryStart, type ZipLimits } from "../zip.js";

export type HybridErrorKind = "markdownExport" | "notAnExport" | "noState" | "needsZip";

/** Fehler, die der Dialog dem Menschen erklärt (kein Absturz, kein halber Import). */
export class HybridImportError extends Error {
  constructor(readonly kind: HybridErrorKind, message: string) {
    super(message);
    this.name = "HybridImportError";
  }
}

export interface OpenExportOptions {
  limits?: Partial<ZipLimits> | undefined;
  isCancelled?: (() => boolean) | undefined;
}

const isHTML = (p: string) => ["html", "htm"].includes(extname(p).toLowerCase());

export class NotionExportIndex {
  readonly files = new ImportFiles();
  /** Übersprungene Einträge: „Pfad — Grund“. */
  readonly skipped: string[] = [];
  /** Jüngste Änderungszeit einer HTML-Datei (ms seit 1970, DOS-Zeit als UTC gelesen) – ungefähr der Exportzeitpunkt. */
  exportedAt: number | undefined;
  htmlCount = 0;
  markdownCount = 0;
  private readonly byID = new Map<string, string>();
  private readonly byPath = new Map<string, string>();
  private readonly lazies = new Map<string, { size: number; load: () => Uint8Array | undefined }>();
  private touched: string[] = [];
  /** Mehrere Dateien mit derselben Notion-ID (die erste zählt). */
  duplicates = 0;

  /** Datei der Seite oder Datenbank mit dieser Notion-ID. */
  pageFile(id: string): string | undefined { return this.byID.get(id); }
  has(id: string): boolean { return this.byID.has(id); }
  get ids(): IterableIterator<string> { return this.byID.keys(); }

  /** Notion-ID der Seite, in deren Ordner die Datei dieser Seite liegt (die Hierarchie des Exports). */
  ownerOf(id: string): string | undefined {
    const f = this.byID.get(id);
    if (f === undefined) return undefined;
    const dir = dirname(f);
    if (dir === "") return undefined;
    return this.byPath.get(dir + ".html") ?? notionIDInName(basename(dir));
  }

  /** Gelesene Dateien wieder freigeben (der Dateibaum behält kleine Dateien sonst im Speicher). */
  release() {
    for (const p of this.touched) { const l = this.lazies.get(p); if (l) this.files.addLazy(p, l); }
    this.touched = [];
  }

  /** @internal */
  _add(path: string, src: ByteSource, entry: Parameters<typeof zipEntryData>[1]) {
    const lazy = {
      size: entry.uncompressedSize,
      load: () => {
        this.touched.push(path);
        try { return zipEntryData(src, entry); } catch { return undefined; }
      },
    };
    this.lazies.set(path, lazy);
    this.files.addLazy(path, lazy);
    const ext = extname(path).toLowerCase();
    if (ext === "md") this.markdownCount += 1;
    if (!isHTML(path)) return;
    this.htmlCount += 1;
    if (entry.modified !== undefined && (this.exportedAt === undefined || entry.modified > this.exportedAt)) this.exportedAt = entry.modified;
    const id = notionIDInName(basename(stripExtension(path)));
    if (id === undefined) return;
    if (this.byID.has(id)) { this.duplicates += 1; return; }
    this.byID.set(id, path);
    this.byPath.set(path, id);
  }
}

/**
 * Öffnet einen Notion-Export. Verschachtelte Teile („Export-…-Part-1.zip“) werden wie Ordner behandelt. Wirft
 * `HybridImportError`, wenn das Archiv kein HTML-Export ist (Markdown & CSV trägt keine Seiten-IDs im Inhalt und rät
 * Spaltentypen – dafür bleibt der gewöhnliche ZIP-Import).
 */
export function openNotionExport(input: Uint8Array | ByteSource, opts: OpenExportOptions = {}): NotionExportIndex {
  // Nichts wird vorab entpackt, deshalb darf das Verzeichnis groß sein (ein Workspace mit 20.000 Seiten und ihren
  // Bildern hat schnell über 100.000 Einträge). Die Grenzen je Datei gelten weiter.
  const limits = { ...DEFAULT_ZIP_LIMITS, maxEntries: 1_000_000, ...opts.limits };
  const index = new NotionExportIndex();
  const state = { entries: 0 };
  const visit = (src: ByteSource, prefix: string, depth: number) => {
    const entries = readZipEntries(src);
    state.entries += entries.length;
    if (state.entries > limits.maxEntries) throw new ZipError("limit", `more than ${limits.maxEntries} entries`);
    for (const entry of entries) {
      if (opts.isCancelled?.()) throw new ImportCancelled();
      const rel = sanitizedZipPath(entry.path);
      if (rel === undefined) { if (entry.path !== "" && entry.path !== "/") index.skipped.push(`${entry.path} — unsafe path`); continue; }
      if (rel.startsWith("__MACOSX/") || rel === "__MACOSX" || rel.endsWith(".DS_Store")) continue;
      const dest = joinPath(prefix, rel);
      if (isDirectoryEntry(entry)) { index.files.addDirectory(dest); continue; }
      if (isEncryptedEntry(entry)) { index.skipped.push(`${rel} — encrypted`); continue; }
      if (entry.method !== 0 && entry.method !== 8) { index.skipped.push(`${rel} — compression method ${entry.method}`); continue; }
      if (entry.uncompressedSize > limits.maxEntryBytes) { index.skipped.push(`${rel} — larger than ${limits.maxEntryBytes} bytes`); continue; }
      if (entry.uncompressedSize > 1_000_000 && entry.uncompressedSize > entry.compressedSize * limits.maxRatio) { index.skipped.push(`${rel} — expands more than ${limits.maxRatio}×`); continue; }
      if (extname(rel).toLowerCase() === "zip" && depth < limits.maxDepth) {
        try {
          if (entry.method === 0 && entry.compressedSize >= 4) {
            const start = zipEntryStart(src, entry);
            if (isZip(src.read(start, 4))) { visit(subSource(src, start, entry.compressedSize), stripExtension(dest), depth + 1); continue; }
          } else {
            const data = zipEntryData(src, entry);
            if (isZip(data)) { visit(bytesSource(data), stripExtension(dest), depth + 1); continue; }
          }
        } catch (e) {
          if (!(e instanceof ZipError) || e.kind === "limit" || e.kind === "cancelled") throw e;
          index.skipped.push(`${rel} — damaged (unreadable)`);
          continue;
        }
      }
      index._add(dest, src, entry);
    }
  };
  visit(input instanceof Uint8Array ? bytesSource(input) : input, "", 0);
  if (index.htmlCount === 0) {
    if (index.markdownCount > 0) {
      throw new HybridImportError("markdownExport", "This is a “Markdown & CSV” export. The fast import needs the HTML export: in Notion choose Export → HTML, include subpages and create folders for subpages.");
    }
    throw new HybridImportError("notAnExport", "This ZIP doesn't look like a Notion HTML export (no .html pages inside).");
  }
  return index;
}
