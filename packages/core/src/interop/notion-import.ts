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
import { AssetRejected, commitImport, emptyReport, ImportBuilder, looksLikeLocalFile, makeBlock, makeRecordID, mimeFor, type AssetRef, type AssetSink, type ImportBuilderWire, type ImportReport } from "./builder.js";
import { basename, comparePaths, dirname, extname, ImportFiles, joinPath, normalizePath, stripExtension } from "./files.js";
import { graphemes, trimSpaces } from "./html.js";
import { removingPercentEncoding } from "./importids.js";
import { decodeCSV, MarkdownImporter, type MarkdownBlock } from "./markdown.js";
import { cleanTitle, NotionHTMLImporter } from "./notion-html.js";
import { toRichText } from "./runs.js";
import { extractZip, ImportCancelled, isZip, type ZipLimits } from "./zip.js";
import { markdownFileName } from "./markdown-export.js";
import { findObsidianVault, ObsidianImporter } from "./obsidian-import.js";
import { EnexImporter } from "./enex-import.js";
import { importOPML } from "./opml.js";
import { DocxImporter } from "./docx-import.js";

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
  const vaults: { files: ImportFiles; vault: string; title: string | undefined }[] = [];
  // BSD-260: Evernote-Notizbücher (.enex), Gliederungen (.opml) und Word-Dokumente (.docx), auch in ZIPs und Ordnern.
  const enex: { files: ImportFiles; path: string }[] = [];
  const enexIn = (files: ImportFiles, dir: string) => files.walk(dir).filter((f) => ["enex", "opml", "docx"].includes(extname(f).toLowerCase()));
  sources.forEach((src, i) => {
    const p = normalizePath(src.path);
    const ext = extname(p).toLowerCase();
    const exists = src.files.exists(p);
    // BSD-254: das ZIP nicht ganz laden – als Quelle (im Worker: die gewählte Datei) lesen
    const zip = src.files.isFile(p) ? src.files.source(p) : undefined;
    if (zip && (ext === "zip" || (ext === "" && isZip(zip.read(0, Math.min(4, zip.size)))))) {
      const r = extractZip(zip, { limits: opts.zipLimits, isCancelled: opts.isCancelled, progress: (f) => progress((i + f * 0.5) / sources.length) });
      out.notes.push(`Unpacked ${basename(p)}: ${r.count} files`);
      for (const s of r.skipped) out.notes.push(`Skipped ${s}`);
      const notebooks = enexIn(r.files, "");
      if (notebooks.length > 0 && !containsExt(r.files, "", ["md", "csv", "html", "htm"])) {
        for (const f of notebooks) enex.push({ files: r.files, path: f });
        progress((i + 1) / sources.length * 0.5);
        return;
      }
      const vault = findObsidianVault(r.files, "");
      if (vault !== undefined) {
        vaults.push({ files: r.files, vault, title: vault === "" ? stripExtension(basename(p)) : undefined });
        progress((i + 1) / sources.length * 0.5);
        return;
      }
      const hasHTML = containsExt(r.files, "", ["html", "htm"]);
      if (hasHTML) html.push({ files: r.files, path: "" });
      if (containsExt(r.files, "", ["md", "csv"]) || !hasHTML) md.push({ files: r.files, path: "" });
    } else if (exists && (ext === "enex" || ext === "opml" || ext === "docx")) {
      enex.push({ files: src.files, path: p });
    } else if (exists && isDir(src.files, p) && enexIn(src.files, p).length > 0 && !containsExt(src.files, p, ["md", "csv", "html", "htm"])) {
      for (const f of enexIn(src.files, p)) enex.push({ files: src.files, path: f });
    } else if (exists && isDir(src.files, p) && findObsidianVault(src.files, p) !== undefined) {
      vaults.push({ files: src.files, vault: findObsidianVault(src.files, p)!, title: undefined });
    } else if (exists && isDir(src.files, p) && containsExt(src.files, p, ["html", "htm"])) {
      html.push({ files: src.files, path: p });
      if (containsExt(src.files, p, ["md", "csv"])) md.push({ files: src.files, path: p });
    } else if (exists && (ext === "html" || ext === "htm")) {
      html.push({ files: src.files, path: p });
    } else {
      md.push({ files: src.files, path: p });
    }
    progress((i + 1) / sources.length * 0.5);
  });
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
  if (md.length > 0) out.markdown = new MarkdownNotionImporter(opts).run(md);
  const extra: (() => { records: WireRecord[]; rootKeys: string[]; report: ImportReport })[] = [];
  const common = { assets: opts.assets, now: opts.now, userID: opts.userID, isCancelled: opts.isCancelled };
  for (const v of vaults) extra.push(() => new ObsidianImporter(v.files, v.vault, common).run(v.title, out.markdown?.rootKeys.at(-1)));
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
      prev.records.push(...r.records);
      prev.rootKeys.push(...r.rootKeys);
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
      this.consumed = new Set();
      this.assignIDs(normalizePath(src.path));
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
    else if (["md", "csv"].includes(extname(p).toLowerCase())) this.ids.set(p, makeRecordID());
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
        const id = this.importItem(item, parent, k);
        if (id !== undefined && first === undefined) first = id;
      }
      return first;
    }
    const ext = extname(p).toLowerCase();
    if (ext === "md" || ext === "markdown" || ext === "txt") return this.importPage(p, parent, sortKey);
    if (ext === "csv") return this.importDatabase(p, parent, sortKey, false);
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
      if (ext === "md") out.push(u);
      if (ext === "csv") {
        const base = basename(stripExtension(u));
        if (!base.endsWith("_all") && names.has(base + "_all.csv")) continue;
        out.push(u);
      }
    }
    for (const u of all) {
      if (!isDir(this.files, u)) continue;
      const n = basename(u);
      if (!names.has(n + ".md") && !names.has(n + ".csv") && !names.has(n + "_all.csv") && !this.isAssetFolder(u)) out.push(u);
    }
    return out;
  }

  private isAssetFolder(u: string): boolean {
    const files = this.files.list(u);
    return files.length > 0 && files.every((f) => !["md", "csv"].includes(extname(f).toLowerCase()) && !isDir(this.files, f));
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
    const data = this.files.read(u);
    if (!data) {
      this.warn(`Couldn't read file “${u}”`);
      return { url: src };
    }
    try {
      const ref = this.opts.assets.importData(data, basename(u), mimeFor(extname(u)));
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

  private importPage(p: string, parent: string, sortKey: string, values: Record<string, PropertyValue> = {}, db?: Database): string | undefined {
    if (this.consumed.has(p)) return undefined;
    const raw = this.files.readStrictText(p);
    if (raw === undefined) return undefined;
    this.consumed.add(p);
    if (this.opts.isCancelled?.()) throw new ImportCancelled();
    const id = this.ids.get(p) ?? makeRecordID();
    const dir = dirname(p);
    const split = MarkdownImporter.splitTitle(raw);
    let body = split.body;
    if (db) body = stripPropertyLines(body, db);
    const importer = new MarkdownImporter({ resolveLink: this.resolver(dir), resolveAsset: (src) => this.asset(src, dir) });
    let title = split.title ?? cleanTitle(basename(p));
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
      if (target !== undefined && decoded !== undefined && !target.includes("://")) {
        let u = joinPath(dir, decoded);
        if (extname(u).toLowerCase() === "md" && !this.files.isFile(u)) {
          const csv = stripExtension(u) + ".csv";
          if (this.files.isFile(csv)) u = csv;
        }
        const ext = extname(u).toLowerCase();
        if (ext === "md" && this.files.isFile(u) && !this.consumed.has(u)) { this.importPage(u, "b:" + id, k); return; }
        if (ext === "csv") {
          const all = joinPath(dirname(u), basename(stripExtension(u)) + "_all.csv");
          const pick = this.files.isFile(all) ? all : u;
          if (this.files.isFile(pick) && !this.consumed.has(pick)) { this.importDatabase(pick, "b:" + id, k, true); return; }
        }
      }
      this.putImported(b, "b:" + id, k);
    });
    // Übrige Kinder im Ordner (vom Inhalt nicht verlinkt).
    if (folder !== undefined) {
      for (const item of this.topLevelItems(folder)) {
        if (this.consumed.has(item)) continue;
        lastKey = keyBetween(lastKey, undefined);
        if (isDir(this.files, item)) continue;
        if (extname(item).toLowerCase() === "csv") this.importDatabase(item, "b:" + id, lastKey, false);
        else this.importPage(item, "b:" + id, lastKey);
      }
    }
    return id;
  }

  private importDatabase(p: string, parent: string, sortKey: string, inline: boolean): string | undefined {
    if (this.consumed.has(p)) return undefined;
    const raw = this.files.readStrictText(p);
    if (raw === undefined) return undefined;
    this.consumed.add(p);
    // „X.csv“ neben „X_all.csv“ ist dieselbe Datenbank.
    const base = basename(stripExtension(p));
    if (base.endsWith("_all")) this.consumed.add(joinPath(dirname(p), base.slice(0, -4) + ".csv"));
    const table = decodeCSV(raw);
    const header = table[0];
    if (!header || header.length === 0) return undefined;
    const rows = table.slice(1);
    const blockID = this.ids.get(p) ?? makeRecordID();
    const now = this.now();

    const props: PropertySchema[] = [{ id: "title", name: header[0] === "" ? "Name" : header[0]!, type: "title" }];
    header.forEach((name, ci) => {
      if (ci === 0) return;
      const column = rows.map((r) => (ci < r.length ? r[ci]! : ""));
      const prop: PropertySchema = { id: makeRecordID(), name: name === "" ? `Column ${ci}` : name, type: inferCSVType(name, column) as PropertySchema["type"] };
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
      props.push(prop);
    });
    const db: Database = { id: makeRecordID(), blockID, title: cleanTitle(basename(p)), properties: props, createdAt: now, updatedAt: now, stamp: { ...ZERO_STAMP } };
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
        const v = parseCSVValue(r[ci]!, prop);
        if (v !== undefined) values[prop.id] = v;
      });
      const rowTitle = r[0] ?? "";
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

const optionNamed = (p: PropertySchema, name: string) => p.options?.find((o) => o.name.toLowerCase() === name.toLowerCase());
const ev = (kind: string, v: unknown): PropertyValue => ({ [kind]: { _0: v } }) as PropertyValue;

/** Wert einer CSV-Zelle (Swift `NotionImporter.parseValue`). */
export function parseCSVValue(raw: string, p: PropertySchema): PropertyValue | undefined {
  const s = trimSpaces(raw);
  if (s === "") return p.type === "checkbox" ? ev("checkbox", false) : undefined;
  switch (p.type) {
    case "number": { const n = parseSwiftDouble(s.replaceAll(",", "")); return n === undefined ? undefined : ev("number", n); }
    case "checkbox": return ev("checkbox", s === "Yes");
    case "date": { const d = parseDate(s); return d ? ev("date", d) : undefined; }
    case "url": return ev("url", s);
    case "email": return ev("email", s);
    case "select": case "status": { const o = optionNamed(p, s); return o ? ev(p.type, o.id) : undefined; }
    case "multiSelect": {
      const ids = s.split(",").filter((x) => x.length > 0).map((x) => optionNamed(p, trimSpaces(x))?.id).filter((x): x is string => x !== undefined);
      return ids.length === 0 ? undefined : ev("multiSelect", ids);
    }
    default: return ev("text", s);
  }
}

export type { Block };
