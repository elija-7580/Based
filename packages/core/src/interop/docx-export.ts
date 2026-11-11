// BSD-260 Teil 6: Seite als Word-Dokument (.docx, Office Open XML) exportieren. Rein, ohne DOM; das ZIP schreibt
// `writeZip`. Gegenstück zu docx-import.ts – was der Import liest, schreibt der Export (Rundreise im Test):
// - Titel als Formatvorlage „Title“ und als Dokument-Eigenschaft
// - Text, Überschrift 1–3, Zitat, Code (Formatvorlage „SourceCode“, Courier New), Trennlinie
// - Listen über numbering.xml (Aufzählung, Nummerierung), verschachtelt bis Ebene 8; To-do als ☐/☑ vor dem Text
// - Text: fett, kursiv, unterstrichen, durchgestrichen, Code, Links (Beziehung, extern)
// - Tabellen (erste Zeile als Kopf), Bilder eingebettet (word/media), wenn `assetBytes` sie liefert, sonst ihr Name
// - Unterseiten und Datenbanken als Titelzeile (nicht ausgeklappt), Toggle/Callout als Absatz mit Inhalt darunter
import type { Block, BlockProps } from "../model/records.js";
import type { WorkspaceStore } from "../store/store.js";
import { markdownFileName } from "./markdown-export.js";
import { plain, runsOf, type Run } from "./runs.js";
import { writeZip } from "./zip.js";

type AssetRef = NonNullable<BlockProps["asset"]>;

export interface DocxExportOptions {
  /** Bytes einer Datei (Bilder werden eingebettet); ohne: Bild als Name im Text. */
  assetBytes?: ((a: AssetRef) => Uint8Array | undefined) | undefined;
  /** Zeitpunkt in den Dokument-Eigenschaften (Tests). */
  now?: Date | undefined;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  // In XML 1.0 verbotene Steuerzeichen fallen weg.
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

const HEADING: Record<string, string> = { heading1: "Heading1", heading2: "Heading2", heading3: "Heading3" };
const BULLET_NUM = 1, ORDERED_NUM = 2;
const MAX_LEVEL = 8;

/** Breite/Höhe aus PNG-, GIF- oder JPEG-Kopf (Pixel); sonst undefined. */
export function imageSize(b: Uint8Array): { w: number; h: number } | undefined {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { w: v.getUint32(16), h: v.getUint32(20) };
  }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: b[6]! | (b[7]! << 8), h: b[8]! | (b[9]! << 8) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1]!;
      const len = (b[i + 2]! << 8) | b[i + 3]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: (b[i + 5]! << 8) | b[i + 6]!, w: (b[i + 7]! << 8) | b[i + 8]! };
      }
      i += 2 + len;
    }
  }
  return undefined;
}

const EXT_MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", gif: "image/gif" };

class DocxWriter {
  private rels: string[] = [];
  private media: { path: string; data: Uint8Array }[] = [];
  private body: string[] = [];
  private nextRel = 10;
  private nextImage = 1;
  private exts = new Set<string>();

  constructor(private readonly store: WorkspaceStore, private readonly opts: DocxExportOptions) {}

  private rel(type: string, target: string, external = false): string {
    const id = `rId${this.nextRel++}`;
    this.rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ""}/>`);
    return id;
  }

  private runXML(r: Run): string {
    const m = r.m;
    const pr: string[] = [];
    if (m.b) pr.push("<w:b/>");
    if (m.i) pr.push("<w:i/>");
    if (m.u) pr.push('<w:u w:val="single"/>');
    if (m.s) pr.push("<w:strike/>");
    if (m.c) pr.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>');
    if (m.link) pr.unshift('<w:rStyle w:val="Hyperlink"/>');
    const rpr = pr.length ? `<w:rPr>${pr.join("")}</w:rPr>` : "";
    // Zeilenumbrüche und Tabs im Lauf
    const parts: string[] = [];
    for (const [i, line] of r.t.split("\n").entries()) {
      if (i > 0) parts.push("<w:br/>");
      for (const [j, seg] of line.split("\t").entries()) {
        if (j > 0) parts.push("<w:tab/>");
        if (seg !== "") parts.push(`<w:t xml:space="preserve">${esc(seg)}</w:t>`);
      }
    }
    const run = `<w:r>${rpr}${parts.join("")}</w:r>`;
    if (typeof m.link === "string" && m.link !== "") {
      if (m.link.startsWith("#")) return `<w:hyperlink w:anchor="${esc(m.link.slice(1))}">${run}</w:hyperlink>`;
      return `<w:hyperlink r:id="${this.rel("hyperlink", m.link, true)}">${run}</w:hyperlink>`;
    }
    return run;
  }

  private para(runs: Run[], ppr: string[] = [], prefix = ""): void {
    const p = ppr.length ? `<w:pPr>${ppr.join("")}</w:pPr>` : "";
    const lead = prefix ? `<w:r><w:t xml:space="preserve">${esc(prefix)}</w:t></w:r>` : "";
    this.body.push(`<w:p>${p}${lead}${runs.map((r) => this.runXML(r)).join("")}</w:p>`);
  }

  private image(a: AssetRef) {
    const bytes = this.opts.assetBytes?.(a);
    const ext = (a.name.split(".").pop() ?? "").toLowerCase();
    if (!bytes || !EXT_MIME[ext]) {
      this.para([{ t: a.name, m: {} }]);
      return;
    }
    const n = this.nextImage++;
    const path = `media/image${n}.${ext === "jpg" ? "jpeg" : ext}`;
    this.exts.add(ext === "jpg" ? "jpeg" : ext);
    this.media.push({ path: "word/" + path, data: bytes });
    const rid = this.rel("image", path);
    const size = imageSize(bytes) ?? { w: 800, h: 600 };
    // Höchstens 6 Zoll breit (Seitenbreite), Pixel bei 96 dpi; 1 Zoll = 914 400 EMU.
    const maxW = 6 * 914_400;
    let cx = Math.round((size.w / 96) * 914_400), cy = Math.round((size.h / 96) * 914_400);
    if (cx > maxW) { cy = Math.round((cy * maxW) / cx); cx = maxW; }
    const name = esc(a.name);
    this.body.push(`<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="${name}"/>` +
      `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
      `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);
  }

  private table(b: Block) {
    const rows = this.kids(b.id).filter((r) => r.type === "tableRow");
    if (rows.length === 0) return;
    const cols = Math.max(1, b.props?.tableColumns ?? 0, ...rows.map((r) => (r.props?.cells as unknown[] | undefined)?.length ?? 0));
    const header = b.props?.tableHeaderRow === true;
    const out: string[] = ['<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>'];
    for (let c = 0; c < cols; c++) out.push('<w:gridCol w:w="2000"/>');
    out.push("</w:tblGrid>");
    rows.forEach((r, i) => {
      const cells = (r.props?.cells as Parameters<typeof runsOf>[0][] | undefined) ?? [];
      out.push(`<w:tr>${i === 0 && header ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}`);
      for (let c = 0; c < cols; c++) {
        const runs = runsOf(cells[c]).map((x) => (i === 0 && header ? { ...x, m: { ...x.m, b: true } } : x));
        out.push(`<w:tc><w:p>${runs.map((x) => this.runXML(x)).join("")}</w:p></w:tc>`);
      }
      out.push("</w:tr>");
    });
    out.push("</w:tbl>");
    this.body.push(out.join(""));
    this.body.push("<w:p/>"); // Word braucht nach einer Tabelle einen Absatz
  }

  private kids(id: string): Block[] {
    return this.store.children("b:" + id).map((k) => this.store.blocks.get(k)).filter((b): b is Block => b !== undefined && b.trashedAt === undefined);
  }

  blocks(parent: string, level: number) {
    for (const b of this.kids(parent)) {
      const runs = runsOf(b.text);
      const lvl = Math.min(level, MAX_LEVEL);
      switch (b.type) {
        case "column": case "columnList": this.blocks(b.id, level); continue;
        case "heading1": case "heading2": case "heading3": this.para(runs, [`<w:pStyle w:val="${HEADING[b.type]}"/>`]); break;
        case "quote": this.para(runs, ['<w:pStyle w:val="Quote"/>']); break;
        case "code": this.para([{ t: plain(runs), m: {} }], ['<w:pStyle w:val="SourceCode"/>']); break;
        case "divider": this.body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>'); continue;
        case "bulletedList": case "numberedList":
          this.para(runs, [`<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${b.type === "numberedList" ? ORDERED_NUM : BULLET_NUM}"/></w:numPr>`]);
          this.blocks(b.id, level + 1);
          continue;
        case "todo": this.para(runs, level > 0 ? [`<w:ind w:left="${360 * level}"/>`] : [], b.props?.checked ? "☑ " : "☐ "); break;
        case "image": if (b.props?.asset) this.image(b.props.asset); break;
        case "file": case "pdf": case "video": case "audio": this.para([{ t: b.props?.asset?.name ?? (plain(runs) || b.type), m: {} }]); break;
        case "bookmark": case "embed": {
          const url = typeof b.props?.url === "string" ? b.props.url : "";
          if (url) this.para([{ t: plain(runs) || url, m: { link: url } }]);
          break;
        }
        case "table": this.table(b); continue;
        case "tableRow": continue;
        case "page": case "databasePage": case "databaseInline": case "linkedDatabase":
          this.para(b.type === "page" ? (runs.length ? runs : [{ t: "Untitled", m: {} }]) : [{ t: this.dbTitle(b), m: {} }], [], "↳ ");
          continue; // nicht ausklappen
        case "tableOfContents": case "breadcrumb": case "button": continue;
        default:
          if (runs.length > 0 || this.kids(b.id).length === 0) this.para(runs, level > 0 ? [`<w:ind w:left="${360 * level}"/>`] : []);
      }
      // Inhalt unter Toggle, Callout, To-do … eingerückt
      this.blocks(b.id, level + 1);
    }
  }

  private dbTitle(b: Block): string {
    const id = b.props?.databaseID;
    const db = typeof id === "string" ? this.store.databases.get(id) : undefined;
    return plain(runsOf(db?.title)) || "Untitled database";
  }

  build(page: Block): Uint8Array {
    const title = plain(runsOf(page.text)) || "Untitled";
    this.para([{ t: title, m: {} }], ['<w:pStyle w:val="Title"/>']);
    this.blocks(page.id, 0);
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W} xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
      `<w:body>${this.body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    const style = (id: string, name: string, inner: string, type = "paragraph") => `<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${name}"/>${inner}</w:style>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${W}>` +
      style("Normal", "Normal", '<w:qFormat/><w:rPr><w:sz w:val="22"/></w:rPr>') +
      style("Title", "Title", '<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/></w:rPr>') +
      style("Heading1", "heading 1", '<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr>') +
      style("Heading2", "heading 2", '<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr>') +
      style("Heading3", "heading 3", '<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr>') +
      style("Quote", "Quote", '<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="567"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="999999"/></w:pBdr></w:pPr><w:rPr><w:i/></w:rPr>') +
      style("SourceCode", "Source Code", '<w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:pPr><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/></w:rPr>') +
      style("ListParagraph", "List Paragraph", '<w:basedOn w:val="Normal"/><w:qFormat/>') +
      style("Hyperlink", "Hyperlink", '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr>', "character") +
      style("TableGrid", "Table Grid", '<w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="auto"/><w:left w:val="single" w:sz="4" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:color="auto"/><w:right w:val="single" w:sz="4" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:color="auto"/></w:tblBorders></w:tblPr>', "table") +
      "</w:styles>";
    const levels = (ordered: boolean) => Array.from({ length: MAX_LEVEL + 1 }, (_, i) =>
      `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${ordered ? (["decimal", "lowerLetter", "lowerRoman"][i % 3]) : "bullet"}"/>` +
      `<w:lvlText w:val="${ordered ? `%${i + 1}.` : ["•", "◦", "▪"][i % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join("");
    const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering ${W}>` +
      `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels(false)}</w:abstractNum>` +
      `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels(true)}</w:abstractNum>` +
      `<w:num w:numId="${BULLET_NUM}"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="${ORDERED_NUM}"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
      `${this.rels.join("")}</Relationships>`;
    const now = (this.opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>${esc(title)}</dc:title><dc:creator>Based</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
    const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      [...this.exts].map((e) => `<Default Extension="${e}" ContentType="${EXT_MIME[e]}"/>`).join("") +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>';
    const enc = new TextEncoder();
    return writeZip([
      { path: "[Content_Types].xml", data: enc.encode(types) },
      { path: "_rels/.rels", data: enc.encode(rootRels) },
      { path: "docProps/core.xml", data: enc.encode(core) },
      { path: "word/document.xml", data: enc.encode(document) },
      { path: "word/styles.xml", data: enc.encode(styles) },
      { path: "word/numbering.xml", data: enc.encode(numbering) },
      { path: "word/_rels/document.xml.rels", data: enc.encode(docRels) },
      ...this.media,
    ], this.opts.now);
  }
}

/** Seite als .docx (Name aus dem Titel). */
export function exportDocx(store: WorkspaceStore, pageID: string, opts: DocxExportOptions = {}): { name: string; data: Uint8Array } {
  const page = store.blocks.get(pageID);
  if (!page) throw new Error("This page doesn't exist.");
  const data = new DocxWriter(store, opts).build(page);
  return { name: markdownFileName(plain(runsOf(page.text)) || "Untitled") + ".docx", data };
}
