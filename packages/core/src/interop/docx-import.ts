// BSD-260 Teil 4: Word-Dokumente (.docx, Office Open XML) importieren. Rein, ohne DOM; das ZIP liest `extractZip`.
// Eine Datei → eine Seite (Titel: Dokument-Eigenschaft, sonst „Title“-Absatz, sonst Dateiname).
// - Absätze mit Formatvorlagen: Überschrift 1–3 (auch „Heading1“, „berschrift1“ …), Zitat, Code („HTML Preformatted“,
//   Formatvorlagen mit „Code“), Titel
// - Listen über numbering.xml: Aufzählung oder Nummerierung, Einrückungsebene → verschachtelt
// - Text: fett, kursiv, unterstrichen, durchgestrichen, Code (Courier/Consolas/Menlo), Links (r:id oder Anker)
// - Tabellen (erste Zeile als Kopf), Bilder (word/media über die Beziehungen) als Bild-Blöcke mit Datei
// - Zeilenumbruch und Tab im Absatz; Seitenumbrüche, Felder, Fußnoten und Kommentare fallen weg
import type { BlockProps, WireRecord } from "../model/records.js";
import { keyBetween, keysBetween } from "../sortkeys.js";
import { AssetRejected, emptyReport, makeBlock, makeRecordID, mimeFor, type AssetRef, type AssetSink, type ImportReport } from "./builder.js";
import { basename, extname, joinPath, normalizePath, type ImportFiles } from "./files.js";
import { decodeEntities, trimSpaces } from "./html.js";
import { normalize, PLAIN, toRichText, type Marks, type Run } from "./runs.js";

// MARK: kleines XML

export interface XNode { name: string; attrs: Record<string, string>; children: XNode[]; text: string }

/** Minimaler XML-Leser (Elemente, Attribute, Text; keine DTD). Namen behalten das Präfix (`w:p`). */
export function parseXML(xml: string): XNode {
  const root: XNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XNode[] = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) { top.children.push({ name: "#text", attrs: {}, children: [], text: m[1] }); continue; }
    if (m[6] !== undefined) { if (m[6].trim() !== "" || top.name === "w:t") top.children.push({ name: "#text", attrs: {}, children: [], text: decodeEntities(m[6]) }); continue; }
    if (m[3] === undefined) continue;
    if (m[2] === "/") { if (stack.length > 1) stack.pop(); continue; }
    const attrs: Record<string, string> = {};
    for (const a of (m[4] ?? "").matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? "");
    const node: XNode = { name: m[3], attrs, children: [], text: "" };
    top.children.push(node);
    if (m[5] !== "/") stack.push(node);
  }
  return root;
}

const kids = (n: XNode | undefined, name: string) => (n ? n.children.filter((c) => c.name === name) : []);
const kid = (n: XNode | undefined, name: string) => n?.children.find((c) => c.name === name);
function find(n: XNode, name: string): XNode | undefined {
  for (const c of n.children) {
    if (c.name === name) return c;
    const f = find(c, name);
    if (f) return f;
  }
  return undefined;
}
function findAll(n: XNode, name: string, out: XNode[] = []): XNode[] {
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}
const textIn = (n: XNode): string => (n.name === "#text" ? n.text : n.children.map(textIn).join(""));
const on = (prop: XNode | undefined) => prop !== undefined && !["0", "false", "none"].includes((prop.attrs["w:val"] ?? "").toLowerCase());

// MARK: Import

export interface DocxImportOptions {
  assets?: AssetSink | undefined;
  now?: (() => number) | undefined;
  userID?: string | null | undefined;
}

interface DBlock { type: string; text: Run[]; props: BlockProps; children: DBlock[]; level?: number }

const CODE_FONTS = /courier|consolas|menlo|monaco|mono|source code/i;

export class DocxImporter {
  private rels = new Map<string, { target: string; external: boolean }>();
  /** numId → Ebene → nummeriert? */
  private numbering = new Map<string, Map<number, boolean>>();
  private styles = new Map<string, string>();
  private report = emptyReport();
  private readonly now: () => number;
  private readonly userID: string | null;

  constructor(private readonly files: ImportFiles, private readonly root: string, private readonly opts: DocxImportOptions = {}) {
    this.now = opts.now ?? (() => (Date.now() - 978_307_200_000) / 1000);
    this.userID = opts.userID === undefined ? "me" : opts.userID;
  }

  private xml(path: string): XNode | undefined {
    const t = this.files.readText(normalizePath(joinPath(this.root, path)));
    return t === undefined ? undefined : parseXML(t);
  }

  private load() {
    const rels = this.xml("word/_rels/document.xml.rels");
    for (const r of rels ? findAll(rels, "Relationship") : []) {
      this.rels.set(r.attrs.Id ?? "", { target: r.attrs.Target ?? "", external: (r.attrs.TargetMode ?? "") === "External" });
    }
    const num = this.xml("word/numbering.xml");
    if (num) {
      const abstract = new Map<string, Map<number, boolean>>();
      for (const a of findAll(num, "w:abstractNum")) {
        const levels = new Map<number, boolean>();
        for (const l of kids(a, "w:lvl")) levels.set(Number(l.attrs["w:ilvl"] ?? 0), (kid(l, "w:numFmt")?.attrs["w:val"] ?? "bullet") !== "bullet");
        abstract.set(a.attrs["w:abstractNumId"] ?? "", levels);
      }
      for (const n of findAll(num, "w:num")) {
        const ref = kid(n, "w:abstractNumId")?.attrs["w:val"] ?? "";
        this.numbering.set(n.attrs["w:numId"] ?? "", abstract.get(ref) ?? new Map());
      }
    }
    const st = this.xml("word/styles.xml");
    for (const s of st ? findAll(st, "w:style") : []) {
      const name = kid(s, "w:name")?.attrs["w:val"];
      if (name) this.styles.set(s.attrs["w:styleId"] ?? "", name);
    }
  }

  private styleKind(styleID: string | undefined): string | undefined {
    if (!styleID) return undefined;
    const name = (this.styles.get(styleID) ?? styleID).toLowerCase().replace(/\s+/g, "");
    const id = styleID.toLowerCase();
    const h = /^(heading|überschrift|berschrift|titre|título|titolo|kop)(\d)$/.exec(name) ?? /^(heading)(\d)$/.exec(id);
    if (h) return Number(h[2]) <= 1 ? "heading1" : Number(h[2]) === 2 ? "heading2" : "heading3";
    if (name === "title" || name === "titel") return "title";
    if (name === "subtitle" || name === "untertitel") return "heading3";
    if (name.includes("quote") || name.includes("zitat")) return "quote";
    if (name.includes("code") || name === "htmlpreformatted" || name === "plaintext") return "code";
    return undefined;
  }

  private asset(rid: string): AssetRef | undefined {
    const rel = this.rels.get(rid);
    if (!rel || rel.external || !this.opts.assets) return undefined;
    const path = normalizePath(joinPath(this.root, joinPath("word", rel.target.replace(/^\//, "../"))));
    const data = this.files.read(path);
    if (!data) { this.warn(`Couldn't read ${basename(path)} from the document`); return undefined; }
    try {
      const ref = this.opts.assets.importData(data, basename(path), mimeFor(extname(path)));
      this.report.assets += 1;
      return ref;
    } catch (e) {
      this.warn(e instanceof AssetRejected ? e.message : `Couldn't copy ${basename(path)}`);
      return undefined;
    }
  }

  private warn(w: string) { if (!this.report.warnings.includes(w)) this.report.warnings.push(w); }

  /** Läufe eines Absatzes (auch in Links und Feldern); Bilder getrennt. */
  private runs(p: XNode, images: AssetRef[], link?: string): Run[] {
    const out: Run[] = [];
    for (const c of p.children) {
      if (c.name === "w:hyperlink") {
        const rid = c.attrs["r:id"];
        const target = rid ? this.rels.get(rid)?.target : undefined;
        out.push(...this.runs(c, images, target && /^(https?|mailto):/.test(target) ? target : link));
        continue;
      }
      if (c.name === "w:smartTag" || c.name === "w:sdt" || c.name === "w:sdtContent" || c.name === "w:ins" || c.name === "w:fldSimple") { out.push(...this.runs(c, images, link)); continue; }
      if (c.name !== "w:r") continue;
      const pr = kid(c, "w:rPr");
      const marks: Marks = { ...PLAIN };
      if (on(kid(pr, "w:b"))) marks.b = true;
      if (on(kid(pr, "w:i"))) marks.i = true;
      if (kid(pr, "w:u") && (kid(pr, "w:u")!.attrs["w:val"] ?? "single") !== "none") marks.u = true;
      if (on(kid(pr, "w:strike")) || on(kid(pr, "w:dstrike"))) marks.s = true;
      const font = kid(pr, "w:rFonts")?.attrs["w:ascii"] ?? "";
      const rStyle = (kid(pr, "w:rStyle")?.attrs["w:val"] ?? "");
      if (CODE_FONTS.test(font) || /verbatim|code/i.test(this.styles.get(rStyle) ?? rStyle)) marks.c = true;
      if (link) marks.link = link;
      for (const r of c.children) {
        if (r.name === "w:t") out.push({ t: textIn(r), m: marks });
        else if (r.name === "w:tab") out.push({ t: "\t", m: marks });
        else if (r.name === "w:br" || r.name === "w:cr") { if ((r.attrs["w:type"] ?? "") !== "page") out.push({ t: "\n", m: marks }); }
        else if (r.name === "w:drawing" || r.name === "w:pict") {
          for (const blip of [...findAll(r, "a:blip"), ...findAll(r, "v:imagedata")]) {
            const rid = blip.attrs["r:embed"] ?? blip.attrs["r:id"];
            const ref = rid ? this.asset(rid) : undefined;
            if (ref) images.push(ref);
          }
        }
      }
    }
    return normalize(out);
  }

  private paragraph(p: XNode, out: DBlock[], title: { value: string | undefined }) {
    const pr = kid(p, "w:pPr");
    const images: AssetRef[] = [];
    const text = this.runs(p, images);
    let kind = this.styleKind(kid(pr, "w:pStyle")?.attrs["w:val"]);
    const numPr = kid(pr, "w:numPr");
    const plainText = text.map((r) => r.t).join("");
    if (kind === "title") {
      // Der Titel-Absatz wird der Seitentitel (oder fällt weg, wenn er ihm gleicht).
      const t = trimSpaces(plainText);
      if (title.value === undefined && t !== "") { title.value = t; return; }
      if (t === "" || t === title.value) return;
      kind = "heading1";
    }
    if (numPr && kind === undefined) {
      const numId = kid(numPr, "w:numId")?.attrs["w:val"] ?? "";
      const level = Number(kid(numPr, "w:ilvl")?.attrs["w:val"] ?? 0);
      if (numId !== "0") {
        const numbered = this.numbering.get(numId)?.get(level) ?? false;
        out.push({ type: numbered ? "numberedList" : "bulletedList", text, props: {}, children: [], level });
        for (const a of images) out.push({ type: "image", text: [], props: { asset: a }, children: [] });
        return;
      }
    }
    if (plainText.trim() !== "" || images.length === 0) {
      if (kind === "code") {
        const prev = out[out.length - 1];
        // Aufeinanderfolgende Code-Absätze sind ein Block.
        if (prev && prev.type === "code" && prev.level === undefined) prev.text = normalize([...prev.text, { t: "\n" + plainText, m: PLAIN }]);
        else out.push({ type: "code", text: [{ t: plainText, m: PLAIN }], props: {}, children: [] });
      } else if (plainText.trim() !== "") {
        out.push({ type: kind ?? "text", text, props: {}, children: [] });
      }
    }
    for (const a of images) out.push({ type: "image", text: [], props: { asset: a }, children: [] });
  }

  private table(t: XNode, out: DBlock[]) {
    const rows = kids(t, "w:tr").map((tr) => kids(tr, "w:tc").map((tc) => {
      const parts = kids(tc, "w:p").map((p) => this.runs(p, []));
      const runs: Run[] = [];
      parts.forEach((r, i) => { if (i > 0) runs.push({ t: "\n", m: PLAIN }); runs.push(...r); });
      return toRichText(normalize(runs));
    }));
    const cols = Math.max(1, ...rows.map((r) => r.length));
    out.push({ type: "table", text: [], props: { tableColumns: cols, tableHeaderRow: true }, children: rows.map((r) => ({ type: "tableRow", text: [], props: { cells: Array.from({ length: cols }, (_, k) => r[k] ?? "") }, children: [] })) });
  }

  /** Listen nach Ebene verschachteln. */
  private nest(blocks: DBlock[]): DBlock[] {
    const out: DBlock[] = [];
    const stack: DBlock[] = [];
    for (const b of blocks) {
      if (b.level === undefined) { out.push(b); stack.length = 0; continue; }
      while (stack.length > 0 && (stack[stack.length - 1]!.level ?? 0) >= b.level) stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(b);
      else out.push(b);
      stack.push(b);
    }
    return out;
  }

  /** Das Dokument als Seite unter `w` (vorläufiger Schlüssel nach `afterKey`). */
  run(fallbackTitle: string, afterKey?: string): { records: WireRecord[]; rootKeys: string[]; report: ImportReport } {
    const doc = this.xml("word/document.xml");
    if (!doc) throw new Error(`${fallbackTitle}: not a Word document (word/document.xml is missing)`);
    this.load();
    const core = this.xml("docProps/core.xml");
    const title: { value: string | undefined } = { value: core ? trimSpaces(textIn(find(core, "dc:title") ?? { name: "", attrs: {}, children: [], text: "" })) || undefined : undefined };
    const body = find(doc, "w:body");
    const flat: DBlock[] = [];
    const walk = (n: XNode) => {
      for (const c of n.children) {
        if (c.name === "w:p") this.paragraph(c, flat, title);
        else if (c.name === "w:tbl") this.table(c, flat);
        else if (c.name === "w:sdt" || c.name === "w:sdtContent" || c.name === "w:customXml") walk(c);
      }
    };
    if (body) walk(body);
    while (flat.length > 0 && flat[flat.length - 1]!.type === "text" && flat[flat.length - 1]!.text.every((r) => r.t.trim() === "")) flat.pop();
    const blocks = this.nest(flat);
    const records: WireRecord[] = [];
    const now = this.now();
    const pageID = makeRecordID();
    const key = keyBetween(afterKey, undefined);
    records.push({ kind: "block", data: makeBlock({ id: pageID, type: "page", parent: "w", sk: key, text: title.value ?? fallbackTitle, createdBy: this.userID }, now) });
    const put = (list: DBlock[], parent: string) => {
      const keys = keysBetween(list.length, undefined, undefined);
      list.forEach((b, i) => {
        const id = makeRecordID();
        records.push({ kind: "block", data: makeBlock({ id, type: b.type, parent, sk: keys[i]!, text: toRichText(b.text), props: b.props, createdBy: this.userID }, now) });
        put(b.children, "b:" + id);
      });
    };
    put(blocks, "b:" + pageID);
    this.report.pages = 1;
    this.report.rootIDs.push(pageID);
    return { records, rootKeys: [key], report: this.report };
  }
}
