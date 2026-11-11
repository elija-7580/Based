// BSD-260 Teil 2: Evernote-Export (.enex) importieren. Rein, ohne DOM.
// Ein Notizbuch (eine .enex-Datei) wird eine Datenbank: Zeilen = Notizen mit Inhalt, Properties Tags (Mehrfachauswahl),
// Created, Updated, Source (URL) und Author – wie Notion es mit Evernote macht. Der Inhalt (ENML, ein HTML-Dialekt)
// läuft durch den HTML-Importer der Zwischenablage; Evernote-Eigenheiten werden vorher übersetzt:
// - <en-media hash="…"> → Bild-, PDF-, Audio-, Video- oder Datei-Block mit der Datei aus <resource> (Zuordnung per MD5)
// - <en-todo checked="true"/> (alte Notizen) und <ul style="--en-todo:true"> (neue) → To-dos
// - <en-crypt> → Hinweis „[encrypted content]“ (Based entschlüsselt nicht)
import type { Block, BlockProps, Database, DatabaseView, PropertySchema, PropertyValue, WireRecord } from "../model/records.js";
import { keyBetween, keysBetween } from "../sortkeys.js";
import { ZERO_STAMP } from "../hlc.js";
import { AssetRejected, emptyReport, makeBlock, makeRecordID, mimeFor, type AssetRef, type AssetSink, type ImportReport } from "./builder.js";
import { ClipboardHTMLImporter, type ImportedBlock } from "./clipboard.js";
import { decodeEntities, trimSpaces } from "./html.js";
import { md5Hex } from "./md5.js";
import { toRichText } from "./runs.js";
import { ImportCancelled } from "./zip.js";

export interface EnexImportOptions {
  assets?: AssetSink | undefined;
  now?: (() => number) | undefined;
  userID?: string | null | undefined;
  isCancelled?: (() => boolean) | undefined;
}

export interface EnexResource { data: Uint8Array; mime: string; name: string | undefined; hash: string }
export interface EnexNote {
  title: string;
  /** ENML (ohne XML-Kopf). */
  content: string;
  created: number | undefined;
  updated: number | undefined;
  tags: string[];
  sourceURL: string | undefined;
  author: string | undefined;
  resources: EnexResource[];
}

const MEDIA_HOST = "https://enex.invalid/media/";
const PALETTE = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

const inner = (xml: string, tag: string): string | undefined => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? m[1] : undefined;
};
const all = (xml: string, tag: string): string[] => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]!);
/** Text eines Elements: CDATA roh, sonst Entities auflösen. */
const textOf = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const c = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  return c ? c[1]! : decodeEntities(raw);
};

/** `20200131T235959Z` → Swift-Sekunden (seit 2001). */
export function enexDate(s: string | undefined): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(trimSpaces(s ?? ""));
  if (!m) return undefined;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  return (Date.UTC(y, mo - 1, d, h, mi, se) - 978_307_200_000) / 1000;
}

function base64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Alle Notizen einer .enex-Datei. */
export function parseEnex(xml: string): EnexNote[] {
  return all(xml, "note").map((n) => {
    const attrs = inner(n, "note-attributes") ?? "";
    const resources = all(n, "resource").flatMap((r): EnexResource[] => {
      const raw = inner(r, "data");
      if (raw === undefined) return [];
      let data: Uint8Array;
      try { data = base64(raw); } catch { return []; }
      const ra = inner(r, "resource-attributes") ?? "";
      return [{ data, mime: trimSpaces(textOf(inner(r, "mime")) ?? "application/octet-stream"), name: textOf(inner(ra, "file-name"))?.trim() || undefined, hash: md5Hex(data) }];
    });
    const content = (textOf(inner(n, "content")) ?? "").replace(/<\?xml[\s\S]*?\?>/, "").replace(/<!DOCTYPE[\s\S]*?>/i, "");
    return {
      title: trimSpaces(textOf(inner(n, "title")) ?? "") || "Untitled",
      content,
      created: enexDate(textOf(inner(n, "created"))),
      updated: enexDate(textOf(inner(n, "updated"))),
      tags: all(n, "tag").map((t) => trimSpaces(textOf(t) ?? "")).filter((t) => t !== ""),
      sourceURL: textOf(inner(attrs, "source-url"))?.trim() || undefined,
      author: textOf(inner(attrs, "author"))?.trim() || undefined,
      resources,
    };
  });
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(2).find((x) => x !== undefined);

/** ENML → HTML für den Zwischenablage-Importer. */
export function enmlToHTML(enml: string): string {
  let h = enml.replace(/<en-note\b[^>]*>/i, "<body>").replace(/<\/en-note>/i, "</body>");
  h = h.replace(/<en-crypt\b[^>]*>[\s\S]*?<\/en-crypt>/gi, "<p>[encrypted content]</p>");
  h = h.replace(/<en-media\b([^>]*?)\/?>(?:\s*<\/en-media>)?/gi, (_m, a: string) => {
    const hash = attr(a, "hash")?.toLowerCase();
    return hash ? `<img src="${MEDIA_HOST}${hash}">` : "";
  });
  // Alte To-dos: eine Zeile, die mit <en-todo> beginnt.
  h = h.replace(/<(div|p)\b([^>]*)>\s*<en-todo\b([^>]*?)\/?>(?:\s*<\/en-todo>)?([\s\S]*?)<\/\1>/gi, (_m, _t: string, _a: string, ta: string, body: string) =>
    `<ul><li${/checked\s*=\s*["']?true/i.test(ta) ? ' class="checked"' : ""}><input type="checkbox"${/checked\s*=\s*["']?true/i.test(ta) ? " checked" : ""}>${body}</li></ul>`);
  h = h.replace(/<en-todo\b([^>]*?)\/?>(?:\s*<\/en-todo>)?/gi, (_m, a: string) => (/checked\s*=\s*["']?true/i.test(a) ? "☑ " : "☐ "));
  // Neue To-do-Listen: <ul style="--en-todo:true"><li style="--en-checked:true">
  h = h.replace(/<ul\b([^>]*--en-todo\s*:\s*true[^>]*)>/gi, '<ul class="to-do-list">');
  h = h.replace(/<li\b([^>]*--en-checked\s*:\s*true[^>]*)>/gi, '<li class="checked">');
  return h;
}

function mediaType(mime: string, name: string | undefined): string {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf" || name?.toLowerCase().endsWith(".pdf")) return "pdf";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return "file";
}

const EXT_OF_MIME: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav", "video/mp4": "mp4", "video/quicktime": "mov" };

export class EnexImporter {
  private records: WireRecord[] = [];
  private report = emptyReport();
  private readonly now: () => number;
  private readonly userID: string | null;

  constructor(private readonly opts: EnexImportOptions = {}) {
    this.now = opts.now ?? (() => (Date.now() - 978_307_200_000) / 1000);
    this.userID = opts.userID === undefined ? "me" : opts.userID;
  }

  private put(r: WireRecord) { this.records.push(r); }
  private warn(w: string) { if (!this.report.warnings.includes(w)) this.report.warnings.push(w); }

  private asset(r: EnexResource, n: number): AssetRef | undefined {
    if (!this.opts.assets) return undefined;
    const name = r.name ?? `attachment-${n}.${EXT_OF_MIME[r.mime.toLowerCase()] ?? "bin"}`;
    try {
      const ref = this.opts.assets.importData(r.data, name, r.mime || mimeFor(name.split(".").pop() ?? ""));
      this.report.assets += 1;
      return ref;
    } catch (e) {
      this.warn(e instanceof AssetRejected ? e.message : `Couldn't copy file ${name}`);
      return undefined;
    }
  }

  private putBlock(b: ImportedBlock, parent: string, sk: string) {
    const id = makeRecordID();
    const props: BlockProps = { ...b.props };
    if (b.type === "table" && props.tableColumns === undefined) props.tableColumns = 2;
    this.put({ kind: "block", data: makeBlock({ id, type: b.type, parent, sk, text: toRichText(b.text), props, createdBy: this.userID }, this.now()) });
    const keys = keysBetween(b.children.length, undefined, undefined);
    b.children.forEach((c, i) => this.putBlock(c, "b:" + id, keys[i]!));
  }

  /** Bild-Blöcke mit Platzhalter-URL → Datei aus den Ressourcen (Art nach MIME-Typ). */
  private resolveMedia(blocks: ImportedBlock[], media: Map<string, { ref: AssetRef | undefined; res: EnexResource }>): ImportedBlock[] {
    return blocks.flatMap((b): ImportedBlock[] => {
      const url = b.props.url;
      if (b.type === "image" && typeof url === "string" && url.startsWith(MEDIA_HOST)) {
        const m = media.get(url.slice(MEDIA_HOST.length));
        if (!m) return [];
        const props: BlockProps = { ...b.props };
        delete props.url;
        if (m.ref) props.asset = m.ref;
        else if (m.res.name) props.caption = m.res.name;
        return [{ ...b, type: mediaType(m.res.mime, m.res.name), props, children: this.resolveMedia(b.children, media) }];
      }
      return [{ ...b, children: this.resolveMedia(b.children, media) }];
    });
  }

  /** Ein Notizbuch als Datenbank unter `w` (vorläufiger Schlüssel nach `afterKey`). */
  run(xml: string, title: string, afterKey?: string): { records: WireRecord[]; rootKeys: string[]; report: ImportReport } {
    const notes = parseEnex(xml);
    const now = this.now();
    const tagProp: PropertySchema = { id: makeRecordID(), name: "Tags", type: "multiSelect", options: [] };
    const allTags: string[] = [];
    for (const n of notes) for (const t of n.tags) if (!allTags.some((x) => x.toLowerCase() === t.toLowerCase())) allTags.push(t);
    tagProp.options = allTags.map((name, i) => ({ id: makeRecordID(), name, color: PALETTE[i % PALETTE.length] as never }));
    const created: PropertySchema = { id: makeRecordID(), name: "Created", type: "date" };
    const updated: PropertySchema = { id: makeRecordID(), name: "Updated", type: "date" };
    const source: PropertySchema = { id: makeRecordID(), name: "Source", type: "url" };
    const author: PropertySchema = { id: makeRecordID(), name: "Author", type: "text" };
    const props: PropertySchema[] = [{ id: "title", name: "Name", type: "title" }, tagProp, created, updated, source, author];
    const blockID = makeRecordID();
    const db: Database = { id: makeRecordID(), blockID, title, properties: props, createdAt: now, updatedAt: now, stamp: { ...ZERO_STAMP } };
    this.put({ kind: "database", data: db });
    const view: DatabaseView = { id: makeRecordID(), databaseID: db.id, blockID, name: "Table", type: "table", sortKey: keyBetween(undefined, undefined), createdAt: now, updatedAt: now, stamp: { ...ZERO_STAMP } };
    this.put({ kind: "view", data: view });
    const key = keyBetween(afterKey, undefined);
    this.put({ kind: "block", data: makeBlock({ id: blockID, type: "databasePage", parent: "w", sk: key, text: title, props: { databaseID: db.id, viewIDs: [view.id] }, createdBy: this.userID }, now) });
    this.report.databases += 1;
    this.report.rootIDs.push(blockID);

    const html = new ClipboardHTMLImporter();
    const keys = keysBetween(notes.length, undefined, undefined);
    notes.forEach((n, i) => {
      if (this.opts.isCancelled?.()) throw new ImportCancelled();
      const values: Record<string, PropertyValue> = {};
      const ev = (kind: string, v: unknown) => ({ [kind]: { _0: v } }) as PropertyValue;
      const tagIDs = n.tags.map((t) => tagProp.options!.find((o) => o.name.toLowerCase() === t.toLowerCase())!.id);
      if (tagIDs.length) values[tagProp.id] = ev("multiSelect", tagIDs);
      if (n.created !== undefined) values[created.id] = ev("date", { start: n.created, includeTime: true });
      if (n.updated !== undefined) values[updated.id] = ev("date", { start: n.updated, includeTime: true });
      if (n.sourceURL) values[source.id] = ev("url", n.sourceURL);
      if (n.author) values[author.id] = ev("text", n.author);
      const rowID = makeRecordID();
      const row: Block = makeBlock({ id: rowID, type: "page", parent: "d:" + db.id, sk: keys[i]!, text: n.title, values, createdBy: this.userID, ...(n.created !== undefined ? { createdAt: n.created } : {}) }, now);
      if (n.updated !== undefined) row.updatedAt = n.updated;
      this.put({ kind: "block", data: row });
      this.report.rows += 1;
      const media = new Map<string, { ref: AssetRef | undefined; res: EnexResource }>();
      n.resources.forEach((r, ri) => media.set(r.hash, { ref: this.asset(r, ri + 1), res: r }));
      const blocks = this.resolveMedia(html.parse(enmlToHTML(n.content)), media);
      // Dateien, die der Inhalt nicht zeigt, ans Ende (Evernote hängt sie manchmal nur an).
      const shown = new Set<string>([...n.content.matchAll(/hash\s*=\s*["']([0-9a-fA-F]{32})/g)].map((m) => m[1]!.toLowerCase()));
      for (const r of n.resources) {
        if (shown.has(r.hash)) continue;
        const m = media.get(r.hash)!;
        blocks.push({ type: mediaType(r.mime, r.name), text: [], props: m.ref ? { asset: m.ref } : r.name ? { caption: r.name } : {}, children: [] });
      }
      const bk = keysBetween(blocks.length, undefined, undefined);
      blocks.forEach((b, j) => this.putBlock(b, "b:" + rowID, bk[j]!));
    });
    this.report.warnings.unshift(`Evernote notebook “${title}”: ${notes.length} notes`);
    return { records: this.records, rootKeys: [key], report: this.report };
  }
}
