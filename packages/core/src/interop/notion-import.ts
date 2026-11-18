// Notion-Export importieren – das heruntergeladene .zip (auch verschachtelte „Part-1.zip“), ein entpackter Ordner,
// „Markdown & CSV“ oder „HTML“ – oder einzelne .md/.csv/.html-Dateien. Port von Swift Interop/NotionImport.swift.
//
// Zwei Schritte, damit die schwere Arbeit in einem Worker laufen kann:
//   1. `prepareImport(files, items, opts)` – rein: entpackt ZIPs (mit Grenzen), liest HTML-Exporte in einen
//      `ImportBuilder` und Markdown/CSV in fertige Records; Fortschritt und Abbruch (`ImportCancelled`).
//   2. `commitPreparedImport(store, prepared)` – im Hauptthread: eine Transaktion je Teil, Reimport-Schutz.
// `importNotionItems(store, …)` macht beides nacheinander.
import type { Block, BlockProps, Database, DatabaseView, PropertySchema, PropertyValue, WireRecord } from "../model/records.js";
import { parseDate, parseSwiftDouble } from "../query/value.js";
import { keyBetween, keysBetween } from "../sortkeys.js";
import { ZERO_STAMP } from "../hlc.js";
import type { WorkspaceStore } from "../store/store.js";
import { AssetRejected, commitImport, importAssetFrom, emptyReport, ImportBuilder, looksLikeLocalFile, makeBlock, makeRecordID, mimeFor, type AssetRef, type AssetSink, type ImportBuilderWire, type ImportReport } from "./builder.js";
import { basename, comparePaths, dirname, extname, ImportFiles, joinPath, normalizePath, stripExtension } from "./files.js";
import { graphemes, trimSpaces } from "./html.js";
import { notionIDInName, removingPercentEncoding } from "./importids.js";
import { decodeCSV, MarkdownImporter, unguardCSVFormula, type MarkdownBlock } from "./markdown.js";
import { decodeTextBytes, parseDelimited, sniffDelimiter } from "./file-preview.js";
import { cleanTitle, NotionHTMLImporter, parseNotionNumber } from "./notion-html.js";
import { toRichText } from "./runs.js";
import { extractZip, ImportCancelled, isExportPart, isZip, type ZipLimits } from "./zip.js";
import { markdownFileName } from "./markdown-export.js";
import { findObsidianVault, ObsidianImporter, splitFrontmatter } from "./obsidian-import.js";
import { EnexImporter } from "./enex-import.js";
import { importOPML } from "./opml.js";
import { planJSONImport, type JSONImportPlan } from "./json-import.js";
import { DocxImporter } from "./docx-import.js";
import { convertForeignExport } from "./foreign/index.js";
import { FILE_COLUMN, HINT } from "./foreign/table.js";
import { extractTar } from "./tar.js";

/** Prüfung Pass 37: Dateiendung → Blockart für alleinstehende Datei-Links im Markdown. */
const FILE_BLOCK_BY_EXT: Record<string, string> = {
  pdf: "pdf", mp4: "video", m4v: "video", mov: "video", webm: "video", mp3: "audio", m4a: "audio", wav: "audio", ogg: "audio", aac: "audio", flac: "audio",
};

export interface NotionImportOptions {
  /** Wohin Bilder und Dateien kommen; ohne Speicher bleiben nur externe URLs. */
  assets?: AssetSink | undefined;
  /** Elternteil der neuen Seiten (`w`, `b:<id>`). */
  parent?: string | undefined;
  progress?: ((fraction: number) => void) | undefined;
  isCancelled?: (() => boolean) | undefined;
  zipLimits?: Partial<ZipLimits> | undefined;
  /** Zeit für neue Records (Swift-Datum). */
  now?: (() => number) | undefined;
  /** Autor neuer Markdown-Seiten (Swift `store.userID`). */
  userID?: string | null | undefined;
  /** Verweise auf Dateien, die im Import fehlen, als Warnung in den Bericht (die Swift-App meldet sie nicht). */
  warnMissingFiles?: boolean | undefined;
}

/** Ein Teil des Imports: ein Dateibaum und ein Pfad darin (Ordner oder Datei). */
export interface ImportSource { files: ImportFiles; path: string }

export interface PreparedImport {
  /** Notion-HTML-Exporte, mit voller Treue gelesen (`commitImport`). */
  builder: ImportBuilder | undefined;
  /** Markdown/CSV: Records in Schreibreihenfolge; Wurzeln mit vorläufigen Sortierschlüsseln (`rootKeys`). */
  markdown: { records: WireRecord[]; rootKeys: string[]; report: ImportReport } | undefined;
  notes: string[];
}

/** Archive: ZIP, Joplin (.jex/.tar), Bear-Sicherung (.bear2bk) und gepackte TextBundles (.textpack) – die letzten beiden sind ZIPs. */
const ARCHIVE_EXT = new Set(["zip", "jex", "tar", "bear2bk", "textpack"]);
/** Formate, die sich nicht lesen lassen – mit dem Weg, der stattdessen geht. */
const UNREADABLE: Record<string, string> = {
  one: "OneNote sections can't be read directly — in OneNote, export the notebook as Word (.docx) and import that",
  onepkg: "OneNote packages can't be read directly — in OneNote, export the notebook as Word (.docx) and import that",
  pages: "Pages documents can't be read directly — export as Word (.docx) from Pages and import that",
  pdf: "PDFs aren't imported as pages — drop a PDF into a page to attach it",
};
/** Dateiname ohne Endung und ohne „_all“ (für die Notion-ID im Namen einer CSV). */
const cleanTitleSource = (f: string) => basename(stripExtension(f)).replace(/_all$/i, "");
const swiftNow = () => (Date.now() - 978_307_200_000) / 1000;
const isDir = (files: ImportFiles, p: string) => files.isDirectory(p) && !files.isFile(p);
const containsExt = (files: ImportFiles, dir: string, exts: string[]) => files.walk(dir).some((f) => exts.includes(extname(f).toLowerCase()));

/** Zerlegt Quellen: ZIPs auspacken, HTML-Exporte lesen, Markdown/CSV vormerken (Swift `NotionImporter.prepare`). */
export function prepareImport(sources: ImportSource[], opts: NotionImportOptions = {}): PreparedImport {
  const progress = opts.progress ?? (() => {});
  const out: PreparedImport = { builder: undefined, markdown: undefined, notes: [] };
  const html: ImportSource[] = [];
  const md: ImportSource[] = [];
  // BSD-260: Obsidian-Vaults (Ordner mit `.obsidian/`) liest ein eigener Importer (Wikilinks, Einbettungen, Frontmatter).
  const vaults: { files: ImportFiles; vault: string; title: string | undefined; label?: string | undefined; titles?: Map<string, string> | undefined }[] = [];
  /** Export einer anderen App (Joplin, Roam, Keep, ChatGPT …): übersetzter Baum → Vault- bzw. Markdown-Import. */
  const takeForeign = (files: ImportFiles, root: string, name: string): boolean => {
    const converted = convertForeignExport(files, root, name);
    if (!converted) return false;
    out.notes.push(converted.note);
    if (converted.vault) vaults.push({ files: converted.files, vault: "", title: converted.title, label: converted.label, titles: converted.titles });
    else md.push({ files: converted.files, path: "" });
    return true;
  };
  // BSD-260: Evernote-Notizbücher (.enex), Gliederungen (.opml) und Word-Dokumente (.docx), auch in ZIPs und Ordnern.
  const enex: { files: ImportFiles; path: string }[] = [];
  // BSD-260 Teil 7: JSON/JSONL – Seiten-JSON als Seite, Tabellen als CSV-Datenbank.
  const jsonPages: Extract<JSONImportPlan, { kind: "page" }>[] = [];
  const enexIn = (files: ImportFiles, dir: string) => files.walk(dir).filter((f) => ["enex", "opml", "docx"].includes(extname(f).toLowerCase()));
  // HTML-Quellen, in denen danach noch Markdown/CSV stehen kann (nach dem HTML-Import entschieden, s. unten).
  const htmlTrees: ImportSource[] = [];
  /** Ein Dateibaum (entpacktes ZIP) einordnen: Notizbücher, Vault, HTML-Export, Markdown/CSV. */
  const classifyTree = (files: ImportFiles, name: string) => {
    if (takeForeign(files, "", name)) return;
    const notebooks = enexIn(files, "");
    if (notebooks.length > 0 && !containsExt(files, "", ["md", "csv", "html", "htm"])) {
      for (const f of notebooks) enex.push({ files, path: f });
      return;
    }
    const vault = findObsidianVault(files, "");
    if (vault !== undefined) {
      vaults.push({ files, vault, title: vault === "" ? name : undefined });
      return;
    }
    const hasHTML = containsExt(files, "", ["html", "htm"]);
    if (hasHTML) { html.push({ files, path: "" }); htmlTrees.push({ files, path: "" }); }
    else md.push({ files, path: "" });
  };
  // Notions Teil-Archive („Export-…-Part-1.zip“, „…-Part-2.zip“), einzeln gewählt: EIN Export – zusammen lesen.
  const parts = new Map<string, ImportFiles>();
  const trees: { files: ImportFiles; name: string }[] = [];
  sources.forEach((src, i) => {
    const p = normalizePath(src.path);
    const ext = extname(p).toLowerCase();
    const exists = src.files.exists(p);
    // BSD-254: das ZIP nicht ganz laden – als Quelle (im Worker: die gewählte Datei) lesen
    const zip = src.files.isFile(p) ? src.files.source(p) : undefined;
    if (zip && (ARCHIVE_EXT.has(ext) || (ext === "" && isZip(zip.read(0, Math.min(4, zip.size)))))) {
      if (!isZip(zip.read(0, Math.min(4, zip.size)))) {
        // Joplin-Export (.jex) ist ein tar-Archiv
        const tar = ext === "jex" || ext === "tar" ? extractTar(zip.read(0, zip.size)) : undefined;
        if (tar) trees.push({ files: tar, name: stripExtension(basename(p)) });
        else out.notes.push(`Skipped ${basename(p)} (not a readable archive)`);
        progress((i + 1) / sources.length * 0.5);
        return;
      }
      const r = extractZip(zip, { limits: opts.zipLimits, isCancelled: opts.isCancelled, progress: (f) => progress((i + f * 0.5) / sources.length) });
      out.notes.push(`Unpacked ${basename(p)}: ${r.count} files`);
      for (const s of r.skipped) out.notes.push(`Skipped ${s}`);
      const name = stripExtension(basename(p));
      const key = isExportPart(p) ? name.replace(/-Part-\d+$/i, "").toLowerCase() : undefined;
      const first = key !== undefined ? parts.get(key) : undefined;
      if (first) first.mount("", r.files);
      else {
        if (key !== undefined) parts.set(key, r.files);
        trees.push({ files: r.files, name });
      }
    } else if (exists && src.files.isFile(p) && (ext === "json" || ext === "jsonl")) {
      const text = src.files.readText(p) ?? "";
      const single = new ImportFiles([[basename(p), new TextEncoder().encode(text)]]);
      if (ext === "json" && takeForeign(single, "", stripExtension(basename(p)))) {
        progress((i + 1) / sources.length * 0.5);
        return;
      }
      const plan = planJSONImport(text, stripExtension(basename(p)), ext === "jsonl");
      if (plan.kind === "csv") md.push({ files: new ImportFiles([[plan.name, new TextEncoder().encode(plan.csv)]]), path: plan.name });
      else if (plan.kind === "page") jsonPages.push(plan);
      else md.push({ files: src.files, path: p }); // wie bisher: übersprungen mit Hinweis
    } else if (exists && (ext === "enex" || ext === "opml" || ext === "docx")) {
      enex.push({ files: src.files, path: p });
    } else if (exists && isDir(src.files, p) && takeForeign(src.files, p, basename(p))) {
      // übersetzt (s. takeForeign)
    } else if (exists && isDir(src.files, p) && enexIn(src.files, p).length > 0 && !containsExt(src.files, p, ["md", "csv", "html", "htm"])) {
      for (const f of enexIn(src.files, p)) enex.push({ files: src.files, path: f });
    } else if (exists && isDir(src.files, p) && findObsidianVault(src.files, p) !== undefined) {
      vaults.push({ files: src.files, vault: findObsidianVault(src.files, p)!, title: undefined });
    } else if (exists && isDir(src.files, p) && containsExt(src.files, p, ["html", "htm"])) {
      html.push({ files: src.files, path: p });
      htmlTrees.push({ files: src.files, path: p });
    } else if (exists && (ext === "html" || ext === "htm")) {
      html.push({ files: src.files, path: p });
    } else {
      md.push({ files: src.files, path: p });
    }
    progress((i + 1) / sources.length * 0.5);
  });
  for (const t of trees) classifyTree(t.files, t.name);
  if (html.length > 0) {
    const builder = new ImportBuilder({ createdBy: null, now: opts.now });
    html.forEach((src, i) => {
      const imp = new NotionHTMLImporter(builder, src.files, {
        progress: (f) => progress(0.5 + (i + f) / html.length * 0.4),
        isCancelled: opts.isCancelled,
        warnMissingFiles: opts.warnMissingFiles,
      });
      imp.importExport(src.path);
    });
    if (opts.assets) builder.resolveAssets(opts.assets);
    out.builder = builder;
  }
  // Notions HTML-Export legt Datenbanken zusätzlich als CSV daneben („Tasks <id>.csv“, „…_all.csv“). Die Datenbank
  // steht schon im HTML (mit Typen, Farben, Zeilenseiten) – die CSV noch einmal zu lesen, legte sie doppelt an.
  for (const t of htmlTrees) {
    const all = t.files.walk(t.path);
    const notionHTML = all.some((f) => ["html", "htm"].includes(extname(f).toLowerCase()) && notionIDInName(basename(stripExtension(f))) !== undefined);
    if (notionHTML) for (const f of all) if (extname(f).toLowerCase() === "csv" && notionIDInName(cleanTitleSource(f)) !== undefined) t.files.remove(f);
    if (containsExt(t.files, t.path, ["md", "csv"])) md.push(t);
  }
  if (md.length > 0) out.markdown = new MarkdownNotionImporter(opts).run(md);
  const extra: (() => { records: WireRecord[]; rootKeys: string[]; report: ImportReport })[] = [];
  const common = { assets: opts.assets, now: opts.now, userID: opts.userID, isCancelled: opts.isCancelled };
  for (const v of vaults) extra.push(() => new ObsidianImporter(v.files, v.vault, { ...common, label: v.label, titles: v.titles }).run(v.title, out.markdown?.rootKeys.at(-1)));
  for (const j of jsonPages) extra.push(() => j.run({ now: opts.now, userID: opts.userID, afterKey: out.markdown?.rootKeys.at(-1) }));
  for (const e of enex) {
    extra.push(() => {
      const title = stripExtension(basename(e.path));
      if (extname(e.path).toLowerCase() === "docx") {
        const src = e.files.source(e.path);
        if (!src) throw new Error(`Couldn't read ${basename(e.path)}`);
        const doc = extractZip(src, { limits: opts.zipLimits, isCancelled: opts.isCancelled });
        return new DocxImporter(doc.files, "", common).run(title, out.markdown?.rootKeys.at(-1));
      }
      const xml = e.files.readStrictText(e.path) ?? e.files.readText(e.path) ?? "";
      if (extname(e.path).toLowerCase() === "opml") return importOPML(xml, title, { now: opts.now, userID: opts.userID, afterKey: out.markdown?.rootKeys.at(-1) });
      return new EnexImporter(common).run(xml, title, out.markdown?.rootKeys.at(-1));
    });
  }
  for (const run of extra) {
    const prev = out.markdown;
    const r = run();
    if (!prev) out.markdown = r;
    else {
      for (const x of r.records) prev.records.push(x); // BSD-435: kein Spread (große Datenbanken)
      for (const x of r.rootKeys) prev.rootKeys.push(x);
      const a = prev.report, b = r.report;
      a.pages += b.pages; a.databases += b.databases; a.rows += b.rows; a.assets += b.assets;
      a.warnings.push(...b.warnings); a.rootIDs.push(...b.rootIDs);
    }
  }
  progress(1);
  return out;
}

/** `PreparedImport` als reine Daten (über `postMessage` zwischen Workern). */
export interface PreparedImportWire {
  builder: ImportBuilderWire | undefined;
  markdown: PreparedImport["markdown"];
  notes: string[];
}

export function preparedImportToWire(p: PreparedImport): PreparedImportWire {
  return { builder: p.builder?.toWire(), markdown: p.markdown, notes: p.notes };
}

export function preparedImportFromWire(w: PreparedImportWire): PreparedImport {
  return { builder: w.builder ? ImportBuilder.fromWire(w.builder) : undefined, markdown: w.markdown, notes: w.notes };
}

/** Schreibt einen vorbereiteten Import: HTML zuerst, dann Markdown/CSV (Swift `importPrepared`). */
export function commitPreparedImport(store: WorkspaceStore, prepared: PreparedImport, opts: NotionImportOptions = {}): ImportReport {
  const parent = opts.parent ?? "w";
  let r = emptyReport();
  const b = prepared.builder;
  if (b && !b.isEmpty) {
    b.resolveAssets(opts.assets);
    r = commitImport(store, b, parent, "Import");
    r.assets = b.storedAssets;
  }
  const m = prepared.markdown;
  if (m) {
    // Wurzeln ans Ende von `parent`: vorläufige Schlüssel (ab nichts) auf die echten abbilden.
    const kids = store.children(parent);
    const start = kids.length ? store.blocks.get(kids[kids.length - 1]!)?.sk : undefined;
    // Alle vorläufigen Schlüssel stammen aus der Kette keyBetween(…, nil) ab nichts: Platz j ↦ Platz j ab `start`.
    const real = new Map<string, string>();
    let o: string | undefined, k: string | undefined = start;
    for (let j = 0; j <= m.rootKeys.length; j++) { o = keyBetween(o, undefined); k = keyBetween(k, undefined); real.set(o, k); }
    store.transact("Import", (tx) => {
      for (const rec of m.records) {
        const c = structuredClone(rec);
        if (c.kind === "block" && c.data.parent === "w") {
          c.data.parent = parent;
          c.data.sk = real.get(c.data.sk) ?? c.data.sk;
        }
        tx.put(c);
      }
    });
    r.pages += m.report.pages; r.databases += m.report.databases; r.rows += m.report.rows; r.assets += m.report.assets;
    r.warnings.push(...m.report.warnings);
    r.rootIDs.push(...m.report.rootIDs);
  }
  r.warnings.unshift(...prepared.notes);
  const seen = new Set<string>();
  r.warnings = r.warnings.filter((w) => (seen.has(w) ? false : (seen.add(w), true)));
  return r;
}

/** Vorbereiten und schreiben in einem Schritt (Swift `NotionImporter.importItems`). */
export function importNotionItems(store: WorkspaceStore, sources: ImportSource[], opts: NotionImportOptions = {}): ImportReport {
  const o: NotionImportOptions = { now: () => store.now(), userID: store.userID, ...opts };
  return commitPreparedImport(store, prepareImport(sources, o), o);
}

// MARK: Markdown & CSV (Swift `NotionImporter`, Pass 1 + 2)

const ATTACHMENTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "pdf", "svg", "mp4", "mov", "mp3", "m4a"]);
const PALETTE = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

class MarkdownNotionImporter {
  private ids = new Map<string, string>();
  private consumed = new Set<string>();
  private report = emptyReport();
  private records: WireRecord[] = [];
  private files!: ImportFiles;
  /** Datenbank-ID je CSV (Pfad ohne Endung und ohne „_all“) – vorab, damit Relationen auf sie zeigen können. */
  private dbIDs = new Map<string, string>();
  /** Notion-ID im Dateinamen → .md-Datei (Ziele von Relationen stehen in der CSV als „Titel (Pfad.md)“). */
  private byNotionID = new Map<string, string>();
  /** Die Quelle ist ein Notion-Export: .txt-Dateien in Ordnern sind dort Anhänge, keine Notizen. */
  private notionExport = false;
  private readonly now: () => number;
  private readonly userID: string | null;

  constructor(private readonly opts: NotionImportOptions) {
    this.now = opts.now ?? swiftNow;
    this.userID = opts.userID === undefined ? "me" : opts.userID;
  }

  private put(r: WireRecord) { this.records.push(r); }

  run(sources: ImportSource[]): { records: WireRecord[]; rootKeys: string[]; report: ImportReport } {
    const rootKeys: string[] = [];
    let key: string | undefined;
    for (const src of sources) {
      this.files = src.files;
      this.ids = new Map();
      this.dbIDs = new Map();
      this.byNotionID = new Map();
      this.consumed = new Set();
      const root = normalizePath(src.path);
      this.notionExport = isDir(this.files, root) && this.files.walk(root).some((f) => ["md", "csv"].includes(extname(f).toLowerCase()) && isNotionName(basename(stripExtension(f))));
      this.assignIDs(root);
      if (this.opts.isCancelled?.()) throw new ImportCancelled();
      key = keyBetween(key, undefined);
      rootKeys.push(key);
      const id = this.importItem(normalizePath(src.path), "w", key, rootKeys);
      if (id !== undefined) this.report.rootIDs.push(id);
    }
    return { records: this.records, rootKeys, report: this.report };
  }

  private assignIDs(p: string) {
    if (!this.files.exists(p)) return;
    if (isDir(this.files, p)) { for (const c of this.files.list(p)) this.assignIDs(c); }
    else if (NOTE_EXT.has(extname(p).toLowerCase()) || extname(p).toLowerCase() === "csv") {
      this.ids.set(p, makeRecordID());
      if (extname(p).toLowerCase() === "csv") { if (!this.dbIDs.has(dbKey(p))) this.dbIDs.set(dbKey(p), makeRecordID()); }
      else {
        const nid = notionIDInName(basename(stripExtension(p)));
        if (nid !== undefined && !this.byNotionID.has(nid)) this.byNotionID.set(nid, p);
      }
    }
  }

  /** Ein gewöhnlicher Ordner mit Notizen (kein Notion-Export-Ordner): wird eine Seite mit seinem Namen. */
  private isPlainFolder(dir: string): boolean {
    if (isNotionName(basename(dir))) return false;
    const kids = this.files.list(dir);
    // Ordner um Notion-Inhalt herum („Export-…“, Teamspace-Ordner) bleiben durchsichtig wie bisher.
    if (kids.some((k) => isNotionName(basename(isDir(this.files, k) ? k : stripExtension(k))))) return false;
    return this.files.walk(dir).some((f) => !hiddenPath(f.slice(dir.length + 1)) && (NOTE_EXT.has(extname(f).toLowerCase()) || extname(f).toLowerCase() === "csv"));
  }

  /** Ordner als Seite, sein Inhalt darunter. */
  private importFolder(dir: string, parent: string, sortKey: string): string {
    const id = makeRecordID();
    this.put({ kind: "block", data: makeBlock({ id, type: "page", parent, sk: sortKey, text: basename(dir), createdBy: this.userID }, this.now()) });
    this.report.pages += 1;
    this.appendItems(dir, "b:" + id, undefined);
    return id;
  }

  /** Einträge eines Ordners hinter `after` unter `parent` anlegen; gibt den letzten Sortierschlüssel zurück. */
  private appendItems(dir: string, parent: string, after: string | undefined): string | undefined {
    let key = after;
    for (const item of this.topLevelItems(dir)) {
      if (this.consumed.has(item)) continue;
      if (isDir(this.files, item)) {
        if (this.isPlainFolder(item)) { key = keyBetween(key, undefined); this.importFolder(item, parent, key); }
        else key = this.appendItems(item, parent, key);
        continue;
      }
      key = keyBetween(key, undefined);
      if (extname(item).toLowerCase() === "csv") this.importDatabase(item, parent, key, false);
      else this.importPage(item, parent, key);
    }
    return key;
  }

  private resolver(dir: string): (target: string) => string | undefined {
    return (target) => {
      if (target.includes("://")) return undefined;
      const decoded = removingPercentEncoding(target);
      if (decoded === undefined) return undefined;
      const u = joinPath(dir, decoded);
      const direct = this.ids.get(u);
      if (direct !== undefined) return direct;
      // HTML-Exporte verlinken Seiten, die Datenbanken wurden („.md“ → „.csv“).
      if (extname(u) === "md") { const id = this.ids.get(stripExtension(u) + ".csv"); if (id !== undefined) return id; }
      // CSV-Links neuerer Exporte zeigen auf „X.csv“, die Zeilen liegen in „X_all.csv“.
      if (extname(u) === "csv") return this.ids.get(joinPath(dirname(u), basename(stripExtension(u)) + "_all.csv"));
      return undefined;
    };
  }

  private importItem(p: string, parent: string, sortKey: string, rootKeys?: string[]): string | undefined {
    if (!this.files.exists(p)) return undefined;
    if (isDir(this.files, p)) {
      // Ein Export-Ordner: seine oberste Ebene unter `parent`.
      let key: string | undefined = sortKey;
      let first: string | undefined;
      for (const item of this.topLevelItems(p)) {
        let k = sortKey;
        if (first !== undefined) { k = keyBetween(key, undefined); rootKeys?.push(k); }
        key = k;
        const id = isDir(this.files, item) && this.isPlainFolder(item) ? this.importFolder(item, parent, k) : this.importItem(item, parent, k);
        if (id !== undefined && first === undefined) first = id;
      }
      return first;
    }
    const ext = extname(p).toLowerCase();
    if (ext === "md" || ext === "markdown" || ext === "txt") return this.importPage(p, parent, sortKey);
    if (ext === "csv") return this.importDatabase(p, parent, sortKey, false);
    if (UNREADABLE[ext] !== undefined && rootKeys !== undefined) { this.warn(`Skipped ${basename(p)}: ${UNREADABLE[ext]}`); return undefined; }
    if (ATTACHMENTS.has(ext)) return undefined; // Anhänge kommen mit der Seite, die sie verwendet
    this.report.warnings.push(`Skipped ${basename(p)} (not a Markdown, CSV, HTML or ZIP file)`);
    return undefined;
  }

  /** .md- und .csv-Dateien eines Ordners („X_all.csv“ vor „X.csv“), dann Ordner ohne passende Seite. */
  private topLevelItems(dir: string): string[] {
    const all = this.files.list(dir).sort((a, b) => comparePaths(basename(a), basename(b)));
    const names = new Set(all.map(basename));
    const out: string[] = [];
    for (const u of all) {
      if (isDir(this.files, u)) continue;
      const ext = extname(u).toLowerCase();
      if (hiddenPath(basename(u))) continue;
      if (ext === "md" || (!this.notionExport && NOTE_EXT.has(ext))) out.push(u);
      if (ext === "csv") {
        const base = basename(stripExtension(u));
        if (!base.endsWith("_all") && names.has(base + "_all.csv")) continue;
        out.push(u);
      }
    }
    for (const u of all) {
      if (!isDir(this.files, u)) continue;
      const n = basename(u);
      if (hiddenPath(n)) continue;
      if (!names.has(n + ".md") && !names.has(n + ".markdown") && !names.has(n + ".csv") && !names.has(n + "_all.csv") && !this.isAssetFolder(u)) out.push(u);
    }
    return out;
  }

  private isAssetFolder(u: string): boolean {
    const files = this.files.list(u);
    return files.length > 0 && files.every((f) => !NOTE_EXT.has(extname(f).toLowerCase()) && extname(f).toLowerCase() !== "csv" && !isDir(this.files, f));
  }

  private childFolder(file: string): string | undefined {
    let base = basename(stripExtension(file));
    if (base.endsWith("_all")) base = base.slice(0, -4);
    const dir = joinPath(dirname(file), base);
    return isDir(this.files, dir) ? dir : undefined;
  }

  private asset(src: string, dir: string): { url?: string; asset?: AssetRef } {
    if (src.includes("://")) return { url: src };
    const u = joinPath(dir, src);
    if (!this.files.isFile(u)) {
      if (this.opts.warnMissingFiles && looksLikeLocalFile(src)) this.warn(`Missing file “${u}” — it isn't in the import`);
      return { url: src };
    }
    if (!this.opts.assets) return { url: src };
    try {
      const files = this.files;
      const ref = importAssetFrom(this.opts.assets, { size: files.size(u) ?? 0, load: () => files.read(u) }, basename(u), mimeFor(extname(u)));
      if (!ref) {
        this.warn(`Couldn't read file “${u}”`);
        return { url: src };
      }
      this.report.assets += 1;
      return { asset: ref };
    } catch (e) {
      this.warn(e instanceof AssetRejected ? e.message : `Couldn't copy file ${basename(u)}`);
      return { url: src };
    }
  }

  private warn(w: string) {
    if (!this.report.warnings.includes(w)) this.report.warnings.push(w);
  }

  private putImported(item: MarkdownBlock, parent: string, sortKey: string) {
    const props: BlockProps = { ...item.props };
    if (item.type === "table" && props.tableColumns === undefined) props.tableColumns = 2;
    const id = makeRecordID();
    this.put({ kind: "block", data: makeBlock({ id, type: item.type, parent, sk: sortKey, text: toRichText(item.text), props, createdBy: this.userID }, this.now()) });
    const keys = keysBetween(item.children.length, undefined, undefined);
    item.children.forEach((c, i) => this.putImported(c, "b:" + id, keys[i]!));
  }

  private importPage(p: string, parent: string, sortKey: string, values: Record<string, PropertyValue> = {}, db?: Database, rowTitle?: string): string | undefined {
    if (this.consumed.has(p)) return undefined;
    // BSD-260 Teil 13: alte Markdown-Dateien sind oft Windows-1252 (oder UTF-16) – vorher fiel die Datei still weg.
    const text = this.files.readStrictText(p) ?? this.legacyText(p);
    if (text === undefined) return undefined;
    this.consumed.add(p);
    if (this.opts.isCancelled?.()) throw new ImportCancelled();
    // Prüfung Pass 37: YAML-Frontmatter (unser Export mit „Frontmatter“, Obsidian & Co.) nicht als Text übernehmen;
    // der Titel daraus zählt (die „# Titel“-Zeile danach fällt dann wie sonst weg).
    const fm = splitFrontmatter(text);
    const raw = fm.yaml !== undefined ? fm.body : text;
    const fmTitle = fm.yaml !== undefined ? yamlTitle(fm.yaml) : undefined;
    const id = this.ids.get(p) ?? makeRecordID();
    const dir = dirname(p);
    // `rowTitle`: Seite einer übersetzten Zeile – Titel steht in der Tabelle, der Inhalt bleibt, wie er ist
    const split = rowTitle !== undefined ? { title: rowTitle, body: raw } : MarkdownImporter.splitTitle(raw);
    let body = split.body;
    if (db && rowTitle === undefined) body = stripPropertyLines(body, db);
    const importer = new MarkdownImporter({ resolveLink: this.resolver(dir), resolveAsset: (src) => this.asset(src, dir) });
    let title = split.title ?? fmTitle ?? cleanTitle(basename(p));
    const props: BlockProps = {};
    const lead = leadingEmoji(title);
    if (lead && !db && lead[1] !== "") { props.icon = lead[0]; title = lead[1]; }
    this.put({ kind: "block", data: makeBlock({ id, type: "page", parent, sk: sortKey, text: title, props, values, createdBy: this.userID }, this.now()) });
    this.report.pages += 1;
    if (db) this.report.rows += 1;

    const blocks = importer.parse(body);
    const folder = this.childFolder(p);
    // Einzelne Links auf Dateien im Unterordner werden an Ort und Stelle die Unterseiten selbst.
    const keys = keysBetween(blocks.length, undefined, undefined);
    let lastKey: string | undefined;
    blocks.forEach((b, i) => {
      const k = keys[i]!;
      lastKey = k;
      const target = b.linkTarget;
      const decoded = target !== undefined ? removingPercentEncoding(target) : undefined;
      // Notion schreibt Lesezeichen und Einbettungen als Absatz „[https://…](https://…)“ – wieder ein Lesezeichen.
      if (target !== undefined && /^https?:\/\//i.test(target) && b.children.length === 0 && b.text.map((r) => r.t).join("").trim() === target) {
        this.putImported({ type: "bookmark", text: [], props: { url: target }, children: [] }, "b:" + id, k);
        return;
      }
      if (target !== undefined && decoded !== undefined && !target.includes("://")) {
        let u = joinPath(dir, decoded);
        if (extname(u).toLowerCase() === "md" && !this.files.isFile(u)) {
          const csv = stripExtension(u) + ".csv";
          if (this.files.isFile(csv)) u = csv;
        }
        const ext = extname(u).toLowerCase();
        // BSD-473: nur Dateien direkt im Unterordner dieser Seite sind ihre Kinder. Ein Link auf eine Seite oder
        // Datenbank anderswo (z. B. oben im Export) bleibt ein Link und wird später zur Erwähnung aufgelöst.
        const own = folder !== undefined && dirname(u) === folder;
        if (ext === "md" && own && this.files.isFile(u) && !this.consumed.has(u)) { this.importPage(u, "b:" + id, k); return; }
        if (ext === "csv" && own) {
          const all = joinPath(dirname(u), basename(stripExtension(u)) + "_all.csv");
          const pick = this.files.isFile(all) ? all : u;
          if (this.files.isFile(pick) && !this.consumed.has(pick)) { this.importDatabase(pick, "b:" + id, k, true); return; }
        }
        // Prüfung Pass 37: ein Absatz, der nur auf eine Datei im Import zeigt (so schreibt der Markdown-Export PDF- und
        // Datei-Blöcke), wird wieder ein Datei-Block mit der Datei – vorher blieb ein Link ins Leere.
        const kind = FILE_BLOCK_BY_EXT[ext] ?? (ext !== "" && !["md", "csv", "html", "htm"].includes(ext) ? "file" : undefined);
        if (kind && this.files.isFile(u) && !this.consumed.has(u)) {
          const label = b.text.map((r) => r.t).join("").trim();
          const props: BlockProps = { ...this.asset(decoded, dir) };
          if (label !== "" && label !== basename(u) && label !== decoded && label !== target) props.caption = label;
          this.putImported({ type: kind, text: [], props, children: [] }, "b:" + id, k);
          return;
        }
      }
      this.putImported(b, "b:" + id, k);
    });
    // Übrige Kinder im Ordner (vom Inhalt nicht verlinkt).
    // Auch Unterordner ohne eigene Seite: ihr Inhalt ging vorher verloren.
    if (folder !== undefined) this.appendItems(folder, "b:" + id, lastKey);
    return id;
  }

  /**
   * Relation in Notions CSV: „Titel (Ordner/Titel%20<id>.md), Titel 2 (….md)“. Zeigen die Ziele auf Zeilen EINER
   * Datenbank im Export, wird die Spalte eine Relation; sonst bleiben die Titel als Text (ohne Dateipfade).
   */
  private relationColumn(column: string[]): { kind: "relation"; databaseID: string; cells: (string[] | undefined)[] } | { kind: "names"; cells: string[] } | undefined {
    let any = false;
    const parsed: ({ title: string; path: string }[] | undefined)[] = [];
    for (const raw of column) {
      const v = trimSpaces(raw);
      if (v === "") { parsed.push(undefined); continue; }
      const items = relationItems(v);
      if (!items) return undefined;
      parsed.push(items);
      any = true;
    }
    if (!any) return undefined;
    const dbs = new Map<string, number>();
    const cells = parsed.map((items) => items?.map((it) => {
      const nid = notionIDInName(basename(stripExtension(removingPercentEncoding(it.path) ?? it.path)));
      const file = nid !== undefined ? this.byNotionID.get(nid) : undefined;
      const db = file !== undefined ? this.dbIDs.get(dirname(file)) : undefined;
      if (file === undefined || db === undefined) return undefined;
      dbs.set(db, (dbs.get(db) ?? 0) + 1);
      return { row: this.ids.get(file)!, db };
    }));
    const target = [...dbs].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (target === undefined) return { kind: "names", cells: parsed.map((items) => (items ?? []).map((it) => it.title).join(", ")) };
    return { kind: "relation", databaseID: target, cells: cells.map((c) => c?.filter((x): x is { row: string; db: string } => x !== undefined && x.db === target).map((x) => x.row)) };
  }

  /** Nicht-UTF-8-Text (UTF-16 mit BOM, Windows-1252); Binärdaten → undefined. */
  private legacyText(p: string): string | undefined {
    const d = this.files.read(p);
    return d === undefined ? undefined : decodeTextBytes(d)?.text;
  }

  private importDatabase(p: string, parent: string, sortKey: string, inline: boolean): string | undefined {
    if (this.consumed.has(p)) return undefined;
    // BSD-260 Teil 13: CSV aus Excel unter Windows ist oft Windows-1252 (oder UTF-16) – vorher fiel die Datei still weg.
    const raw = this.files.readStrictText(p) ?? this.legacyText(p);
    if (raw === undefined) return undefined;
    this.consumed.add(p);
    // „X.csv“ neben „X_all.csv“ ist dieselbe Datenbank.
    const base = basename(stripExtension(p));
    if (base.endsWith("_all")) this.consumed.add(joinPath(dirname(p), base.slice(0, -4) + ".csv"));
    let table = decodeCSV(raw);
    // BSD-260 Teil 13: nur eine Spalte mit Komma → anderes Trennzeichen (Semikolon aus deutschem Excel, Tab, |)?
    // Notion-Exporte haben immer Kommas und mehr als eine Spalte; die bleiben unverändert.
    if ((table[0]?.length ?? 0) === 1) {
      const d = sniffDelimiter(raw);
      if (d !== ",") table = parseDelimited(raw, d).rows;
    }
    // Prüfung Pass 37: von unserem Export gegen Formel-Injection geschützte Zellen („'=…“) wieder wie im Original.
    table = table.map((r) => r.map(unguardCSVFormula));
    let header = table[0];
    if (!header || header.length === 0) return undefined;
    let rows = table.slice(1);
    // Übersetzte Exporte anderer Apps (foreign/table.ts): Typangabe im Kopf („Tags\u0000multiSelect“) und eine letzte
    // Spalte mit dem Pfad der Seite je Zeile. In echten CSV-Dateien kommt das Zeichen nicht vor.
    const hints = header.map((h) => (h.includes(HINT) ? h.slice(h.indexOf(HINT) + 1) : undefined));
    let pageOf: (string | undefined)[] | undefined;
    if (hints.some((h) => h !== undefined)) {
      const fileCol = header.indexOf(FILE_COLUMN);
      if (fileCol >= 0) {
        pageOf = rows.map((r) => (r[fileCol] ? joinPath(dirname(p), r[fileCol]!) : undefined));
        rows = rows.map((r) => r.filter((_, i) => i !== fileCol));
        hints.splice(fileCol, 1);
      }
      header = header.filter((_, i) => i !== fileCol).map((h) => (h.includes(HINT) ? h.slice(0, h.indexOf(HINT)) : h));
    }
    const blockID = this.ids.get(p) ?? makeRecordID();
    const now = this.now();

    const props: PropertySchema[] = [{ id: "title", name: header[0] === "" ? "Name" : header[0]!, type: "title" }];
    /** Spalte → je Zeile die Ziel-Zeilen (Relation) bzw. der bereinigte Text. */
    const relations = new Map<number, (string[] | undefined)[]>();
    const cleaned = new Map<number, string[]>();
    header.forEach((name, ci) => {
      if (ci === 0) return;
      const column = rows.map((r) => (ci < r.length ? r[ci]! : ""));
      const hint = hints[ci];
      const rel = hint === undefined ? this.relationColumn(column) : undefined;
      if (rel?.kind === "relation") {
        relations.set(ci, rel.cells);
        props.push({ id: makeRecordID(), name: name === "" ? `Column ${ci}` : name, type: "relation", relation: { databaseID: rel.databaseID } });
        return;
      }
      if (rel?.kind === "names") {
        // Ziele nicht im Export: die Titel als Text, ohne die Dateipfade
        cleaned.set(ci, rel.cells);
        props.push({ id: makeRecordID(), name: name === "" ? `Column ${ci}` : name, type: "text" });
        return;
      }
      const prop: PropertySchema = { id: makeRecordID(), name: name === "" ? `Column ${ci}` : name, type: (hint ?? inferCSVType(name, column)) as PropertySchema["type"] };
      const nf = hint !== undefined || prop.type === "number" ? undefined : csvNumberFormat(column);
      if (nf !== undefined) { prop.type = "number"; prop.numberFormat = nf as never; }
      if (prop.type === "select" || prop.type === "multiSelect" || prop.type === "status") {
        const options: NonNullable<PropertySchema["options"]> = [];
        for (const v of column) {
          const tokens = prop.type === "multiSelect" ? v.split(",").filter((s) => s.length > 0).map(trimSpaces) : [trimSpaces(v)];
          for (const t of tokens) {
            if (t !== "" && !options.some((o) => o.name === t)) options.push({ id: makeRecordID(), name: t, color: PALETTE[options.length % PALETTE.length] as never });
          }
        }
        prop.options = options;
        if (prop.type === "status") prop.statusGroups = [{ id: makeRecordID(), name: "To-do", color: "gray", optionIDs: options.map((o) => o.id) }];
      }
      if (prop.type === "uniqueID") prop.idPrefix = uniqueIDPrefix(column.map(trimSpaces).filter((v) => v !== ""))!;
      props.push(prop);
    });
    const db: Database = { id: this.dbIDs.get(dbKey(p)) ?? makeRecordID(), blockID, title: cleanTitle(basename(p)), properties: props, createdAt: now, updatedAt: now, stamp: { ...ZERO_STAMP } };
    // BSD-487: neue Zeilen zählen nach der höchsten importierten Unique-ID weiter (wie der Notion-HTML-Import).
    props.forEach((prop, ci) => {
      if (prop.type !== "uniqueID") return;
      const max = Math.max(0, ...rows.map((r) => Number(UNIQUE_ID.exec(trimSpaces(r[ci] ?? ""))?.[2] ?? 0)));
      if (max > 0) db.nextUniqueID = Math.max(db.nextUniqueID ?? 0, max + 1);
    });
    this.put({ kind: "database", data: db });
    const view: DatabaseView = { id: makeRecordID(), databaseID: db.id, blockID, name: "Table", type: "table", sortKey: keyBetween(undefined, undefined), createdAt: now, updatedAt: now, stamp: { ...ZERO_STAMP } };
    this.put({ kind: "view", data: view });
    this.put({ kind: "block", data: makeBlock({ id: blockID, type: inline ? "databaseInline" : "databasePage", parent, sk: sortKey, props: { databaseID: db.id, viewIDs: [view.id] }, createdBy: this.userID }, now) });
    this.report.databases += 1;

    // Zeilenseiten mit Inhalt liegen im Ordner neben der CSV.
    const rowFiles = new Map<string, string[]>();
    const folder = this.childFolder(p);
    if (folder !== undefined) {
      for (const f of this.files.list(folder).sort(comparePaths)) {
        if (extname(f).toLowerCase() !== "md" || isDir(this.files, f)) continue;
        const k = cleanTitle(basename(f));
        rowFiles.set(k, [...(rowFiles.get(k) ?? []), f]);
      }
    }
    const keys = keysBetween(rows.length, undefined, undefined);
    rows.forEach((r, ri) => {
      const k = keys[ri]!;
      const values: Record<string, PropertyValue> = {};
      props.forEach((prop, ci) => {
        if (ci === 0 || ci >= r.length) return;
        const related = relations.get(ci);
        if (related) { const ids = related[ri]; if (ids && ids.length > 0) values[prop.id] = ev("relation", ids); return; }
        const v = parseCSVValue(cleaned.get(ci)?.[ri] ?? r[ci]!, prop);
        if (v !== undefined) values[prop.id] = v;
      });
      const rowTitle = r[0] ?? "";
      const own = pageOf?.[ri];
      if (own !== undefined && this.files.isFile(own) && this.importPage(own, "d:" + db.id, k, values, db, rowTitle) !== undefined) return;
      const files = rowFiles.get(markdownFileName(rowTitle)) ?? rowFiles.get(rowTitle);
      if (files && files.length > 0) {
        const f = files[0]!;
        rowFiles.set(markdownFileName(rowTitle), files.slice(1));
        if (this.importPage(f, "d:" + db.id, k, values, db) !== undefined) return;
      }
      this.put({ kind: "block", data: makeBlock({ id: makeRecordID(), type: "page", parent: "d:" + db.id, sk: k, text: rowTitle, values, createdBy: this.userID }, now) });
      this.report.rows += 1;
    });
    return blockID;
  }
}

/** Notizen im Markdown-Import. */
const NOTE_EXT = new Set(["md", "markdown", "txt"]);
/** Name aus einem Notion-Export: „Titel <32 hex>“ (auch „…_all“). Ein bloßer Hash („d41d8c….png“) zählt nicht. */
const isNotionName = (stem: string) => /\s[0-9a-f]{32}(_all)?$/i.test(stem);
/** Punkt-Dateien und -Ordner (.DS_Store, .git, .obsidian …). */
const hiddenPath = (rel: string) => rel.split("/").some((part) => part.startsWith("."));
/** Schlüssel einer CSV-Datenbank: Pfad ohne Endung und ohne „_all“ (= der Ordner ihrer Zeilenseiten). */
const dbKey = (csv: string) => joinPath(dirname(csv), basename(stripExtension(csv)).replace(/_all$/i, ""));

/** „A (x/A%20<id>.md), B (y/B%20<id>.md)“ → Einträge; `undefined`, wenn die Zelle nicht ganz so aufgebaut ist. */
function relationItems(cell: string): { title: string; path: string }[] | undefined {
  const out: { title: string; path: string }[] = [];
  const re = /(.+?) \(([^\n]*?\.md)\)(?:, |$)/gy;
  let at = 0;
  while (at < cell.length) {
    re.lastIndex = at;
    const m = re.exec(cell);
    if (!m) return undefined;
    out.push({ title: m[1]!, path: m[2]! });
    at = re.lastIndex;
  }
  return out.length > 0 ? out : undefined;
}

/** Zahlenformat einer Spalte, deren Werte alle Währung oder Prozent sind („$1,200.00“, „12,5 €“, „50%“). */
function csvNumberFormat(column: string[]): string | undefined {
  const v = column.map(trimSpaces).filter((x) => x !== "");
  if (v.length === 0) return undefined;
  const SYM: [string, string][] = [["R$", "real"], ["CHF", "franc"], ["$", "dollar"], ["€", "euro"], ["£", "pound"], ["¥", "yen"], ["₹", "rupee"], ["₩", "won"], ["₽", "ruble"], ["₺", "lira"]];
  const num = "-?\\d[\\d,]*(?:\\.\\d+)?";
  if (v.every((x) => new RegExp(`^${num} ?%$`).test(x))) return "percent";
  for (const [sym, f] of SYM) {
    const q = sym.replace(/[$]/g, "\\$");
    if (v.every((x) => new RegExp(`^-?${q} ?${num}$|^${num} ?${q}$`).test(x))) return f;
  }
  return undefined;
}

/** Erstes Zeichen als Icon, wenn es ein Emoji in Emoji-Darstellung ist (Swift `leadingEmoji`). */
export function leadingEmoji(s: string): [string, string] | undefined {
  const c = graphemes(s)[0];
  const scalar = c?.codePointAt(0);
  if (c === undefined || scalar === undefined || !/\p{Emoji_Presentation}/u.test(String.fromCodePoint(scalar))) return undefined;
  return [c, trimSpaces(s.slice(c.length))];
}

/** Zeilenseiten wiederholen ihre Properties als „Name: Wert“ unter dem Titel. */
function stripPropertyLines(body: string, db: Database): string {
  const lines = body.split("\n");
  while (lines.length > 0 && trimSpaces(lines[0]!) === "") lines.shift();
  let n = 0;
  for (const l of lines) {
    const colon = l.indexOf(": ");
    if (colon < 0) break;
    const name = l.slice(0, colon);
    if (!db.properties.some((p) => p.name.toLowerCase() === name.toLowerCase())) break;
    n += 1;
  }
  return lines.slice(n).join("\n");
}

const isSwiftDouble = (s: string) => parseSwiftDouble(s) !== undefined;

/** Property-Typ einer CSV-Spalte (Swift `NotionImporter.inferType`). */
export function inferCSVType(name: string, column: string[]): string {
  const values = column.map(trimSpaces).filter((v) => v !== "");
  const lname = name.toLowerCase();
  if (lname === "status") return "status";
  if (values.length === 0) return "text";
  if (values.every((v) => v === "Yes" || v === "No")) return "checkbox";
  if (values.every((v) => isSwiftDouble(v.replaceAll(",", "")))) return "number";
  // BSD-487/543: Unique-ID nur, wenn die Spalte so heißt („ID“, „Task ID“ – Notions Standardname; dann auch mit leeren
  // Zellen) oder mindestens drei Zeilen dicht nummeriert sind. Sonst würde eine Textspalte mit „COVID-19“ oder
  // „JIRA-12, JIRA-40“ eine gesperrte Nummernspalte, die nicht mehr bearbeitbar ist und selbst weiterzählt.
  if (/\bid\b/i.test(name) ? uniqueIDPrefix(values) !== undefined : values.length === column.length && denseUniqueIDs(values)) return "uniqueID";
  if (values.every((v) => parseDate(v) !== undefined)) return "date";
  if (values.every((v) => v.startsWith("http://") || v.startsWith("https://"))) return "url";
  if (values.every((v) => v.includes("@") && v.includes(".") && !v.includes(" "))) return "email";
  if (values.some((v) => v.includes(".md)"))) return "text";
  const tokens = values.flatMap((v) => v.split(",").filter((s) => s.length > 0).map(trimSpaces));
  const unique = new Set(tokens);
  const short = tokens.every((t) => graphemes(t).length <= 40);
  if (short && values.some((v) => v.includes(", ")) && (unique.size < tokens.length || lname.includes("tag"))) return "multiSelect";
  if (short && unique.size <= Math.max(1, Math.floor(values.length / 2)) && values.length >= 2) return "select";
  if (lname.includes("tag") && short) return "multiSelect";
  return "text";
}

const UNIQUE_ID = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/;

/** BSD-543: ohne „ID“ im Namen: mindestens 3 Werte mit gemeinsamem Präfix, Nummern dicht (Spanne ≤ doppelte Anzahl). */
function denseUniqueIDs(values: string[]): boolean {
  if (values.length < 3 || uniqueIDPrefix(values) === undefined) return false;
  const nums = values.map((v) => Number(UNIQUE_ID.exec(v)![2]));
  return Math.max(...nums) - Math.min(...nums) + 1 <= 2 * values.length;
}

/** BSD-487: Präfix einer Unique-ID-Spalte („TASK-1“, „TASK-2“ …) – alle Werte mit demselben Präfix, keine Nummer doppelt.
 *  So schreiben unser Markdown-Export und Notions CSV-Export die Eigenschaft; sonst `undefined`. */
export function uniqueIDPrefix(values: string[]): string | undefined {
  let prefix: string | undefined;
  const seen = new Set<number>();
  for (const v of values) {
    const m = UNIQUE_ID.exec(v);
    if (!m) return undefined;
    if (prefix !== undefined && m[1] !== prefix) return undefined;
    prefix = m[1]!;
    const n = Number(m[2]);
    if (seen.has(n)) return undefined;
    seen.add(n);
  }
  return prefix;
}

const optionNamed = (p: PropertySchema, name: string) => p.options?.find((o) => o.name.toLowerCase() === name.toLowerCase());
const ev = (kind: string, v: unknown): PropertyValue => ({ [kind]: { _0: v } }) as PropertyValue;

/** Wert einer CSV-Zelle (Swift `NotionImporter.parseValue`). */
export function parseCSVValue(raw: string, p: PropertySchema): PropertyValue | undefined {
  const s = trimSpaces(raw);
  if (s === "") return p.type === "checkbox" ? ev("checkbox", false) : undefined;
  switch (p.type) {
    case "number": {
      const n = p.numberFormat !== undefined && p.numberFormat !== "number" ? parseNotionNumber(s.replace(/[^\d.,%eE+-]/g, "").replaceAll(",", "")) : parseSwiftDouble(s.replaceAll(",", ""));
      return n === undefined ? undefined : ev("number", n);
    }
    case "checkbox": return ev("checkbox", s === "Yes");
    case "date": { const d = parseDate(s); return d ? ev("date", d) : undefined; }
    case "url": return ev("url", s);
    case "email": return ev("email", s);
    case "uniqueID": { const m = UNIQUE_ID.exec(s); return m ? ev("uniqueID", Number(m[2])) : undefined; }
    case "select": case "status": { const o = optionNamed(p, s); return o ? ev(p.type, o.id) : undefined; }
    case "multiSelect": {
      const ids = s.split(",").filter((x) => x.length > 0).map((x) => optionNamed(p, trimSpaces(x))?.id).filter((x): x is string => x !== undefined);
      return ids.length === 0 ? undefined : ev("multiSelect", ids);
    }
    default: return ev("text", s);
  }
}

export type { Block };

/** `title:` aus YAML-Frontmatter (einfacher Wert oder in Anführungszeichen, wie unser Export ihn schreibt). */
function yamlTitle(yaml: string): string | undefined {
  const m = /^title:[ \t]*(.*)$/m.exec(yaml);
  if (!m) return undefined;
  const v = m[1]!.trim();
  if (v.startsWith('"')) { try { return JSON.parse(v) as string; } catch { return v.slice(1, -1); } }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replaceAll("''", "'");
  return v === "" ? undefined : v;
}
