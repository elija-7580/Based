// Seiten → Markdown, Datenbanken → CSV (Swift Interop/MarkdownExport.swift).
import type { Block, BlockProps, Database, DatabaseView, PropertySchema } from "../model/records.js";
import { cellText, QueryEngine, rowsOf, titleOf } from "../query/engine.js";
import { isEmptyValue, longDate, plainNumber, toJSDate } from "../query/value.js";
import type { WorkspaceStore } from "../store/store.js";
import { encodeCSV, encodeInlineMarkdown } from "./markdown.js";
import { plain, runsOf } from "./runs.js";
import { graphemes } from "../graphemes.js";

type AssetRef = NonNullable<BlockProps["asset"]>;
export type PageLink = (id: string) => { title: string; url: string } | undefined;

/** Swift `addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)`. */
export function encodeURLPath(s: string, extraDisallowed = ""): string {
  const allowed = /[A-Za-z0-9\-._~!$&'()*+,;=:@/]/;
  let out = "";
  for (const ch of s) {
    if (allowed.test(ch) && !extraDisallowed.includes(ch)) { out += ch; continue; }
    for (const b of new TextEncoder().encode(ch)) out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** Dateiname aus einem Titel (Swift `MarkdownExporter.fileName`). */
export function markdownFileName(title: string): string {
  const s = title.split(/[/\\:?*"<>|\n]/).join(" ").replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "");
  return s === "" ? "Untitled" : graphemes(s.slice(0, 1024)).slice(0, 120).join("");
}

const contentBlocks = (store: WorkspaceStore, id: string): Block[] =>
  store.children("b:" + id).map((k) => store.blocks.get(k)).filter((b): b is Block => b !== undefined && b.trashedAt === undefined);

const isList = (t: string) => t === "bulletedList" || t === "numberedList" || t === "todo";

function timecode(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
}

const titleProp = (db: Database): PropertySchema => db.properties.find((p) => p.type === "title") ?? { id: "title", name: "Name", type: "title" };

/** Swift `DatabaseView.visiblePropertyIDs(in:)`. */
export function visiblePropertyIDs(v: DatabaseView, db: Database): string[] {
  const configured = v.properties ?? [];
  const ids = configured.filter((p) => p.visible).map((p) => p.id).filter((id) => db.properties.some((p) => p.id === id));
  const known = new Set(configured.map((p) => p.id));
  for (const p of db.properties) if (!known.has(p.id) && (v.type === "table" || p.type === "title")) ids.push(p.id);
  const title = titleProp(db).id;
  if (!ids.includes(title)) ids.unshift(title);
  return ids;
}

export interface MarkdownExporterOptions {
  pageLink?: PageLink;
  assetLink?: (a: AssetRef) => string;
  /** BSD-260: Eigenschaften als YAML-Frontmatter (Obsidian & Co.) statt als „Name: Wert“-Zeilen. */
  frontmatter?: boolean | undefined;
}

/** YAML-Skalar: einfache Wörter roh, sonst als JSON-String (gültiges YAML). */
export function yamlScalar(v: string | number | boolean): string {
  if (typeof v !== "string") return String(v);
  return /^[\p{L}\p{N}][\p{L}\p{N} _.\/-]*$/u.test(v) && !/^(true|false|null|yes|no|on|off|~)$/i.test(v) && !/^[\d.+-]+$/.test(v) && v.trim() === v ? v : JSON.stringify(v);
}

const isoDate = (swiftSeconds: number, withTime: boolean) => {
  const d = new Date(swiftSeconds * 1000 + 978_307_200_000).toISOString();
  return withTime ? d.replace(/\.\d{3}Z$/, "Z") : d.slice(0, 10);
};

export class MarkdownExporter {
  readonly pageLink: PageLink;
  readonly assetLink: (a: AssetRef) => string;
  readonly frontmatter: boolean;
  private engine: QueryEngine | undefined;

  constructor(readonly store: WorkspaceStore, opts: MarkdownExporterOptions = {}) {
    this.pageLink = opts.pageLink ?? ((id) => {
      const t = titleOf(store, id);
      return { title: t, url: encodeURLPath(markdownFileName(t) + ".md") };
    });
    this.assetLink = opts.assetLink ?? ((a) => "assets/" + a.name);
    this.frontmatter = opts.frontmatter === true;
  }

  /** BSD-260: YAML-Frontmatter einer Seite (Titel, Icon, Zeiten, Properties einer Datenbankzeile). */
  frontmatterOf(id: string): string {
    const page = this.store.blocks.get(id);
    if (!page) return "";
    const lines = ["---", `title: ${yamlScalar(titleOf(this.store, id))}`];
    const icon = page.props?.icon;
    if (typeof icon === "string" && icon !== "") lines.push(`icon: ${yamlScalar(icon)}`);
    lines.push(`created: ${isoDate(page.createdAt, true)}`, `updated: ${isoDate(page.updatedAt, true)}`);
    const db = page.parent.startsWith("d:") ? this.store.databases.get(page.parent.slice(2)) : undefined;
    for (const p of db ? db.properties : []) {
      if (p.type === "title" || !db) continue;
      const v = this.query.value(page, p, db);
      if (isEmptyValue(v)) continue;
      const key = yamlScalar(p.name);
      if (v.t === "list") {
        lines.push(`${key}:`);
        for (const item of v.v) lines.push(`  - ${yamlScalar(cellText(this.store, item))}`);
      } else if (v.t === "date") lines.push(`${key}: ${isoDate(v.v.start, v.v.includeTime)}`);
      else if (v.t === "number") lines.push(`${key}: ${v.v}`);
      else if (v.t === "bool") lines.push(`${key}: ${v.v}`);
      else lines.push(`${key}: ${yamlScalar(cellText(this.store, v))}`);
    }
    lines.push("---");
    return lines.join("\n");
  }

  private get query() { return (this.engine ??= new QueryEngine(this.store)); }

  /** Ganze Seite: „# Titel“, Properties (Zeilen), Inhalt. */
  export(id: string, includeTitle = true): string {
    const page = this.store.blocks.get(id);
    if (!page) return "";
    const lines: string[] = [];
    if (this.frontmatter) lines.push(this.frontmatterOf(id), "");
    if (includeTitle) lines.push("# " + titleOf(this.store, id), "");
    const db = page.parent.startsWith("d:") ? this.store.databases.get(page.parent.slice(2)) : undefined;
    if (db && !this.frontmatter) {
      const props: string[] = [];
      for (const p of db.properties) {
        if (p.type === "title") continue;
        const v = this.query.value(page, p, db);
        if (isEmptyValue(v)) continue;
        props.push(`${p.name}: ${cellText(this.store, v)}`);
      }
      if (props.length > 0) lines.push(...props, "");
    }
    lines.push(this.exportBlocks(contentBlocks(this.store, id), 0));
    return lines.join("\n").replace(/^[\n\r]+|[\n\r]+$/g, "") + "\n";
  }

  inline(t: Block["text"]): string { return encodeInlineMarkdown(t, this.pageLink); }

  exportBlocks(blocks: Block[], indent: number): string {
    const out: string[] = [];
    const pad = "    ".repeat(indent);
    let number = 0;
    blocks.forEach((b, idx) => {
      number = b.type === "numberedList" ? number + 1 : 0;
      const kids = contentBlocks(this.store, b.id);
      const pageLike = b.type === "page" || b.type === "databasePage";
      const nested = (extra = 1) => (kids.length === 0 || pageLike ? undefined : this.exportBlocks(kids, indent + extra));
      const text = this.inline(b.text).replaceAll("\n", "<br>");
      const p = b.props ?? {};
      let line: string;
      switch (b.type) {
        case "text": line = text; break;
        case "heading1": line = "# " + text; break;
        case "heading2": line = "## " + text; break;
        case "heading3": line = "### " + text; break;
        case "heading4": line = "#### " + text; break;
        case "bulletedList": line = "- " + text; break;
        case "numberedList": line = `${number}. ` + text; break;
        case "todo": line = (p.checked === true ? "- [x] " : "- [ ] ") + text; break;
        case "toggle": {
          const n = nested(0);
          const inner = n !== undefined ? "\n\n" + n + "\n" : "";
          out.push(pad + `<details>\n<summary>${text}</summary>${inner}\n</details>`.replaceAll("\n", "\n" + pad));
          if (idx < blocks.length - 1) out.push("");
          return;
        }
        case "quote": line = "> " + text.replaceAll("<br>", "\n> "); break;
        case "callout": {
          const icon = typeof p.icon === "string" ? p.icon + " " : "";
          const n = nested(0);
          out.push(pad + `<aside>\n${icon}${text}${n !== undefined ? "\n" + n : ""}\n</aside>`.replaceAll("\n", "\n" + pad));
          return;
        }
        case "divider": line = "---"; break;
        case "code": line = "```" + (p.language ?? "").replaceAll("plain text", "") + "\n" + plain(runsOf(b.text)) + "\n```"; break;
        case "equation": line = "$$\n" + (p.expression ?? plain(runsOf(b.text))) + "\n$$"; break;
        case "image": line = `![${p.caption !== undefined ? plain(runsOf(p.caption)) : ""}](${p.url ?? (p.asset ? this.assetLink(p.asset) : "")})`; break;
        case "video": case "audio": case "file": case "pdf": case "embed": case "bookmark": {
          const url = p.url ?? (p.asset ? this.assetLink(p.asset) : "");
          const label = p.bookmark?.title ?? (p.caption !== undefined ? plain(runsOf(p.caption)) : undefined) ?? p.asset?.name ?? url;
          line = `[${label === "" ? url : label}](${url})`;
          break;
        }
        case "page": case "databasePage": case "linkToPage": {
          const target = b.type === "linkToPage" ? (p.linkTarget ?? b.id) : b.id;
          const l = this.pageLink(target);
          line = l ? `[${l.title}](${l.url})` : titleOf(this.store, target);
          break;
        }
        case "databaseInline": {
          const title = titleOf(this.store, b.id);
          line = `[${title}](${encodeURLPath(markdownFileName(title) + ".csv")})`;
          break;
        }
        case "table": line = this.table(b); break;
        case "meeting":
          out.push(pad + this.meeting(b).replaceAll("\n", "\n" + pad));
          if (idx < blocks.length - 1) out.push("");
          return;
        case "columnList": case "column": case "syncedBlock":
          if (kids.length > 0) out.push(this.exportBlocks(kids, indent));
          return;
        default: return; // tableOfContents, breadcrumb, button, tableRow, meetingSection, transcript, unbekannt
      }
      out.push(pad + line.replaceAll("\n", "\n" + pad));
      const n = nested();
      if (n !== undefined) out.push(n);
      // Leerzeile zwischen Absätzen, Listen bleiben eng.
      const next = blocks[idx + 1];
      if (!(isList(b.type) && next?.type === b.type) && next !== undefined) out.push("");
    });
    return out.join("\n");
  }

  /** Meeting als Überschrift mit Zusammenfassung, Notizen und Transkript. */
  meeting(b: Block): string {
    const parts = ["## " + this.inline(b.text)];
    const info = b.props?.meeting;
    // ISO8601DateFormatter ohne Zeitzone im Text, rechnet aber in GMT.
    if (info?.startedAt !== undefined) {
      parts.push("*" + toJSDate(info.startedAt).toISOString().slice(0, 19) + (info.duration !== undefined ? " · " + timecode(info.duration) : "") + "*");
    }
    const content = contentBlocks(this.store, b.id);
    for (const kind of ["summary", "notes"] as const) {
      const sec = content.find((c) => c.props?.meetingSection === kind);
      if (!sec) continue;
      const kids = contentBlocks(this.store, sec.id);
      if (kids.length === 0) continue;
      parts.push("### " + (kind === "summary" ? "Summary" : "Notes"));
      parts.push(this.exportBlocks(kids, 0));
    }
    const segs = content.filter((c) => c.type === "transcript").flatMap((c) => c.props?.segments ?? []);
    if (segs.length > 0) {
      const finals = segs.filter((s) => s.p !== true).sort((x, y) => (x.s !== y.s ? x.s - y.s : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
      const paragraphs: { speaker: string | undefined; segs: typeof finals }[] = [];
      for (const s of finals) {
        const last = paragraphs[paragraphs.length - 1];
        if (last && last.speaker === s.sp && s.s - last.segs[last.segs.length - 1]!.e <= 8) last.segs.push(s);
        else paragraphs.push({ speaker: s.sp, segs: [s] });
      }
      const speakerName = (id: string | undefined) => {
        if (!info) return "Unknown";
        if (id === undefined) return "Unknown";
        const sp = info.speakers?.find((x) => x.id === id);
        if (sp) return sp.name;
        return id === "me" ? "Me" : id === "others" ? "Others" : id;
      };
      parts.push("### Transcript");
      parts.push(paragraphs.map((para) => `**${speakerName(para.speaker)}** [${timecode(para.segs[0]!.s)}]: ${para.segs.map((s) => s.t).join(" ")}`).join("\n\n"));
    }
    return parts.join("\n\n");
  }

  table(b: Block): string {
    const rows = contentBlocks(this.store, b.id).filter((r) => r.type === "tableRow");
    const cols = Math.max(1, b.props?.tableColumns ?? (rows.length ? Math.max(...rows.map((r) => r.props?.cells?.length ?? 0)) : 1));
    const cell = (r: Block, i: number) => {
      const c = r.props?.cells ?? [];
      return i < c.length ? this.inline(c[i]).replaceAll("|", "\\|").replaceAll("\n", "<br>") : "";
    };
    let lines: string[] = [];
    rows.forEach((r, ri) => {
      lines.push("| " + Array.from({ length: cols }, (_, i) => cell(r, i)).join(" | ") + " |");
      if (ri === 0) lines.push("|" + " --- |".repeat(cols));
    });
    if (rows.length === 0) lines = ["| " + " |".repeat(cols), "|" + " --- |".repeat(cols)];
    return lines.join("\n");
  }

  /** CSV einer Datenbank (Titelspalte zuerst wie Notion). */
  csv(databaseID: string, viewID?: string): string {
    const db = this.store.databases.get(databaseID);
    if (!db) return "";
    let rows: Block[];
    let props = [...db.properties];
    const v = viewID !== undefined ? this.store.views.get(viewID) : undefined;
    if (v) {
      rows = this.query.run(v).rows;
      props = visiblePropertyIDs(v, db).map((id) => db.properties.find((p) => p.id === id) ?? (titleProp(db).id === id ? titleProp(db) : undefined))
        .filter((p): p is PropertySchema => p !== undefined);
    } else {
      rows = rowsOf(this.store, databaseID).filter((r) => r.props?.isTemplate !== true);
    }
    const ti = props.findIndex((p) => p.type === "title");
    if (ti >= 0) props.unshift(...props.splice(ti, 1)); else props.unshift(titleProp(db));
    const table: string[][] = [props.map((p) => p.name)];
    for (const r of rows) {
      table.push(props.map((p) => {
        const val = this.query.value(r, p, db);
        if (val.t === "bool") return val.v ? "Yes" : "No";
        if (val.t === "date") return longDate(val.v);
        if (val.t === "number" && p.type === "uniqueID") return (p.idPrefix !== undefined ? p.idPrefix + "-" : "") + plainNumber(val.v);
        return cellText(this.store, val);
      }));
    }
    return encodeCSV(table, { guardFormulas: true });
  }
}
