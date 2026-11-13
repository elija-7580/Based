// Notion-„HTML“-Export (entpacktes ZIP, Ordner oder einzelne .html-Dateien) mit voller Treue einlesen.
// Port von Swift BasedCore Interop/NotionHTMLImport.swift. Clean-Room: nur das öffentlich dokumentierte Exportformat.
//
// Anders als der Markdown-Export trägt der HTML-Export Block-IDs, Farben, Callout-Icons, Toggles und Toggle-
// Überschriften, Spaltenbreiten, Bildunterschriften, Bildgrößen, Seiten-Icons/-Cover/-Schriften, typisierte
// Datenbank-Properties (Zeilenseiten nennen jede Property mit Typ) und Auswahlfarben. Alles wird auf eigene Blöcke
// abgebildet; Markup ohne Gegenstück bleibt als HTML-Block (Code-Block mit Vorschau) erhalten.
//
// Statt des Dateisystems liest der Port aus einem `ImportFiles`-Baum; Fortschritt und Abbruch für einen Worker.
import type { Block, BlockProps, Database, DatabaseView, PropertySchema, PropertyValue, RichText } from "../model/records.js";
import { parseDate, parseSwiftDouble } from "../query/value.js";
import { FIRST_KEY } from "../sortkeys.js";
import { ZERO_STAMP } from "../hlc.js";
import { firstGrapheme } from "../graphemes.js";
import { type AssetRef, type ImportBuilder, looksLikeLocalFile, makeBlock } from "./builder.js";
import { notionColor } from "./clipboard.js";
import { basename, comparePaths, dirname, extname, type ImportFiles, joinPath, normalizePath, stripExtension } from "./files.js";
import { collapse, HTMLNode, parseHTML, trimSpaces, trimWS } from "./html.js";
import { derivedID, notionIDInName, notionUUID, removingPercentEncoding } from "./importids.js";
import { normalize, PLAIN, plain, slice, toRichText, isAtomic, type Marks, type Run } from "./runs.js";
import { ImportCancelled } from "./zip.js";

const TITLE_PROPERTY_ID = "title";

// MARK: Hilfen

/** „Project Plan 1a2b…(32 hex)“ → „Project Plan“ (Swift `NotionImporter.cleanTitle`). */
export function cleanTitle(name: string): string {
  let base = name;
  for (const ext of [".md", ".csv"]) if (base.toLowerCase().endsWith(ext)) base = base.slice(0, -ext.length);
  if (base.endsWith("_all")) base = base.slice(0, -4);
  return trimSpaces(base.replace(/\s+[0-9a-f]{32}$/i, ""));
}

/** Erstes Zeichen als Emoji-Icon, wenn es kein Markup ist (Swift `PageIcon.importedEmoji`, BSD-35). */
export function importedEmoji(raw: string): string | undefined {
  const t = trimWS(raw);
  const first = firstGrapheme(t);
  if (first === undefined || first.includes("<") || first.includes(">") || first.includes("&")) return undefined;
  return first;
}

/** Leerraum an den Text-Enden entfernen (Swift `RichText.trimmed()`). */
export function trimRuns(runs: Run[]): Run[] {
  const out = runs.map((r) => ({ ...r }));
  while (out.length > 0 && !isAtomic(out[0]!)) {
    const t = out[0]!.t.replace(/^[ \n\t]+/, "");
    if (t === "") out.shift(); else { out[0]!.t = t; break; }
  }
  while (out.length > 0 && !isAtomic(out[out.length - 1]!)) {
    const t = out[out.length - 1]!.t.replace(/[ \n\t]+$/, "");
    if (t === "") out.pop(); else { out[out.length - 1]!.t = t; break; }
  }
  return out;
}

const runsLen = (runs: Run[]) => runs.reduce((n, r) => n + r.t.length, 0);
const isEmptyRuns = (runs: Run[]) => runsLen(runs) === 0;

/** Swift `RichText.applying(0, length) { … }` über alle Läufe. */
export function applyMarks(runs: Run[], f: (m: Marks) => void): Run[] {
  const len = runsLen(runs);
  if (len === 0) return runs;
  return normalize(slice(runs, 0, len).map((r) => { const m = { ...r.m }; f(m); return { ...r, m }; }));
}

const textRuns = (s: string): Run[] => (s ? [{ t: s, m: PLAIN }] : []);

/** Swift `URL(string:)?.host` (nur absolute URLs). */
function urlHost(href: string): string | undefined {
  try { return new URL(href).host.toLowerCase().replace(/:\d+$/, ""); } catch { return undefined; }
}
function urlPath(href: string): string | undefined {
  try { return new URL(href).pathname; } catch { return undefined; }
}
/** Endung eines Links ohne Query/Fragment (Swift `URL(string:)?.pathExtension ?? NSString.pathExtension`). */
function linkExtension(href: string): string {
  if (/\s/.test(href)) return extname(href).toLowerCase();
  const i = href.search(/[?#]/);
  const path = i >= 0 ? href.slice(0, i) : href;
  const abs = path.includes("://") ? (urlPath(path) ?? path) : path;
  return extname(abs).toLowerCase();
}

function base64Decode(s: string): Uint8Array | undefined {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, "");
  try {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

const caseInsensitiveEqual = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0 && a.toLowerCase() === b.toLowerCase();
const propertyNamed = (db: { properties: PropertySchema[] }, name: string) => db.properties.find((p) => caseInsensitiveEqual(p.name, name));
const optionNamed = (p: PropertySchema, name: string) => p.options?.find((o) => caseInsensitiveEqual(o.name, name));

const enumValue = <T>(kind: string, v: T): PropertyValue => ({ [kind]: { _0: v } }) as PropertyValue;

// MARK: Importer

interface Ctx {
  /** Ordner der aktuellen .html-Datei (Links sind relativ dazu). */
  dir: string;
  file: string;
  pageID: string;
  counter: number;
  /** Notion-Markup (pre-wrap) statt allgemeinem HTML (Leerraum fällt zusammen). */
  notion: boolean;
}

const newCtx = (dir: string, file: string, pageID: string): Ctx => ({ dir, file, pageID, counter: 0, notion: true });

interface Column { name: string; hint: string | undefined; cellClass?: string | undefined; rowType: Map<string, number> }
interface RowSource {
  id: string;
  title: Run[];
  cells: Map<string, HTMLNode>;
  cellDirs: Map<string, string>;
  file: string | undefined;
  doc: HTMLNode | undefined;
  icon: BlockProps["icon"] | undefined;
}

const INLINE_TAGS = new Set(["", "a", "span", "strong", "b", "em", "i", "u", "s", "del", "strike", "code", "mark", "sub", "sup",
  "small", "big", "time", "br", "abbr", "cite", "kbd", "q", "label", "font", "wbr"]);
const SKIP_TAGS = new Set(["style", "script", "meta", "link", "title", "head", "noscript", "template"]);
const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "webm", "avi", "mkv"]);
const AUDIO_EXT = new Set(["mp3", "m4a", "wav", "ogg", "aac", "flac"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "bmp", "tiff"]);

const isHTMLFile = (p: string) => ["html", "htm"].includes(extname(p).toLowerCase());

export interface NotionHTMLOptions {
  /** Fortschritt 0…1 (nach gelesenen Seiten). */
  progress?: ((fraction: number) => void) | undefined;
  /** Abbruch zwischen zwei Seiten (wirft `ImportCancelled`). */
  isCancelled?: (() => boolean) | undefined;
  /** Verweise auf Dateien, die im Export fehlen, als Warnung melden (die Swift-App meldet sie nicht). */
  warnMissingFiles?: boolean | undefined;
  /**
   * BSD-317 (Hybrid): nur den Inhalt einer Seite lesen. Unterseiten und Datenbanken werden nicht importiert, sondern als
   * Platzhalter-Blöcke an ihrer Stelle vermerkt (`page` bzw. `databaseInline` mit der Notion-ID) – die Struktur kommt
   * aus der API, der Platzhalter sagt nur, wo sie im Inhalt steht.
   */
  shallow?: boolean | undefined;
}

/** BSD-317: Zusatzfelder an Datenbank-Platzhaltern des flachen Lesens (Ordner-ID der Quelle, Titel). */
export const SHALLOW_SOURCE_KEY = "hybridSourceDB";
export const SHALLOW_TITLE_KEY = "hybridTitle";

export class NotionHTMLImporter {
  private readonly warnMissingFiles: boolean;
  private readonly shallow: boolean;
  progress: ((fraction: number) => void) | undefined;
  isCancelled: (() => boolean) | undefined;

  private readonly pageFiles = new Map<string, string>();
  private readonly titles = new Map<string, string>();
  private readonly consumed = new Set<string>();
  private total = 1;
  private done = 0;
  private flat = false;
  private readonly rowDatabase = new Map<string, string>();
  private readonly dbBlockByFolder = new Map<string, string>();
  /**
   * BSD-377: Notion-ID einer Datenbank (aus dem Ordnernamen der Zeilen) → ID des Container-Blocks. Bei Inline-
   * Datenbanken ist der Block die `<div id>` der Tabelle, nicht die Datenbank-ID; Erwähnungen und Links zeigen aber auf
   * die Datenbank-ID und erschienen sonst als „deleted“.
   */
  private readonly dbAliases = new Map<string, string>();
  private readonly databaseByBlock = new Map<string, string>();
  private readonly relationTitles = new Map<string, Map<string, string[]>>();
  private readonly linkedCandidates: { blockID: string; folder: string; table: HTMLNode; dir: string; title: Run[]; parent: string; inline: boolean }[] = [];
  private fallbackCount = 0;
  private dataURIs = 0;

  constructor(readonly builder: ImportBuilder, readonly files: ImportFiles, opts: NotionHTMLOptions = {}) {
    this.warnMissingFiles = opts.warnMissingFiles === true;
    this.shallow = opts.shallow === true;
    this.progress = opts.progress;
    this.isCancelled = opts.isCancelled;
  }

  // MARK: Erkennung

  /** HTML aus Notions Exporter (`<article class="page …">`). */
  static isNotionHTML(head: string): boolean {
    return head.includes("<article") && (head.includes("class=\"page ") || head.includes("class=\"page\""));
  }

  private htmlFiles(dir: string): string[] {
    return this.files.walk(dir).filter(isHTMLFile).sort(comparePaths);
  }

  // MARK: Einstieg

  /** Importiert einen Ordner (entpackter Export) oder eine einzelne .html-Datei. Neue Seiten oben werden Wurzeln. */
  importExport(path: string) {
    const at = normalizePath(path);
    if (!this.files.exists(at)) return;
    const isDir = this.files.isDirectory(at) && !this.files.isFile(at);
    const files = isDir ? this.htmlFiles(at) : [at, ...this.htmlFiles(stripExtension(at))];
    for (const f of files) this.registerFile(f);
    this.total = Math.max(1, files.length);
    this.flat = !files.some((f) => this.files.isFile(dirname(f) + ".html"));
    if (isDir) {
      for (const item of this.topLevelItems(at, true)) this.importItem(item, undefined);
    } else {
      this.importPage(at, undefined);
    }
    // Seiten, auf die niemand verlinkt: unter die Seite, der ihr Ordner gehört, sonst oben.
    for (const f of files) {
      if (this.consumed.has(f) || basename(f).toLowerCase() === "index.html") continue;
      const owner = dirname(f) + ".html";
      const dbBlock = this.dbBlockByFolder.get(dirname(f));
      const dbID = dbBlock !== undefined ? this.databaseByBlock.get(dbBlock) : undefined;
      const pid = this.pageFiles.get(owner);
      if (dbID !== undefined) this.importPage(f, "d:" + dbID);
      else if (pid !== undefined && this.builder.contains(pid) && this.builder.block(pid)?.type === "page") this.importPage(f, "b:" + pid);
      else this.importPage(f, undefined);
    }
    this.finish();
  }

  /** BSD-317: eine Seite flach lesen (Option `shallow`); `undefined`, wenn die Datei eine ganzseitige Datenbank ist. */
  importPageShallow(file: string): string | undefined {
    const k = normalizePath(file);
    this.registerFile(k);
    return this.importPage(k, undefined);
  }

  /** BSD-317: eine Seite mit allem darunter lesen (Seiten, die nur im ZIP stehen). */
  importSubtree(file: string, parent: string | undefined): string | undefined {
    const k = normalizePath(file);
    const files = [k, ...this.htmlFiles(stripExtension(k))];
    for (const f of files) this.registerFile(f);
    this.total = Math.max(1, files.length);
    const id = this.importPage(k, parent);
    for (const f of files) {
      if (this.consumed.has(f)) continue;
      const dbBlock = this.dbBlockByFolder.get(dirname(f));
      const dbID = dbBlock !== undefined ? this.databaseByBlock.get(dbBlock) : undefined;
      const pid = this.pageFiles.get(dirname(f) + ".html");
      if (dbID !== undefined) this.importPage(f, "d:" + dbID);
      else if (pid !== undefined && this.builder.contains(pid) && this.builder.block(pid)?.type === "page") this.importPage(f, "b:" + pid);
      else if (id !== undefined) this.importPage(f, "b:" + id);
    }
    this.finish();
    return id;
  }

  private registerFile(f: string) {
    if (this.pageFiles.has(f)) return;
    const id = notionIDInName(basename(f)) ?? derivedID("html-file", basename(f), basename(dirname(f)));
    this.pageFiles.set(f, id);
    this.titles.set(id, cleanTitle(basename(stripExtension(f))));
  }

  private topLevelItems(dir: string, isRoot: boolean): string[] {
    const all = this.files.list(dir).sort((a, b) => comparePaths(basename(a), basename(b)));
    const names = new Set(all.map(basename));
    const out: string[] = [];
    for (const u of all) {
      if (!this.files.isFile(u) || !isHTMLFile(u)) continue;
      if (isRoot && basename(u).toLowerCase() === "index.html") continue;
      out.push(u);
    }
    for (const u of all) if (this.files.isDirectory(u) && !names.has(basename(u) + ".html")) out.push(u);
    return out;
  }

  private importItem(u: string, parent: string | undefined) {
    if (this.files.isDirectory(u) && !this.files.isFile(u)) {
      for (const item of this.topLevelItems(u, false)) this.importItem(item, parent);
    } else {
      this.importPage(u, parent);
    }
  }

  private tick() {
    if (this.isCancelled?.()) throw new ImportCancelled();
    this.done += 1;
    this.progress?.(Math.min(1, this.done / this.total));
  }

  // MARK: Seiten

  private load(file: string): HTMLNode | undefined {
    const text = this.files.readText(file);
    return text === undefined ? undefined : parseHTML(text);
  }

  importPage(file: string, parent: string | undefined): string | undefined {
    const k = normalizePath(file);
    if (this.consumed.has(k)) return undefined;
    this.consumed.add(k);
    const doc = this.load(k);
    if (!doc) { this.builder.warnings.push(`Couldn't read ${basename(k)}`); return undefined; }
    this.tick();
    const article = doc.first((n) => n.tag === "article") ?? doc.first((n) => n.tag === "body") ?? doc;
    if (basename(k).toLowerCase() === "index.html" && !article.has("page") && parent === undefined) return undefined;
    const id = this.pageFiles.get(k) ?? derivedID("html", k);
    const ctx = newCtx(dirname(k), k, id);
    ctx.notion = article.has("page");
    const header = article.first((n) => n.tag === "header");
    const bodyNode = article.first((n) => n.has("page-body"));
    const titleNode = header?.first((n) => n.has("page-title"));
    let title: Run[] = titleNode ? this.richText(titleNode.children, ctx) : [];
    if (isEmptyRuns(title)) {
      const t = doc.first((n) => n.tag === "title");
      const s = t ? trimWS(t.rawText) : "";
      if (s) title = textRuns(s);
    }
    if (isEmptyRuns(title)) title = textRuns(this.titles.get(id) ?? cleanTitle(basename(stripExtension(k))));
    this.titles.set(id, plain(title));

    // Ganzseitige Datenbank: Kopf, dann die Tabelle.
    const looseTable = article.elements.find((e) => e.tag === "table" && e.has("collection-content"))
      ?? article.elements.find((e) => e.tag === "div" && e.has("collection-content"))?.first((n) => n.tag === "table" && n.has("collection-content"));
    let bodyOnly: HTMLNode | undefined;
    if (bodyNode) {
      const els = bodyNode.elements.filter((e) => !SKIP_TAGS.has(e.tag));
      const only = els[0];
      if (els.length === 1 && only && only.has("collection-content")) {
        bodyOnly = only.tag === "table" ? only : only.first((n) => n.tag === "table" && n.has("collection-content"));
      }
    }
    const table = looseTable ?? bodyOnly;
    if (table && (looseTable === undefined ? true : (bodyNode?.elements.length ?? 0) === 0)) {
      if (this.shallow) return undefined;
      const descNode = header?.first((n) => n.has("page-description"));
      const desc = descNode ? this.richText(descNode.children, ctx) : undefined;
      const props: BlockProps = {};
      this.applyHeader(header, props, article, ctx);
      this.importDatabase(table, title, desc, id, parent, false, ctx, props);
      this.builder.markComplete("b:" + id);
      return id;
    }

    const props: BlockProps = {};
    this.applyHeader(header, props, article, ctx);
    const page = makeBlock({ id, type: "page", parent: parent ?? "w", sk: "", text: toRichText(title), props, createdBy: this.builder.createdBy }, this.builder.now());
    this.builder.add(page, parent === undefined);
    const d = header?.first((n) => n.has("page-description"));
    if (d && d.textContent !== "") {
      this.builder.append("text", "b:" + id, { id: derivedID(id, "description"), text: toRichText(this.richText(d.children, ctx)), props: { color: "gray" } });
    }
    if (bodyNode) {
      this.convert(bodyNode.children, "b:" + id, ctx);
    } else if (!article.has("page")) {
      // Jede andere HTML-Datei: ihren Inhalt behalten.
      this.convert(article.children.filter((c) => c.tag !== "header"), "b:" + id, ctx);
    }
    this.importRemainingChildren(k, id);
    this.builder.markComplete("b:" + id);
    return id;
  }

  /** Unterseiten im Ordner der Seite, die der Inhalt nicht verlinkt hat (am Ende angehängt). */
  private importRemainingChildren(file: string, id: string) {
    if (this.shallow) return;
    const folder = stripExtension(file);
    if (!this.files.isDirectory(folder) || this.files.isFile(folder)) return;
    for (const item of this.topLevelItems(folder, false)) {
      if (this.consumed.has(item)) continue;
      if (extname(item).toLowerCase() === "html") {
        if (this.isRowFile(item)) continue; // Zeilenseiten einer Datenbank hier kommen mit der Datenbank
        this.importPage(item, "b:" + id);
      } else {
        for (const f of this.htmlFiles(item)) if (!this.consumed.has(f) && !this.isRowFile(f)) this.importPage(f, "b:" + id);
      }
    }
  }

  private isRowFile(f: string) { return this.dbBlockByFolder.has(dirname(f)); }

  private pageIcon(src: string, ctx: Ctx): BlockProps["icon"] {
    const r = this.media(src, ctx);
    if (!r) return { url: src };
    return r.asset ? { asset: r.asset } : { url: r.url ?? src };
  }

  private applyHeader(header: HTMLNode | undefined, props: BlockProps, article: HTMLNode, ctx: Ctx) {
    const iconBox = header?.first((n) => n.has("page-header-icon"));
    if (iconBox) {
      const img = iconBox.first((n) => n.tag === "img");
      const src = img?.attr("src");
      if (img && src !== undefined) props.icon = this.pageIcon(src, ctx);
      else { const e = importedEmoji(iconBox.textContent); if (e !== undefined) props.icon = e; }
    }
    const cover = header?.first((n) => n.tag === "img" && n.has("page-cover-image"));
    const csrc = cover?.attr("src");
    if (cover && csrc !== undefined) {
      const r = this.media(csrc, ctx);
      if (r) props.cover = r.asset ? { asset: { _0: r.asset } } : { url: { _0: r.url ?? csrc } };
      const pos = cover.style("object-position");
      if (pos !== undefined) {
        const last = pos.split(" ").filter(Boolean).pop();
        const pct = last !== undefined ? parseSwiftDouble(last.replaceAll("%", "")) : undefined;
        if (pct !== undefined) props.format = { ...(props.format ?? {}), coverPosition: pct / 100 };
      }
    }
    const cls = article.classList;
    const f: NonNullable<BlockProps["format"]> = { ...(props.format ?? {}) };
    if (cls.includes("serif")) f.font = "serif"; else if (cls.includes("mono")) f.font = "mono";
    if (cls.some((c) => c.includes("full-width"))) f.fullWidth = true;
    if (cls.some((c) => c.includes("small-text"))) f.smallText = true;
    if (Object.keys(f).length > 0) props.format = f;
  }

  // MARK: Blöcke

  private blockID(n: HTMLNode, ctx: Ctx): string {
    const raw = n.attr("id");
    const id = raw !== undefined ? notionUUID(raw) : undefined;
    if (id !== undefined && !this.builder.contains(id)) return id;
    ctx.counter += 1;
    return derivedID(ctx.pageID, "block", String(ctx.counter));
  }

  private color(n: HTMLNode): string | undefined {
    for (const c of n.classList) if (c.startsWith("block-color-")) return notionColor(c.slice("block-color-".length));
    return undefined;
  }

  private append(type: string, parent: string, id: string, text: Run[] = [], props: BlockProps = {}): string {
    return this.builder.append(type, parent, { id, text: toRichText(text), props });
  }

  /** Geschwister-Knoten → Blöcke unter `parent`. */
  convert(nodes: HTMLNode[], parent: string, ctx: Ctx) {
    let inline: HTMLNode[] = [];
    let last: string | undefined;
    const flush = () => {
      const rt = trimRuns(this.richText(inline, ctx));
      if (!isEmptyRuns(rt)) {
        ctx.counter += 1;
        last = this.append("text", parent, derivedID(ctx.pageID, "block", String(ctx.counter)), rt);
      }
      inline = [];
    };
    for (const n of nodes) {
      if (SKIP_TAGS.has(n.tag)) continue;
      if (INLINE_TAGS.has(n.tag) && !(n.tag === "span" && n.elements.some((e) => !INLINE_TAGS.has(e.tag)))) {
        if (n.isText && inline.length === 0 && trimWS(n.text) === "") continue;
        inline.push(n);
        continue;
      }
      flush();
      if (n.tag === "div" && n.has("indented")) {
        const b = last !== undefined ? this.builder.block(last) : undefined;
        if (b && supportsChildren(b.type) && b.type !== "page" && b.type !== "databasePage") this.convert(n.children, "b:" + last, ctx);
        else this.convert(n.children, parent, ctx);
        continue;
      }
      const id = this.emit(n, parent, ctx);
      if (id !== undefined) last = id;
    }
    flush();
  }

  /** Ein Block-Element → Block(e); liefert die ID des (letzten) Blocks. */
  emit(n: HTMLNode, parent: string, ctx: Ctx): string | undefined {
    switch (n.tag) {
      case "p": {
        const p: BlockProps = { color: this.color(n) };
        if (n.elements.some((e) => !INLINE_TAGS.has(e.tag))) {
          const id = this.append("text", parent, this.blockID(n, ctx), trimRuns(this.richText(n.children.filter((c) => INLINE_TAGS.has(c.tag)), ctx)), p);
          this.convert(n.children.filter((c) => !INLINE_TAGS.has(c.tag)), "b:" + id, ctx);
          return id;
        }
        return this.append("text", parent, this.blockID(n, ctx), trimRuns(this.richText(n.children, ctx)), p);
      }
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        if (n.has("page-title") || n.has("collection-title")) return undefined;
        const type = n.tag === "h1" ? "heading1" : n.tag === "h2" ? "heading2" : n.tag === "h3" ? "heading3" : "heading4";
        return this.append(type, parent, this.blockID(n, ctx), trimRuns(this.richText(n.children, ctx)), { color: this.color(n) });
      }
      case "ul": case "ol": return this.list(n, parent, ctx);
      case "details": return this.toggle(n, this.blockID(n, ctx), this.color(n), parent, ctx);
      case "blockquote": {
        const p: BlockProps = { color: this.color(n) };
        const { inline, blocks } = split(n.children);
        const id = this.append("quote", parent, this.blockID(n, ctx), trimRuns(this.richText(inline, ctx)), p);
        if (blocks.length > 0) this.convert(blocks, "b:" + id, ctx);
        return id;
      }
      case "hr": return this.append("divider", parent, this.blockID(n, ctx));
      case "pre": return this.code(n, this.blockID(n, ctx), undefined, parent);
      case "figure": return this.figure(n, parent, ctx);
      case "nav":
        if (n.has("table_of_contents") || n.classList.some((c) => c.includes("table_of_contents"))) {
          return this.append("tableOfContents", parent, this.blockID(n, ctx), [], { color: this.color(n) });
        }
        if (n.classList.some((c) => c.includes("breadcrumb"))) return this.append("breadcrumb", parent, this.blockID(n, ctx));
        return this.fallback(n, parent, ctx);
      case "table":
        if (n.has("collection-content")) {
          const id = this.blockID(n, ctx);
          return this.importInlineDatabase(n, [], id, parent, ctx);
        }
        return this.simpleTable(n, parent, ctx);
      case "img": return this.image(n.attr("src"), n, undefined, this.blockID(n, ctx), parent, ctx);
      case "iframe": case "embed": case "object":
        return this.append("embed", parent, this.blockID(n, ctx), [], { url: n.attr("src") ?? n.attr("data") });
      case "video": case "audio": {
        const src = n.attr("src") ?? n.first((x) => x.tag === "source")?.attr("src");
        return this.mediaBlock(n.tag, src, undefined, this.blockID(n, ctx), parent, ctx);
      }
      case "div": case "section": case "main": case "article": case "body": case "html": case "aside": case "footer": case "center": case "span":
        return this.div(n, parent, ctx);
      case "header": return undefined;
      case "dl":
        for (const item of n.elements) {
          const rt = trimRuns(this.richText(item.children, ctx));
          if (isEmptyRuns(rt)) continue;
          const p: BlockProps = {};
          if (item.tag === "dd") p.color = "gray";
          this.append(item.tag === "dt" ? "text" : "quote", parent, this.blockID(item, ctx), item.tag === "dt" ? applyMarks(rt, (m) => { m.b = true; }) : rt, p);
        }
        return undefined;
      default:
        if (n.elements.length === 0 && n.textContent === "") return undefined;
        return this.fallback(n, parent, ctx);
    }
  }

  private div(n: HTMLNode, parent: string, ctx: Ctx): string | undefined {
    if (n.has("column-list")) return this.columns(n, parent, ctx);
    if (n.has("collection-content")) {
      const t = n.first((x) => x.has("collection-title"));
      const title = t ? trimRuns(this.richText(t.children, ctx)) : [];
      const table = n.first((x) => x.tag === "table");
      if (!table) return undefined;
      return this.importInlineDatabase(table, title, this.blockID(n, ctx), parent, ctx);
    }
    if (n.has("callout")) return this.callout(n, parent, ctx);
    if (n.has("page-body") || n.has("display-contents") || n.style("display") === "contents" || n.tag !== "div" || n.attrs.get("class") === undefined || n.has("indented")) {
      const hasBlocks = n.elements.some((e) => !INLINE_TAGS.has(e.tag));
      if (hasBlocks || (n.tag !== "div" && n.tag !== "span")) {
        this.convert(n.children, parent, ctx);
        return undefined;
      }
      const rt = trimRuns(this.richText(n.children, ctx));
      if (isEmptyRuns(rt)) return undefined;
      return this.append("text", parent, this.blockID(n, ctx), rt, { color: this.color(n) });
    }
    // Unbekanntes div mit Klasse: gewöhnliches Markup nativ, sonst als HTML.
    const ordinary = new Set(["p", "ul", "ol", "h1", "h2", "h3", "h4", "figure", "pre", "blockquote", "hr", "div", "table", "details", "img"]);
    if (n.elements.every((e) => ordinary.has(e.tag) || INLINE_TAGS.has(e.tag))) {
      this.convert(n.children, parent, ctx);
      return undefined;
    }
    return this.fallback(n, parent, ctx);
  }

  /** Markup ohne Gegenstück: HTML-Code-Block mit Vorschau. */
  private fallback(n: HTMLNode, parent: string, ctx: Ctx): string | undefined {
    const html = n.outerHTML;
    if (html === "") return undefined;
    this.fallbackCount += 1;
    return this.append("code", parent, this.blockID(n, ctx), textRuns(html), { language: "html", url: "preview" });
  }

  // MARK: Listen und Toggles

  private list(n: HTMLNode, parent: string, ctx: Ctx): string | undefined {
    const cls = n.classList;
    const items = n.elements.filter((e) => e.tag === "li");
    let last: string | undefined;
    items.forEach((li, i) => {
      const id = items.length === 1 && i === 0 ? this.blockID(n, ctx) : this.blockID(li, ctx);
      const col = this.color(li) ?? this.color(n);
      if (cls.includes("toggle") || (li.elements[0]?.tag === "details" && li.elements.length === 1)) {
        const d = li.first((x) => x.tag === "details");
        if (d) { last = this.toggle(d, id, col, parent, ctx); return; }
      }
      const checkbox = li.first((x) => x.has("checkbox"));
      const type = cls.includes("to-do-list") || checkbox ? "todo" : n.tag === "ol" || cls.includes("numbered-list") ? "numberedList" : "bulletedList";
      const p: BlockProps = { color: col };
      if (type === "todo") p.checked = checkbox?.has("checkbox-on") ?? false;
      let inlineNodes: HTMLNode[] = [], blockNodes: HTMLNode[] = [];
      for (const c of li.children) {
        if (c.has("checkbox")) continue;
        if (c.tag === "span" && c.classList.some((x) => x.startsWith("to-do-children"))) { inlineNodes.push(...c.children); continue; }
        if (blockNodes.length === 0 && INLINE_TAGS.has(c.tag)) inlineNodes.push(c);
        else if (!SKIP_TAGS.has(c.tag)) blockNodes.push(c);
      }
      // Manche Exporte tragen den Text in einem führenden <p>.
      if (inlineNodes.every((x) => x.isText && trimWS(x.text) === "") && blockNodes[0]?.tag === "p") {
        inlineNodes = blockNodes[0].children;
        blockNodes = blockNodes.slice(1);
      }
      const lid = this.append(type, parent, id, trimRuns(this.richText(inlineNodes, ctx)), p);
      if (blockNodes.length > 0) this.convert(blockNodes, "b:" + lid, ctx);
      last = lid;
    });
    return last;
  }

  private toggle(d: HTMLNode, id: string, color: string | undefined, parent: string, ctx: Ctx): string {
    const summary = d.elements.find((e) => e.tag === "summary");
    let type = "toggle";
    let titleNodes = summary?.children ?? [];
    if (summary) {
      const h = summary.elements.find((e) => ["h1", "h2", "h3", "h4"].includes(e.tag));
      if (h) {
        type = h.tag === "h1" ? "heading1" : h.tag === "h2" ? "heading2" : h.tag === "h3" ? "heading3" : "heading4";
        titleNodes = h.children;
      } else {
        const size = summary.style("font-size");
        if (size !== undefined) {
          const s = trimSpaces(size);
          if (s === "1.875em") type = "heading1"; else if (s === "1.5em") type = "heading2"; else if (s === "1.25em") type = "heading3";
        }
      }
    }
    const p: BlockProps = { color: color ?? (summary ? this.color(summary) : undefined) };
    if (type !== "toggle") p.toggleable = true;
    const tid = this.append(type, parent, id, trimRuns(this.richText(titleNodes, ctx)), p);
    const flat: HTMLNode[] = [];
    for (const c of d.children) {
      if (c.tag === "summary") continue;
      if (c.tag === "div" && c.has("indented")) flat.push(...c.children); else flat.push(c);
    }
    this.convert(flat, "b:" + tid, ctx);
    return tid;
  }

  // MARK: Figuren, Medien, Code

  private figure(n: HTMLNode, parent: string, ctx: Ctx): string | undefined {
    const id = this.blockID(n, ctx);
    const fc = n.elements.find((e) => e.tag === "figcaption");
    const caption = fc ? trimRuns(this.richText(fc.children, ctx)) : undefined;
    const cap = caption === undefined || isEmptyRuns(caption) ? undefined : caption;
    if (n.has("callout")) return this.callout(n, parent, ctx, id);
    if (n.has("equation")) {
      const tex = n.first((x) => x.tag === "annotation")?.rawText ?? n.textContent;
      return this.append("equation", parent, id, [], { expression: trimWS(tex) });
    }
    if (n.has("link-to-page")) {
      const a = n.first((x) => x.tag === "a");
      const href = a?.attr("href");
      if (a && href !== undefined) return this.pageLink(href, a, id, parent, ctx);
    }
    const bm = n.first((x) => x.tag === "a" && x.has("bookmark"));
    const bhref = bm?.attr("href");
    if (bm && bhref !== undefined) {
      const p: BlockProps = { url: bhref };
      if (cap) p.caption = toRichText(cap);
      const meta: NonNullable<BlockProps["bookmark"]> = {};
      const title = bm.first((x) => x.has("bookmark-title"))?.textContent;
      const summary = bm.first((x) => x.has("bookmark-description"))?.textContent;
      const imageURL = bm.first((x) => x.has("bookmark-image"))?.attr("src");
      const iconURL = bm.first((x) => x.has("bookmark-icon"))?.attr("src");
      if (title !== undefined) meta.title = title;
      if (summary !== undefined) meta.summary = summary;
      if (imageURL !== undefined) meta.imageURL = imageURL;
      if (iconURL !== undefined) meta.iconURL = iconURL;
      if (title !== undefined || imageURL !== undefined) p.bookmark = meta;
      return this.append("bookmark", parent, id, [], p);
    }
    const pre = n.first((x) => x.tag === "pre");
    if (pre) return this.code(pre, id, cap, parent);
    if (n.has("image") || (n.first((x) => x.tag === "img") !== undefined && n.first((x) => x.has("source")) === undefined)) {
      const img = n.first((x) => x.tag === "img");
      const src = img?.attr("src") ?? n.first((x) => x.tag === "a")?.attr("href");
      return this.image(src, img, cap, id, parent, ctx);
    }
    const v = n.first((x) => x.tag === "video" || x.tag === "audio");
    if (v) {
      const src = v.attr("src") ?? v.first((x) => x.tag === "source")?.attr("src");
      return this.mediaBlock(v.tag, src, cap, id, parent, ctx);
    }
    const f = n.first((x) => x.tag === "iframe");
    if (f) {
      const p: BlockProps = { url: f.attr("src") };
      if (cap) p.caption = toRichText(cap);
      return this.append("embed", parent, id, [], p);
    }
    const a = n.first((x) => x.tag === "a");
    const href = a?.attr("href");
    if (a && href !== undefined) return this.mediaBlock(undefined, href, cap, id, parent, ctx, a.textContent);
    if (n.elements.length === 0 && n.textContent === "") return undefined;
    return this.fallback(n, parent, ctx);
  }

  private callout(n: HTMLNode, parent: string, ctx: Ctx, given?: string): string {
    const id = given ?? this.blockID(n, ctx);
    const p: BlockProps = { color: this.color(n) };
    const parts = n.elements.filter((e) => !SKIP_TAGS.has(e.tag));
    let content: HTMLNode[] = n.children;
    const iconBox = parts[0];
    if (parts.length >= 2 && iconBox) {
      const img = iconBox.first((x) => x.tag === "img");
      const src = img?.attr("src");
      if (img && src !== undefined) p.icon = this.pageIcon(src, ctx);
      else { const e = importedEmoji(iconBox.textContent); if (e !== undefined) p.icon = e; }
      content = parts.slice(1).flatMap((x) => (x.tag === "div" ? x.children : [x]));
    }
    const { inline, blocks } = split(content);
    let text = trimRuns(this.richText(inline, ctx));
    let rest = blocks;
    if (isEmptyRuns(text) && rest[0]?.tag === "p") { text = trimRuns(this.richText(rest[0].children, ctx)); rest = rest.slice(1); }
    const cid = this.append("callout", parent, id, text, p);
    if (rest.length > 0) this.convert(rest, "b:" + cid, ctx);
    return cid;
  }

  private code(pre: HTMLNode, id: string, caption: Run[] | undefined, parent: string): string {
    const codeNode = pre.first((x) => x.tag === "code") ?? pre;
    let lang = codeNode.classList.find((c) => c.startsWith("language-"))?.slice(9) ?? "plain text";
    lang = lang.replaceAll("_", " ").toLowerCase();
    if (lang === "shell") lang = "bash";
    if (lang === "plain" || lang === "") lang = "plain text";
    const p: BlockProps = { language: lang };
    if (caption) p.caption = toRichText(caption);
    if (pre.classList.includes("code-wrap")) p.wrap = true;
    if (lang === "mermaid") p.url = "preview";
    let text = codeNode.rawText;
    if (text.endsWith("\n")) text = text.slice(0, -1);
    return this.append("code", parent, id, textRuns(text), p);
  }

  /** Datei aus dem Export oder entfernte URL für ein `src`/`href`. */
  private media(src: string, ctx: Ctx): { url?: string; asset?: AssetRef } | undefined {
    if (src === "") return undefined;
    if (src.startsWith("data:")) {
      const comma = src.indexOf(",");
      if (comma >= 0 && src.slice(0, comma).endsWith(";base64")) {
        const data = base64Decode(src.slice(comma + 1));
        if (data) {
          const mime = src.slice(5).split(";")[0]!;
          const last = mime.split("/").filter(Boolean).pop();
          const ext = last === undefined ? "bin" : last === "jpeg" ? "jpg" : (/^\p{L}*/u.exec(last)?.[0] ?? "");
          this.dataURIs += 1;
          return { asset: this.builder.asset("data:" + this.dataURIs, data, "image." + ext, mime) };
        }
      }
    }
    if (src.includes("://") || src.startsWith("data:") || src.startsWith("mailto:")) return { url: src };
    const decoded = removingPercentEncoding(src) ?? src;
    const u = joinPath(ctx.dir, decoded);
    // BSD-254: erst beim Übernehmen in den Asset-Speicher lesen (große Exporte liegen so nie ganz im Speicher)
    const size = this.files.isFile(u) ? this.files.size(u) : undefined;
    if (size !== undefined) return { asset: this.builder.assetLazy(u, size, () => this.files.read(u), basename(u)) };
    // Verweis auf eine Datei, die im Export fehlt: melden statt still einen toten Pfad zu behalten.
    if (this.warnMissingFiles && looksLikeLocalFile(decoded) && !/\.(html?|md|csv)$/i.test(decoded.split(/[?#]/)[0]!)) {
      const w = `Missing file “${u}” — it isn't in the export`;
      if (!this.builder.warnings.includes(w)) this.builder.warnings.push(w);
    }
    return { url: src };
  }

  private image(src: string | undefined, node: HTMLNode | undefined, caption: Run[] | undefined, id: string, parent: string, ctx: Ctx): string | undefined {
    if (src === undefined) return undefined;
    const m = this.media(src, ctx);
    if (!m) return undefined;
    const p: BlockProps = { url: m.url, asset: m.asset };
    if (caption) p.caption = toRichText(caption);
    const w = node?.style("width");
    const px = w !== undefined && w.endsWith("px") ? parseSwiftDouble(w.slice(0, -2)) : undefined;
    if (px !== undefined) p.width = px;
    else {
      const attr = node?.attr("width");
      const v = attr !== undefined ? parseSwiftDouble(attr) : undefined;
      if (v !== undefined) p.width = v;
    }
    return this.append("image", parent, id, [], p);
  }

  private mediaBlock(forced: string | undefined, href: string | undefined, caption: Run[] | undefined, id: string, parent: string, ctx: Ctx, label?: string): string | undefined {
    if (href === undefined) return undefined;
    const m = this.media(href, ctx);
    if (!m) return undefined;
    const ext = linkExtension(href);
    let type = forced ?? "file";
    if (forced === undefined) {
      if (VIDEO_EXT.has(ext)) type = "video";
      else if (AUDIO_EXT.has(ext)) type = "audio";
      else if (IMAGE_EXT.has(ext)) type = "image";
      else if (ext === "pdf") type = "pdf";
      else if (m.asset === undefined) {
        const host = urlHost(href) ?? "";
        if (host.includes("youtube.com") || host.includes("youtu.be") || host.includes("vimeo.com") || host.includes("loom.com")) type = "video";
        else if (m.url?.startsWith("http")) type = "embed";
      }
    }
    const p: BlockProps = { url: m.url, asset: m.asset };
    if (caption) p.caption = toRichText(caption);
    if (type === "file" && m.asset === undefined && label !== undefined && label !== "" && caption === undefined && label !== href) p.caption = label;
    return this.append(type, parent, id, [], p);
  }

  // MARK: Seitenlinks

  private resolve(href: string, ctx: Ctx): { id: string; file: string | undefined } | undefined {
    if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return undefined;
    if (href.includes("://")) {
      const host = urlHost(href);
      if (host === undefined || !(host.endsWith("notion.so") || host.endsWith("notion.site") || host.endsWith("notion.com"))) return undefined;
      const id = notionIDInName(urlPath(href) ?? href);
      return id === undefined ? undefined : { id, file: undefined };
    }
    const path = href.split("#").find((s) => s.length > 0) ?? href;
    if (!path.toLowerCase().endsWith(".html")) return undefined;
    const u = joinPath(ctx.dir, removingPercentEncoding(path) ?? path);
    const known = this.pageFiles.get(u);
    if (known !== undefined) return { id: known, file: u };
    const id = notionIDInName(basename(u));
    if (id !== undefined) return { id, file: this.files.isFile(u) ? u : undefined };
    return undefined;
  }

  private pageLink(href: string, anchor: HTMLNode, id: string, parent: string, ctx: Ctx): string | undefined {
    const target = this.resolve(href, ctx);
    if (!target) {
      // Keine Seite: Link als Text behalten.
      const rt = trimRuns(this.richText(anchor.children, ctx));
      const text = isEmptyRuns(rt) ? textRuns(href) : rt;
      return this.append("text", parent, id, applyMarks(text, (m) => { m.link = href; }));
    }
    if (target.file !== undefined && !this.consumed.has(target.file)) {
      const ownFolder = stripExtension(ctx.file);
      const isChild = dirname(target.file) === ownFolder || (this.flat && dirname(target.file) === ctx.dir);
      if (isChild && parent.startsWith("b:") && this.shallow) return this.append("page", parent, target.id);
      if (isChild && parent.startsWith("b:")) {
        // Eine Unterseite: genau hier importieren.
        const pid = this.importPage(target.file, parent);
        if (pid !== undefined) return pid;
      }
    }
    return this.append("linkToPage", parent, id, [], { linkTarget: target.id });
  }

  // MARK: Spalten und einfache Tabellen

  private columns(n: HTMLNode, parent: string, ctx: Ctx): string | undefined {
    const cols = n.elements.filter((e) => e.has("column"));
    if (cols.length === 0) { this.convert(n.children, parent, ctx); return undefined; }
    const id = this.append("columnList", parent, this.blockID(n, ctx));
    for (const c of cols) {
      const p: BlockProps = {};
      const w = c.style("width");
      if (w !== undefined) p.ratio = columnRatio(w);
      const cid = this.append("column", "b:" + id, this.blockID(c, ctx), [], p);
      this.convert(c.children, "b:" + cid, ctx);
    }
    return id;
  }

  private simpleTable(n: HTMLNode, parent: string, ctx: Ctx): string | undefined {
    const head = n.elements.find((e) => e.tag === "thead");
    const headRows = head?.elements.filter((e) => e.tag === "tr") ?? [];
    const bodyRows = [...n.elements.filter((e) => e.tag === "tbody").flatMap((b) => b.elements.filter((e) => e.tag === "tr")), ...n.elements.filter((e) => e.tag === "tr")];
    const rows = [...headRows, ...bodyRows];
    if (rows.length === 0) return undefined;
    const cellsOf = (r: HTMLNode) => r.elements.filter((e) => e.tag === "td" || e.tag === "th");
    const width = Math.max(...rows.map((r) => cellsOf(r).length));
    const p: BlockProps = { tableColumns: Math.max(1, width), tableHeaderRow: headRows.length > 0 };
    p.tableHeaderColumn = bodyRows.length > 0 && bodyRows.every((r) => {
      const c = cellsOf(r)[0];
      return c !== undefined && (c.tag === "th" || c.classList.some((x) => x.startsWith("simple-table-header")));
    });
    if (p.tableHeaderRow === false && p.tableHeaderColumn === false) { delete p.tableHeaderRow; delete p.tableHeaderColumn; }
    const id = this.append("table", parent, this.blockID(n, ctx), [], p);
    for (const r of rows) {
      const cells: RichText[] = cellsOf(r).map((c) => toRichText(trimRuns(this.richText(c.children, ctx))));
      while (cells.length < width) cells.push("");
      this.append("tableRow", "b:" + id, this.blockID(r, ctx), [], { cells });
    }
    return id;
  }

  // MARK: Text

  richText(nodes: HTMLNode[], ctx: Ctx): Run[] {
    const runs: Run[] = [];
    const add = (s: string, m: Marks) => {
      if (s === "") return;
      runs.push({ t: s.replaceAll(" ", " ").replaceAll("\r", ""), m });
    };
    const walk = (n: HTMLNode, marks: Marks, inLink: boolean) => {
      if (n.isText) {
        // Notion schreibt pre-wrap (Umbrüche sind <br>); allgemeines HTML fasst Leerraum zusammen.
        add(ctx.notion ? n.text.replaceAll("\n", " ") : collapse(n.text), marks);
        return;
      }
      const m: Marks = { ...marks };
      switch (n.tag) {
        case "br": add("\n", m); return;
        case "style": case "script": case "svg": return;
        case "strong": case "b": m.b = true; break;
        case "em": case "i": m.i = true; break;
        case "u": case "ins": m.u = true; break;
        case "s": case "del": case "strike": m.s = true; break;
        case "code": case "kbd": m.c = true; break;
        case "mark": {
          const h = n.classList.find((c) => c.startsWith("highlight-"));
          m.color = ((h !== undefined ? notionColor(h.slice(10)) : undefined) ?? "yellowBackground") as Marks["color"];
          break;
        }
        case "img": {
          const alt = n.attr("alt");
          if (!inLink && alt !== undefined && alt !== "" && !n.has("icon")) add(alt, m);
          return;
        }
        case "time": {
          const raw = n.textContent;
          const s = raw.startsWith("@") ? raw.slice(1) : raw;
          const d = parseDate(s);
          if (d) runs.push({ t: "@" + s, m, mention: { date: { _0: d } } }); else add(raw, m);
          return;
        }
        case "span": {
          if (n.has("notion-text-equation-token")) {
            const tex = trimWS(n.first((x) => x.tag === "annotation")?.rawText ?? n.textContent);
            runs.push({ t: tex, m, eq: tex });
            return;
          }
          if (n.has("user")) {
            const name = n.textContent;
            runs.push({ t: name.startsWith("@") ? name : "@" + name, m, mention: { user: { _0: name.startsWith("@") ? name.slice(1) : name } } });
            return;
          }
          if (n.has("icon") && inLink) return;
          if ((n.attrs.get("style") ?? "").includes("border-bottom")) m.u = true;
          const h = n.classList.find((c) => c.startsWith("highlight-"));
          if (h !== undefined) {
            const c = notionColor(h.slice(10));
            if (c === undefined) delete m.color; else m.color = c as Marks["color"];
          }
          if (n.has("katex-mathml") || n.has("katex-html")) return;
          break;
        }
        case "a": {
          const href = n.attr("href");
          if (href === undefined || href === "") break;
          const target = this.resolve(href, ctx);
          if (target) {
            const label = n.children.filter((c) => !(c.tag === "span" && c.has("icon")) && c.tag !== "img");
            const text = trimWS(collapse(label.map((c) => c.rawText).join("")));
            const title = this.titles.get(target.id);
            if (title === undefined || text === "" || text === title || text.startsWith(title)) {
              runs.push({ t: text === "" ? (title ?? "Untitled") : text, m, mention: { page: { _0: target.id } } });
              return;
            }
            m.link = "based://page/" + target.id;
          } else if (href.startsWith("#")) {
            break;
          } else {
            m.link = href;
          }
          for (const c of n.children) walk(c, m, true);
          return;
        }
        default: break;
      }
      for (const c of n.children) walk(c, m, inLink);
    };
    for (const n of nodes) walk(n, PLAIN, false);
    return normalize(runs);
  }

  // MARK: Datenbanken

  private importInlineDatabase(table: HTMLNode, title: Run[], blockID: string, parent: string, ctx: Ctx): string | undefined {
    if (this.shallow) {
      const id = this.append("databaseInline", parent, blockID);
      const folder = this.rowFolder(table, ctx);
      const source = folder !== undefined ? notionIDInName(basename(folder)) : undefined;
      this.builder.update(id, (b) => {
        const x = b as Record<string, unknown>;
        if (source !== undefined) x[SHALLOW_SOURCE_KEY] = source;
        if (!isEmptyRuns(title)) x[SHALLOW_TITLE_KEY] = plain(title);
      });
      return id;
    }
    // Zeilen, die in den Ordner einer anderen Datenbank zeigen: eine verknüpfte Ansicht dieser Datenbank.
    const folder = this.rowFolder(table, ctx);
    const own = stripExtension(ctx.file);
    if (folder !== undefined && !folder.startsWith(own + "/") && folder !== own) {
      if (!this.dbBlockByFolder.has(folder)) {
        // Später auflösen (`finish`): die Quelle kann noch kommen.
        const id = this.append("databaseInline", parent, blockID);
        this.linkedCandidates.push({ blockID: id, folder, table, dir: ctx.dir, title, parent, inline: true });
        return id;
      }
      return this.linkedView(blockID, folder, table, parent, false);
    }
    this.importDatabase(table, title, undefined, blockID, parent, true, ctx, {});
    return blockID;
  }

  private linkedView(blockID: string, folder: string, table: HTMLNode, parent: string, existing: boolean): string | undefined {
    const srcBlock = this.dbBlockByFolder.get(folder);
    const dbID = srcBlock !== undefined ? this.databaseByBlock.get(srcBlock) : undefined;
    const db = dbID !== undefined ? this.builder.database(dbID) : undefined;
    if (!db || dbID === undefined) return undefined;
    const viewID = derivedID(blockID, "view");
    const now = this.builder.now();
    const props: { id: string; visible: boolean }[] = [];
    for (const n of headerNames(table)) {
      const p = propertyNamed(db, n);
      if (p) props.push({ id: p.id, visible: true });
    }
    for (const p of db.properties) if (!props.some((x) => x.id === p.id)) props.push({ id: p.id, visible: false });
    const v: DatabaseView = { id: viewID, databaseID: dbID, blockID, name: "Table", type: "table", sortKey: FIRST_KEY, properties: props, createdAt: now, updatedAt: now, stamp: { ...ZERO_STAMP } };
    this.builder.addView(v);
    const bp: BlockProps = { databaseID: dbID, viewIDs: [viewID] };
    if (existing) this.builder.update(blockID, (b) => { b.props = bp; });
    else this.append("databaseInline", parent, blockID, [], bp);
    return blockID;
  }

  /** Ordner mit den Zeilenseiten, auf die eine Tabelle verlinkt. */
  private rowFolder(table: HTMLNode, ctx: Ctx): string | undefined {
    for (const td of table.all((n) => n.tag === "td" && n.has("cell-title"))) {
      const href = td.first((n) => n.tag === "a")?.attr("href");
      if (href !== undefined && !href.includes("://")) return dirname(joinPath(ctx.dir, removingPercentEncoding(href) ?? href));
    }
    return undefined;
  }

  private importDatabase(table: HTMLNode, title: Run[], summary: Run[] | undefined, blockID: string, parent: string | undefined,
                         inline: boolean, ctx: Ctx, extra: BlockProps): string {
    const dbID = derivedID(blockID, "database");
    this.databaseByBlock.set(blockID, dbID);
    const folder = this.rowFolder(table, ctx);
    this.dbBlockByFolder.set(folder ?? joinPath(ctx.dir, plain(title)), blockID);
    const notionDB = folder !== undefined ? notionIDInName(basename(folder)) : undefined;
    if (notionDB !== undefined && notionDB !== blockID && !this.dbAliases.has(notionDB)) this.dbAliases.set(notionDB, blockID);

    // Kopf
    const ths = table.first((n) => n.tag === "thead")?.all((n) => n.tag === "th") ?? [];
    let columns: Column[] = ths.map((th) => ({ name: th.textContent, hint: svgType(th), rowType: new Map() }));
    const trs = (table.first((n) => n.tag === "tbody") ?? table).elements.filter((e) => e.tag === "tr");
    let titleIndex: number | undefined = columns.findIndex((c) => c.hint === "title");
    if (titleIndex < 0) titleIndex = undefined;
    if (titleIndex === undefined && trs[0]) {
      const i = trs[0].elements.filter((e) => e.tag === "td").findIndex((td) => td.has("cell-title"));
      if (i >= 0) titleIndex = i;
    }
    const ti = titleIndex ?? 0;
    if (columns.length === 0) columns = [{ name: "Name", hint: "title", rowType: new Map() }];
    (trs[0]?.elements.filter((e) => e.tag === "td") ?? []).forEach((td, i) => {
      if (i < columns.length) columns[i]!.cellClass = td.classList.find((c) => c.startsWith("cell-") && c !== "cell-title");
    });

    // Zeilen (Tabellenzellen + Zeilenseiten)
    const rows: RowSource[] = [];
    const extraNames: string[] = [];
    const extraTypes = new Map<string, Map<string, number>>();
    const vote = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    trs.forEach((tr, ri) => {
      const tds = tr.elements.filter((e) => e.tag === "td");
      const titleCell = ti < tds.length ? tds[ti] : tds[0];
      const a = titleCell?.first((n) => n.tag === "a");
      let file: string | undefined;
      const ahref = a?.attr("href");
      if (ahref !== undefined && !ahref.includes("://")) {
        const u = joinPath(ctx.dir, removingPercentEncoding(ahref) ?? ahref);
        if (this.files.isFile(u)) file = u;
      }
      const trID = tr.attr("id");
      const rid = (trID !== undefined ? notionUUID(trID) : undefined)
        ?? (ahref !== undefined ? notionIDInName(basename(removingPercentEncoding(ahref) ?? ahref)) : undefined)
        ?? derivedID(dbID, "row", String(ri));
      const labelSource = a ?? titleCell;
      const label = labelSource ? labelSource.children.filter((c) => !(c.tag === "span" && c.has("icon")) && c.tag !== "img") : [];
      const tctx = newCtx(ctx.dir, ctx.file, rid);
      const row: RowSource = { id: rid, title: trimRuns(this.richText(label, tctx)), cells: new Map(), cellDirs: new Map(), file, doc: undefined, icon: undefined };
      const icon = a?.first((n) => n.has("icon"));
      if (icon) {
        const src = icon.attr("src");
        if (icon.tag === "img" && src !== undefined) {
          const r = this.media(src, tctx);
          if (r) row.icon = r.asset ? { asset: r.asset } : { url: r.url ?? src };
        } else {
          const e = importedEmoji(icon.textContent);
          if (e !== undefined) row.icon = e;
        }
      }
      tds.forEach((td, i) => {
        if (i !== ti && i < columns.length) { row.cells.set(columns[i]!.name, td); row.cellDirs.set(columns[i]!.name, ctx.dir); }
      });
      if (file !== undefined && !this.consumed.has(file)) {
        const doc = this.load(file);
        if (doc) {
          this.consumed.add(file);
          this.tick();
          row.doc = doc;
          const props = doc.first((n) => n.tag === "table" && n.has("properties"));
          for (const tr2 of props?.all((n) => n.tag === "tr") ?? []) {
            const th = tr2.first((n) => n.tag === "th"), td = tr2.first((n) => n.tag === "td");
            if (!th || !td) continue;
            const name = th.textContent;
            const typeClass = tr2.classList.find((c) => c.startsWith("property-row-"))?.slice(13);
            const ci = columns.findIndex((c) => c.name === name);
            if (ci >= 0) {
              if (typeClass !== undefined) vote(columns[ci]!.rowType, typeClass);
              if (columns[ci]!.hint === undefined) columns[ci]!.hint = svgType(th);
            } else {
              if (!extraNames.includes(name)) extraNames.push(name);
              let votes = extraTypes.get(name);
              if (!votes) extraTypes.set(name, (votes = new Map()));
              if (typeClass !== undefined) vote(votes, typeClass);
              else { const t = svgType(th); if (t !== undefined) vote(votes, "svg:" + t); }
            }
            row.cells.set(name, td);
            row.cellDirs.set(name, dirname(file));
          }
          const header = doc.first((n) => n.tag === "header");
          const iconBox = header?.first((n) => n.has("page-header-icon"));
          if (iconBox) {
            const img = iconBox.first((n) => n.tag === "img");
            const src = img?.attr("src");
            if (img && src !== undefined) {
              const r = this.media(src, newCtx(dirname(file), file, rid));
              row.icon = r ? (r.asset ? { asset: r.asset } : { url: r.url ?? src }) : undefined;
            } else {
              const e = importedEmoji(iconBox.textContent);
              if (e !== undefined) row.icon = e;
            }
          }
        }
      }
      rows.push(row);
      this.rowDatabase.set(rid, dbID);
      this.titles.set(rid, plain(row.title));
      if (file !== undefined) this.pageFiles.set(file, rid);
    });

    // Schema
    const schema: PropertySchema[] = [];
    const visible: string[] = [];
    const titleName = ti < columns.length ? columns[ti]!.name : "Name";
    schema.push({ id: TITLE_PROPERTY_ID, name: titleName === "" ? "Name" : titleName, type: "title" });
    visible.push(TITLE_PROPERTY_ID);
    const allNames: { name: string; hint: string | undefined; votes: Map<string, number>; visible: boolean }[] = [];
    columns.forEach((c, i) => { if (i !== ti) allNames.push({ name: c.name, hint: c.hint, votes: c.rowType, visible: true }); });
    for (const n of extraNames) {
      const votes = new Map(extraTypes.get(n) ?? []);
      const svgKey = [...votes.keys()].find((k) => k.startsWith("svg:"));
      for (const k of [...votes.keys()]) if (k.startsWith("svg:")) votes.delete(k);
      allNames.push({ name: n, hint: svgKey?.slice(4), votes, visible: false });
    }
    for (const { name, hint, votes, visible: isVisible } of allNames) {
      const cells = rows.map((r) => r.cells.get(name)).filter((c): c is HTMLNode => c !== undefined);
      let best: [string, number] | undefined;
      for (const [k, v] of votes) if (!best || v > best[1]) best = [k, v];
      let type = (best ? rowType(best[0]) : undefined) ?? hint ?? guessType(cells);
      if (type === "title") type = "text";
      const p: PropertySchema = { id: derivedID(dbID, "property", name), name, type: type as PropertySchema["type"] };
      if (type === "formula" || type === "rollup") {
        // Der HTML-Export hat nur Werte: als feste Werte behalten.
        const inner = guessType(cells);
        p.type = (["number", "date", "checkbox"].includes(inner) ? inner : "text") as PropertySchema["type"];
        p.description = `${type === "formula" ? "Formula" : "Rollup"} in Notion (the HTML export has no expression; import via the Notion API to keep it live).`;
      } else if (type === "select" || type === "multiSelect" || type === "status") {
        const opts: NonNullable<PropertySchema["options"]> = [];
        for (const c of cells) {
          for (const [label, col] of optionValues(c)) {
            if (!opts.some((o) => o.name === label)) opts.push({ id: derivedID(dbID, name, label), name: label, color: col as never });
          }
        }
        p.options = opts;
        if (type === "status") p.statusGroups = statusGroups(opts, dbID + name);
      } else if (type === "number") {
        const f = numberFormat(cells.map((c) => c.textContent));
        if (f !== undefined) p.numberFormat = f as never;
      } else if (type === "uniqueID") {
        const withDash = cells.map((c) => c.textContent).find((t) => t.includes("-"));
        if (withDash !== undefined) p.idPrefix = withDash.slice(0, withDash.lastIndexOf("-"));
      } else if (type === "button" || type === "verification") {
        continue;
      }
      schema.push(p);
      visible.push(isVisible ? p.id : "-" + p.id);
    }

    const now = this.builder.now();
    const db: Database = { id: dbID, blockID, title: toRichText(title), properties: schema, createdAt: now, updatedAt: now, stamp: { ...ZERO_STAMP } };
    if (summary !== undefined && !isEmptyRuns(summary)) db.summary = toRichText(summary);
    const viewID = derivedID(blockID, "view");
    const view: DatabaseView = {
      id: viewID, databaseID: dbID, blockID, name: "Table", type: "table", sortKey: FIRST_KEY,
      properties: visible.map((v) => (v.startsWith("-") ? { id: v.slice(1), visible: false } : { id: v, visible: true })),
      createdAt: now, updatedAt: now, stamp: { ...ZERO_STAMP },
    };
    const bp: BlockProps = { ...extra, databaseID: dbID, viewIDs: [viewID] };
    const container = makeBlock({ id: blockID, type: inline ? "databaseInline" : "databasePage", parent: parent ?? "w", sk: "", props: bp,
      text: inline ? undefined : toRichText(title), createdBy: this.builder.createdBy }, now);
    this.builder.add(container, parent === undefined);
    this.builder.addView(view);

    // Zeilen-Blöcke
    let maxUnique = 0;
    for (const row of rows) {
      const values: Record<string, PropertyValue> = {};
      let created: number | undefined, edited: number | undefined, createdBy: string | undefined, editedBy: string | undefined;
      const rdir = row.file !== undefined ? dirname(row.file) : ctx.dir;
      const rctx = newCtx(rdir, row.file ?? ctx.file, row.id);
      // Tabellenzellen sind relativ zur Datei der Tabelle, Zeilen-Properties zur Zeilendatei.
      for (const p of schema) {
        if (p.type === "title") continue;
        const node = row.cells.get(p.name);
        if (!node) continue;
        const vctx = newCtx(row.cellDirs.get(p.name) ?? ctx.dir, row.file ?? ctx.file, row.id);
        switch (p.type) {
          case "createdTime": created = parseDate(stripAt(node.textContent))?.start; break;
          case "lastEditedTime": edited = parseDate(stripAt(node.textContent))?.start; break;
          case "createdBy": createdBy = people(node)[0]; break;
          case "lastEditedBy": editedBy = people(node)[0]; break;
          case "uniqueID": {
            const t = node.textContent;
            const parts = t.split("-").filter((x) => x.length > 0);
            const raw = parts.length > 0 ? parts[parts.length - 1]! : t;
            const n = /^[+-]?\d+$/.test(raw) ? Number(raw) : undefined;
            if (n !== undefined) { values[p.id] = enumValue("uniqueID", n); maxUnique = Math.max(maxUnique, n); }
            break;
          }
          default: {
            const v = this.value(node, p, row.id, vctx);
            if (v !== undefined) values[p.id] = v;
          }
        }
      }
      const b = makeBlock({ id: row.id, type: "page", parent: "d:" + dbID, sk: "", text: toRichText(row.title), values,
        createdAt: created ?? now, createdBy: createdBy ?? this.builder.createdBy }, now);
      b.updatedAt = edited ?? created ?? b.createdAt;
      const ub = editedBy ?? b.createdBy;
      if (ub !== undefined) b.updatedBy = ub; else delete b.updatedBy;
      const props: BlockProps = { ...(b.props ?? {}) };
      if (row.icon !== undefined) props.icon = row.icon;
      const rheader = row.doc?.first((n) => n.tag === "header");
      if (row.doc && rheader) this.applyHeader(rheader, props, row.doc.first((n) => n.tag === "article") ?? row.doc, rctx);
      b.props = props;
      this.builder.add(b);
      const body = row.doc?.first((n) => n.has("page-body"));
      if (body) this.convert(body.children, "b:" + row.id, rctx);
      if (row.file !== undefined) this.importRemainingChildren(row.file, row.id);
      this.builder.markComplete("b:" + row.id);
    }
    if (maxUnique > 0) db.nextUniqueID = maxUnique + 1;
    this.builder.addDatabase(db);
    this.builder.markComplete("d:" + dbID);
    return blockID;
  }

  private value(node: HTMLNode, p: PropertySchema, row: string, ctx: Ctx): PropertyValue | undefined {
    const text = node.textContent;
    switch (p.type) {
      case "text": case "formula": case "rollup": {
        const rt = trimRuns(this.richText(node.children, ctx));
        return isEmptyRuns(rt) ? undefined : enumValue("text", toRichText(rt));
      }
      case "number": { const n = parseNotionNumber(text); return n === undefined ? undefined : enumValue("number", n); }
      case "select": case "status": {
        const first = optionValues(node)[0];
        const o = first ? optionNamed(p, first[0]) : undefined;
        return o ? enumValue(p.type, o.id) : undefined;
      }
      case "multiSelect": {
        const ids = optionValues(node).map(([l]) => optionNamed(p, l)?.id).filter((x): x is string => x !== undefined);
        return ids.length === 0 ? undefined : enumValue("multiSelect", ids);
      }
      case "date": { const d = parseDate(stripAt(text)); return d ? enumValue("date", d) : undefined; }
      case "person": { const ps = people(node); return ps.length === 0 ? undefined : enumValue("person", ps); }
      case "files": {
        let files: { name: string; asset?: AssetRef; url?: string }[] = [];
        for (const a of node.all((n) => n.tag === "a")) {
          const href = a.attr("href");
          if (href === undefined) continue;
          const m = this.media(href, ctx);
          if (!m) continue;
          const name = a.textContent === "" ? basename(removingPercentEncoding(href) ?? href) : a.textContent;
          const f: { name: string; asset?: AssetRef; url?: string } = { name };
          if (m.asset) f.asset = m.asset;
          if (m.url !== undefined) f.url = m.url;
          files.push(f);
        }
        if (files.length === 0 && text !== "") files = text.split(",").filter((s) => s.length > 0).map((s) => ({ name: trimSpaces(s) }));
        return files.length === 0 ? undefined : enumValue("files", files);
      }
      case "checkbox": {
        const cb = node.first((n) => n.has("checkbox"));
        if (cb) return enumValue("checkbox", cb.has("checkbox-on"));
        return enumValue("checkbox", ["yes", "true", "✓", "☑"].includes(text.toLowerCase()));
      }
      case "url": { const v = node.first((n) => n.tag === "a")?.attr("href") ?? text; return v === "" ? undefined : enumValue("url", v); }
      case "email": {
        const href = node.first((n) => n.tag === "a")?.attr("href");
        const v = href !== undefined ? href.replaceAll("mailto:", "") : text;
        return v === "" ? undefined : enumValue("email", v);
      }
      case "phone": {
        const href = node.first((n) => n.tag === "a")?.attr("href");
        const v = href !== undefined ? href.replaceAll("tel:", "") : text;
        return v === "" ? undefined : enumValue("phone", v);
      }
      case "relation": {
        const ids: string[] = [], names: string[] = [];
        for (const a of node.all((n) => n.tag === "a")) {
          const href = a.attr("href");
          if (href === undefined) continue;
          names.push(a.textContent);
          const t = this.resolve(href, ctx);
          if (t) ids.push(t.id);
        }
        if (names.length > 0) {
          let m = this.relationTitles.get(row);
          if (!m) this.relationTitles.set(row, (m = new Map()));
          m.set(p.id, names);
        }
        return ids.length === 0 ? undefined : enumValue("relation", ids);
      }
      case "place": return text === "" ? undefined : enumValue("place", text);
      default: return undefined;
    }
  }

  // MARK: Abschluss

  /** BSD-377: Erwähnungen, Seitenlinks und Link-Blöcke, die auf die Notion-ID einer Datenbank zeigen, auf ihren Block umbiegen. */
  private resolveDatabaseAliases() {
    const aliases = this.dbAliases;
    for (const [k, v] of [...aliases]) if (this.builder.contains(k) || !this.builder.contains(v)) aliases.delete(k);
    if (aliases.size === 0) return;
    const fixRuns = (t: RichText | undefined): RichText | undefined => {
      if (!Array.isArray(t)) return undefined;
      let changed = false;
      const out = t.map((r) => {
        let x = r;
        const target = (r.mention as { page?: { _0?: string } } | undefined)?.page?._0;
        if (target !== undefined && aliases.has(target)) { x = { ...x, mention: { page: { _0: aliases.get(target)! } } }; changed = true; }
        const link = r.m?.link;
        const linked = link?.startsWith("based://page/") ? link.slice("based://page/".length) : undefined;
        if (linked !== undefined && aliases.has(linked)) { x = { ...x, m: { ...x.m, link: "based://page/" + aliases.get(linked)! } }; changed = true; }
        return x;
      });
      return changed ? out : undefined;
    };
    for (const b of [...this.builder.blocks]) {
      const text = fixRuns(b.text);
      const caption = fixRuns(b.props?.caption);
      const link = b.props?.linkTarget !== undefined ? aliases.get(b.props.linkTarget) : undefined;
      if (text === undefined && caption === undefined && link === undefined) continue;
      this.builder.update(b.id, (x) => {
        if (text !== undefined) x.text = text;
        if (caption !== undefined) x.props = { ...(x.props ?? {}), caption };
        if (link !== undefined) x.props = { ...(x.props ?? {}), linkTarget: link };
      });
    }
  }

  private finish() {
    // Verknüpfte Ansichten, deren Quelle später kam.
    for (const c of this.linkedCandidates) {
      if (this.linkedView(c.blockID, c.folder, c.table, c.parent, true) === undefined) {
        const ctx = newCtx(c.dir, joinPath(c.dir, "linked.html"), c.blockID);
        this.importDatabase(c.table, c.title, undefined, c.blockID, c.parent, c.inline, ctx, {});
      }
    }
    // Relationsziel: die Datenbank, in der die meisten verknüpften Zeilen liegen; sonst wird die Relation zu Text.
    for (const db of [...this.builder.databases]) {
      for (const p of db.properties) {
        if (p.type !== "relation") continue;
        const votes = new Map<string, number>();
        for (const b of this.builder.blocks) {
          if (b.parent !== "d:" + db.id) continue;
          const rel = (b.values?.[p.id] as { relation?: { _0: string[] } } | undefined)?.relation?._0;
          for (const id of rel ?? []) { const t = this.rowDatabase.get(id); if (t !== undefined) votes.set(t, (votes.get(t) ?? 0) + 1); }
        }
        let target: [string, number] | undefined;
        for (const [k, v] of votes) if (!target || v > target[1]) target = [k, v];
        if (target) {
          const t = target[0];
          this.builder.updateDatabase(db.id, (d) => { const x = d.properties.find((q) => q.id === p.id); if (x) x.relation = { databaseID: t }; });
        } else {
          this.builder.updateDatabase(db.id, (d) => {
            const x = d.properties.find((q) => q.id === p.id);
            if (x) { x.type = "text"; x.description = "Relation in Notion (related pages weren't part of this export)."; }
          });
          for (const b of this.builder.blocks) {
            if (b.parent !== "d:" + db.id) continue;
            const names = this.relationTitles.get(b.id)?.get(p.id) ?? [];
            this.builder.update(b.id, (x) => {
              x.values = { ...(x.values ?? {}) };
              if (names.length === 0) delete x.values[p.id]; else x.values[p.id] = enumValue("text", names.join(", "));
            });
          }
        }
      }
    }
    this.resolveDatabaseAliases();
    if (this.fallbackCount > 0) this.builder.notes.push(`${this.fallbackCount} block(s) without a native equivalent were kept as HTML blocks.`);
  }
}

// MARK: Statische Hilfen (Swift `NotionHTMLImporter.…`)

/** Swift `BlockType.supportsChildren`. */
export function supportsChildren(type: string): boolean {
  return ["text", "bulletedList", "numberedList", "todo", "toggle", "quote", "callout", "page", "column", "columnList", "table",
    "syncedBlock", "meeting", "meetingSection", "heading1", "heading2", "heading3", "heading4"].includes(type);
}

function split(nodes: HTMLNode[]): { inline: HTMLNode[]; blocks: HTMLNode[] } {
  const inline: HTMLNode[] = [], blocks: HTMLNode[] = [];
  for (const c of nodes) {
    if (blocks.length === 0 && INLINE_TAGS.has(c.tag)) inline.push(c);
    else if (!SKIP_TAGS.has(c.tag)) blocks.push(c);
  }
  return { inline, blocks };
}

const headerNames = (table: HTMLNode) => (table.first((n) => n.tag === "thead")?.all((n) => n.tag === "th") ?? []).map((th) => th.textContent);

/** „50%“ → 0.5, „calc((100% - 92px) * 0.3333)“ → 0.3333. */
export function columnRatio(w: string): number | undefined {
  const s = trimSpaces(w);
  if (s.endsWith("%")) { const v = parseSwiftDouble(s.slice(0, -1)); return v === undefined ? undefined : v / 100; }
  const star = s.lastIndexOf("*");
  if (star >= 0) return parseSwiftDouble([...s.slice(star + 1)].filter((c) => /\p{N}/u.test(c) || c === ".").join(""));
  return undefined;
}

const SVG_TYPES: [string, string][] = [
  ["typestitle", "title"], ["multipleselect", "multiSelect"], ["multiselect", "multiSelect"], ["status", "status"],
  ["createdby", "createdBy"], ["lasteditedby", "lastEditedBy"], ["updatedby", "lastEditedBy"], ["editedby", "lastEditedBy"],
  ["createdat", "createdTime"], ["createdtime", "createdTime"], ["updatedat", "lastEditedTime"], ["lasteditedtime", "lastEditedTime"], ["editedtime", "lastEditedTime"],
  ["select", "select"], ["date", "date"], ["person", "person"], ["people", "person"], ["file", "files"],
  ["checkbox", "checkbox"], ["url", "url"], ["email", "email"], ["phone", "phone"], ["number", "number"],
  ["formula", "formula"], ["relation", "relation"], ["rollup", "rollup"], ["autoincrement", "uniqueID"], ["uniqueid", "uniqueID"],
  ["location", "place"], ["place", "place"], ["button", "button"], ["verification", "verification"], ["text", "text"],
];

/** Property-Typ aus dem Symbol im Tabellenkopf. */
export function svgType(th: HTMLNode): string | undefined {
  const svg = th.first((n) => n.tag === "svg");
  if (!svg) return undefined;
  const c = (svg.attrs.get("class") ?? "").toLowerCase();
  for (const [k, t] of SVG_TYPES) if (c.includes(k)) return t;
  return undefined;
}

/** Property-Typ aus `property-row-<typ>` einer Zeilenseite. */
export function rowType(notion: string): string | undefined {
  const map: Record<string, string> = {
    title: "title", text: "text", rich_text: "text", number: "number", select: "select", multi_select: "multiSelect", status: "status",
    date: "date", person: "person", people: "person", file: "files", files: "files", checkbox: "checkbox", url: "url", email: "email",
    phone_number: "phone", formula: "formula", relation: "relation", rollup: "rollup", created_time: "createdTime", created_by: "createdBy",
    last_edited_time: "lastEditedTime", last_edited_by: "lastEditedBy", auto_increment_id: "uniqueID", unique_id: "uniqueID",
    place: "place", location: "place", button: "button", verification: "verification",
  };
  return Object.prototype.hasOwnProperty.call(map, notion) ? map[notion] : undefined;
}

const stripAt = (s: string) => (s.startsWith("@") ? s.slice(1) : s);

function people(node: HTMLNode): string[] {
  const users = node.all((n) => n.has("user")).map((n) => stripAt(n.textContent)).filter((s) => s !== "");
  if (users.length > 0) return users;
  const t = node.textContent;
  return t === "" ? [] : t.split(",").filter((s) => s.length > 0).map((s) => stripAt(trimSpaces(s)));
}

/** (Name, Farbe) der Auswahl-Chips einer Zelle. */
function optionValues(node: HTMLNode): [string, string][] {
  const chips = node.all((n) => n.has("selected-value") || n.has("status-value"));
  if (chips.length === 0) {
    const t = node.textContent;
    return t === "" ? [] : t.split(",").filter((s) => s.length > 0).map((s) => [trimSpaces(s), "default"]);
  }
  return chips.map((chip): [string, string] => {
    const colorClass = chip.classList.find((c) => c.startsWith("select-value-color-"))?.slice(19);
    return [chip.textContent, (colorClass !== undefined ? notionColor(colorClass) : undefined) ?? "default"];
  }).filter(([l]) => l !== "");
}

function statusGroups(opts: NonNullable<PropertySchema["options"]>, salt: string): NonNullable<PropertySchema["statusGroups"]> {
  const todo: string[] = [], doing: string[] = [], done: string[] = [];
  for (const o of opts) {
    const n = o.name.toLowerCase();
    if (o.color === "green" || ["done", "complete", "completed", "erledigt", "fertig", "closed", "shipped", "abgeschlossen"].some((k) => n.includes(k))) done.push(o.id);
    else if (o.color === "blue" || ["progress", "doing", "arbeit", "review", "active", "started"].some((k) => n.includes(k) && !n.includes("not started"))) doing.push(o.id);
    else todo.push(o.id);
  }
  return [
    { id: derivedID(salt, "todo"), name: "To-do", color: "gray", optionIDs: todo },
    { id: derivedID(salt, "doing"), name: "In progress", color: "blue", optionIDs: doing },
    { id: derivedID(salt, "done"), name: "Complete", color: "green", optionIDs: done },
  ];
}

function numberFormat(values: string[]): string | undefined {
  const v = values.map(trimSpaces).filter((s) => s !== "");
  if (v.length === 0) return undefined;
  const pairs: [string, string][] = [["$", "dollar"], ["€", "euro"], ["£", "pound"], ["¥", "yen"], ["₹", "rupee"], ["₩", "won"], ["R$", "real"], ["₽", "ruble"], ["₺", "lira"], ["CHF", "franc"]];
  for (const [sym, f] of pairs) if (v.every((s) => s.includes(sym))) return f;
  if (v.every((s) => s.endsWith("%"))) return "percent";
  if (v.some((s) => s.includes(","))) return "numberWithCommas";
  return undefined;
}

/** Zahl aus einer Zelle („$1,200.50“, „25%“ → 0.25). */
export function parseNotionNumber(raw: string): number | undefined {
  const t = trimSpaces(raw);
  if (t === "") return undefined;
  const pct = t.endsWith("%");
  const digits = [...t].filter((c) => /\p{N}/u.test(c) || c === "." || c === "-" || c === "e" || c === "E").join("");
  const d = parseSwiftDouble(digits);
  if (d === undefined) return undefined;
  return pct ? d / 100 : d;
}

function guessType(cells: HTMLNode[]): string {
  const hasCheckbox = (c: HTMLNode) => c.first((n) => n.has("checkbox")) !== undefined;
  const nonEmpty = cells.filter((c) => c.textContent !== "" || hasCheckbox(c));
  if (nonEmpty.length === 0) return "text";
  if (nonEmpty.every(hasCheckbox)) return "checkbox";
  if (nonEmpty.some((c) => c.first((n) => n.has("status-value")) !== undefined)) return "status";
  if (nonEmpty.some((c) => c.all((n) => n.has("selected-value")).length > 1)) return "multiSelect";
  if (nonEmpty.every((c) => c.first((n) => n.has("selected-value")) !== undefined)) return "select";
  if (nonEmpty.every((c) => c.first((n) => n.has("user")) !== undefined)) return "person";
  if (nonEmpty.every((c) => c.first((n) => n.tag === "time") !== undefined)) return "date";
  if (nonEmpty.every((c) => c.first((n) => n.has("url-value")) !== undefined)) return "url";
  if (nonEmpty.every((c) => c.first((n) => n.has("email-value")) !== undefined)) return "email";
  if (nonEmpty.every((c) => c.first((n) => n.has("phone-value")) !== undefined)) return "phone";
  if (nonEmpty.every((c) => c.first((n) => n.tag === "a" && (n.attr("href") ?? "").toLowerCase().includes(".html")) !== undefined)) return "relation";
  if (nonEmpty.every((c) => parseNotionNumber(c.textContent) !== undefined && c.elements.every((e) => e.tag === "span" || e.tag === "br"))) return "number";
  return "text";
}

export type { Block };
