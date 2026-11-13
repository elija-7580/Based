// Blöcke → HTML (Swift BasedCore Interop/HTMLExport.swift, `HTMLExporter.blocks`/`block`/`inline`).
// Für die Zwischenablage (headingOffset 0) und als Grundlage des Seitenexports.
import type { Block, BlockProps, RichText } from "../model/records.js";
import { cellText, QueryEngine, rowsOf, titleOf } from "../query/engine.js";
import { isEmptyValue, type Value } from "../query/value.js";
import type { Database, PropertySchema } from "../model/records.js";
import type { WorkspaceStore } from "../store/store.js";
import { sanitizeURL } from "./html.js";
import { plain, runsOf } from "./runs.js";
import { iconAsText } from "../editor/icon-ref.js";

type AssetRef = NonNullable<BlockProps["asset"]>;

export interface HTMLExporterOptions {
  /** Wie Links auf andere Seiten geschrieben werden; undefined → nur Text. */
  pageLink?: (id: string) => { title: string; url: string } | undefined;
  /** Wo eine Datei eines Blocks verlinkt wird (Standard `assets/<name>`). */
  assetLink?: (a: AssetRef) => string;
  /** Seiten haben den Titel in <h1>, Blocküberschriften beginnen bei <h2>; Zwischenablage: 0. */
  headingOffset?: number;
  /** Veröffentlichte Seiten: HTML-Blöcke laden von dieser URL statt `srcdoc`. */
  htmlBlockURL?: (id: string) => string;
  /**
   * BSD-236: Embeds als Rahmen (`"frame"`, mit `sandbox`) oder als Link-Karte (`"link"`). Ohne: Rahmen wie bisher
   * (Datei-Export). Veröffentlichte Seiten zeigen fremde Rahmen nur nach Opt-in.
   */
  embeds?: "frame" | "link";
  /**
   * BSD-279: Darf der Leser diesen Block (Seite, Zeile, Block einer Datenbank) sehen? Geteilte und veröffentlichte
   * Seiten geben damit nichts von außerhalb ihres Bereichs preis: Erwähnungen werden zu „No access“, Links auf
   * fremde Seiten und verknüpfte Ansichten fremder Datenbanken entfallen, Relationen zeigen nur lesbare Seiten,
   * Rollups und Formeln, die über eine nicht lesbare Datenbank rechnen, bleiben leer. Ohne Angabe: alles (Datei-Export
   * des Besitzers).
   */
  canRead?: (blockID: string) => boolean;
}

export const escapeText = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export const escapeAttribute = (s: string) => escapeText(s).replaceAll("\"", "&quot;").replaceAll("'", "&#39;");

// BSD-376: Phosphor-Referenzen („phosphor:…“) sind kein Text – im Export wie „kein Icon“.
const emojiOf = (icon: BlockProps["icon"]): string | undefined =>
  typeof icon === "string" ? iconAsText(icon) : icon && typeof icon === "object" && typeof icon.emoji === "string" ? icon.emoji : undefined;

const LIST_TYPES = new Set(["bulletedList", "numberedList", "todo"]);

function timecode(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
}

export class HTMLExporter {
  readonly pageLink: (id: string) => { title: string; url: string } | undefined;
  readonly assetLink: (a: AssetRef) => string;
  readonly headingOffset: number;
  readonly htmlBlockURL: ((id: string) => string) | undefined;
  readonly embeds: "frame" | "link" | undefined;
  readonly canRead: ((blockID: string) => boolean) | undefined;
  private engine: QueryEngine | undefined;

  constructor(readonly store: WorkspaceStore, opts: HTMLExporterOptions = {}) {
    this.pageLink = opts.pageLink ?? (() => undefined);
    this.assetLink = opts.assetLink ?? ((a) => "assets/" + a.name);
    this.headingOffset = opts.headingOffset ?? 1;
    this.embeds = opts.embeds;
    this.htmlBlockURL = opts.htmlBlockURL;
    this.canRead = opts.canRead;
  }

  private readable(blockID: string): boolean {
    return this.canRead === undefined || this.canRead(blockID);
  }

  /** Rechnet die Property über eine Datenbank, die der Leser nicht sehen darf (Rollup, Formel über Relationen)? */
  private derivedFromHidden(db: Database, p: PropertySchema): boolean {
    if (this.canRead === undefined || (p.type !== "rollup" && p.type !== "formula")) return false;
    const hidden = (rel: PropertySchema | undefined) => {
      const target = rel?.relation?.databaseID !== undefined ? this.store.databases.get(rel.relation.databaseID) : undefined;
      return target !== undefined && !this.readable(target.blockID);
    };
    if (p.type === "rollup") {
      const rel = db.properties.find((q) => q.id === p.rollup?.relationPropertyID);
      // ohne auflösbare Relation gibt es nichts zu rechnen; sonst zählt die Zieldatenbank
      return hidden(rel);
    }
    // Formel: kann jede Relation (und jedes Rollup) der Datenbank lesen
    return db.properties.some((q) => q.type === "relation" && hidden(q));
  }

  /** Zellwert als Text; Seiten, die der Leser nicht sehen darf, fallen heraus. */
  private cell(db: Database, p: PropertySchema, v: Value): string {
    if (this.derivedFromHidden(db, p)) return "";
    return cellText(this.store, this.visibleValue(v));
  }

  private visibleValue(v: Value): Value {
    if (this.canRead === undefined) return v;
    if (v.t === "page") return this.readable(v.v) ? v : { t: "empty" };
    if (v.t === "list") return { t: "list", v: v.v.map((x) => this.visibleValue(x)).filter((x) => x.t !== "empty") };
    return v;
  }

  private get query(): QueryEngine {
    return (this.engine ??= new QueryEngine(this.store, this.canRead ? { canRead: this.canRead } : {}));
  }

  /** Sichtbare Kinder (Swift `contentBlocks(of:)`). */
  contentBlocks(id: string): Block[] {
    return this.store.children("b:" + id).map((k) => this.store.blocks.get(k)).filter((b): b is Block => b !== undefined && b.trashedAt === undefined);
  }

  blocks(list: Block[]): string {
    let out = "";
    let i = 0;
    while (i < list.length) {
      const b = list[i]!;
      if (LIST_TYPES.has(b.type)) {
        const tag = b.type === "numberedList" ? "ol" : "ul";
        out += `<${tag}${b.type === "todo" ? " class=\"todo\"" : ""}>\n`;
        while (i < list.length && list[i]!.type === b.type) { out += this.listItem(list[i]!); i++; }
        out += `</${tag}>\n`;
        continue;
      }
      out += this.block(b);
      i++;
    }
    return out;
  }

  private children(b: Block): string {
    const kids = this.contentBlocks(b.id);
    return kids.length === 0 ? "" : this.blocks(kids);
  }

  private listItem(b: Block): string {
    const text = this.inline(b.text);
    if (b.type === "todo") {
      const checked = b.props?.checked === true;
      return `<li class="${checked ? "checked" : ""}"><input type="checkbox" disabled${checked ? " checked" : ""}> <span>${text}</span>${this.children(b)}</li>\n`;
    }
    return `<li>${text}${this.children(b)}</li>\n`;
  }

  private colorClass(b: Block): string {
    const c = b.props?.color;
    return c === undefined || c === "default" ? "" : ` class="color-${c}"`;
  }

  block(b: Block): string {
    const p: BlockProps = b.props ?? {};
    const text = this.inline(b.text);
    const open = p.isOpen === true ? " open" : "";
    switch (b.type) {
      case "text":
        return text === "" ? "<p class=\"empty\"></p>\n" + this.children(b) : `<p${this.colorClass(b)}>${text}</p>\n` + this.indented(b);
      case "heading1": case "heading2": case "heading3": case "heading4": {
        const level = Number(b.type.slice(-1)) + this.headingOffset;
        if (p.toggleable === true) return `<details${open}><summary><h${level}>${text}</h${level}></summary>${this.children(b)}</details>\n`;
        return `<h${level}${this.colorClass(b)}>${text}</h${level}>\n`;
      }
      case "bulletedList": case "numberedList": case "todo":
        return this.blocks([b]);
      case "toggle":
        return `<details${open}><summary>${text}</summary>${this.children(b)}</details>\n`;
      case "quote":
        return `<blockquote${this.colorClass(b)}>${text}${this.children(b)}</blockquote>\n`;
      case "callout": {
        const e = emojiOf(p.icon);
        const icon = e !== undefined ? `<span class="callout-icon">${escapeText(e)}</span>` : "";
        return `<aside class="callout">${icon}<div>${text === "" ? "" : `<p>${text}</p>`}${this.children(b)}</div></aside>\n`;
      }
      case "divider":
        return "<hr>\n";
      case "code": {
        const lang = (p.language ?? "").toLowerCase();
        const source = plain(runsOf(b.text));
        if (lang === "html") {
          const url = this.htmlBlockURL?.(b.id);
          if (url !== undefined) return `<figure class="html-block"><iframe sandbox="allow-scripts" loading="lazy" src="${escapeAttribute(url)}"></iframe></figure>\n`;
          return `<figure class="html-block"><iframe sandbox="allow-scripts" loading="lazy" srcdoc="${escapeAttribute(source)}"></iframe></figure>\n`;
        }
        if (lang === "mermaid") return `<pre class="mermaid">${escapeText(source)}</pre>\n`;
        const cls = lang === "" || lang === "plain text" ? "" : ` class="language-${escapeAttribute(lang)}"`;
        return `<pre><code${cls}>${escapeText(source)}</code></pre>\n` + this.caption(p, false);
      }
      case "equation":
        return `<div class="equation">\\[${escapeText(p.expression ?? plain(runsOf(b.text)))}\\]</div>\n`;
      case "image": {
        const src = p.url ?? (p.asset ? this.assetLink(p.asset) : "");
        const alt = p.caption !== undefined ? plain(runsOf(p.caption)) : "";
        return `<figure${figureAlign(p)}><img src="${escapeAttribute(sanitizeURL(src, true))}" alt="${escapeAttribute(alt)}">${this.caption(p, true)}</figure>\n`;
      }
      case "video": case "audio": {
        const src = p.url ?? (p.asset ? this.assetLink(p.asset) : "");
        return `<figure${b.type === "video" ? figureAlign(p) : ""}><${b.type} controls src="${escapeAttribute(sanitizeURL(src))}"></${b.type}>${this.caption(p, true)}</figure>\n`;
      }
      case "embed": {
        const url = sanitizeURL(p.url ?? "");
        if (this.embeds === "link") {
          return `<a class="bookmark embed-link" href="${escapeAttribute(url)}" rel="noopener noreferrer"><span class="bookmark-title">${escapeText(p.caption !== undefined ? plain(runsOf(p.caption)) || url : url)}</span><span class="bookmark-url">${escapeText(url)}</span></a>\n`;
        }
        const sandbox = this.embeds === "frame" ? ` sandbox="allow-scripts allow-same-origin allow-popups allow-presentation" referrerpolicy="no-referrer"` : "";
        return `<figure><iframe class="embed" src="${escapeAttribute(url)}" loading="lazy"${sandbox}></iframe>${this.caption(p, true)}</figure>\n`;
      }
      case "file": case "pdf": case "bookmark": {
        const url = p.url ?? (p.asset ? this.assetLink(p.asset) : "");
        const label = p.bookmark?.title ?? (p.caption !== undefined ? plain(runsOf(p.caption)) : undefined) ?? p.asset?.name ?? url;
        const summary = p.bookmark?.summary;
        const detail = summary !== undefined ? `<span class="bookmark-desc">${escapeText(summary)}</span>` : "";
        return `<a class="bookmark" href="${escapeAttribute(sanitizeURL(url))}"><span class="bookmark-title">${escapeText(label === "" ? url : label)}</span>${detail}<span class="bookmark-url">${escapeText(url)}</span></a>\n`;
      }
      case "page": case "databasePage": case "linkToPage": {
        const target = b.type === "linkToPage" ? (p.linkTarget ?? b.id) : b.id;
        const e = emojiOf(this.store.blocks.get(target)?.props?.icon);
        const icon = e !== undefined ? escapeText(e) + " " : "📄 ";
        if (!this.readable(target)) return "";
        const l = this.pageLink(target);
        if (l) return `<p class="page-link"><a href="${escapeAttribute(l.url)}">${icon}${escapeText(l.title)}</a></p>\n`;
        return `<p class="page-link">${icon}${escapeText(titleOf(this.store, target))}</p>\n`;
      }
      case "databaseInline":
        return this.database(b);
      case "table":
        return this.table(b);
      case "columnList": {
        const cols = this.contentBlocks(b.id).filter((c) => c.type === "column");
        return "<div class=\"columns\">" + cols.map((c) => `<div class="column">${this.children(c)}</div>`).join("") + "</div>\n";
      }
      case "column": case "syncedBlock": case "meetingSection":
        return this.children(b);
      case "meeting":
        return this.meeting(b);
      default:
        // tableOfContents, breadcrumb, button, tableRow, transcript, unbekannt
        return "";
    }
  }

  private indented(b: Block): string {
    const c = this.children(b);
    return c === "" ? "" : `<div class="indent">${c}</div>\n`;
  }

  private caption(p: BlockProps, figure: boolean): string {
    const runs = runsOf(p.caption);
    if (runs.length === 0) return "";
    return figure ? `<figcaption>${this.inline(p.caption)}</figcaption>` : `<p class="caption">${this.inline(p.caption)}</p>\n`;
  }

  table(b: Block): string {
    const rows = this.contentBlocks(b.id).filter((r) => r.type === "tableRow");
    const cols = Math.max(1, b.props?.tableColumns ?? (rows.length ? Math.max(...rows.map((r) => r.props?.cells?.length ?? 0)) : 1));
    let out = "<table class=\"simple\">\n";
    rows.forEach((r, ri) => {
      const cells = r.props?.cells ?? [];
      const tag = ri === 0 && b.props?.tableHeaderRow === true ? "th" : "td";
      out += "<tr>";
      for (let i = 0; i < cols; i++) out += `<${tag}>${i < cells.length ? this.inline(cells[i]) : ""}</${tag}>`;
      out += "</tr>\n";
    });
    return out + "</table>\n";
  }

  database(b: Block): string {
    const dbID = b.props?.databaseID;
    const db = dbID !== undefined ? this.store.databases.get(dbID) : undefined;
    // verknüpfte Ansicht einer Datenbank, die der Leser nicht sehen darf: nichts
    if (!db || !this.readable(db.blockID)) return "";
    const props = [...db.properties];
    const ti = props.findIndex((p) => p.type === "title");
    if (ti >= 0) props.unshift(...props.splice(ti, 1));
    const rows = rowsOf(this.store, db.id).filter((r) => r.props?.isTemplate !== true);
    const dbTitle = plain(runsOf(db.title));
    let out = `<h4 class="db-title">${escapeText(dbTitle === "" ? "Untitled" : dbTitle)}</h4>\n<table class="database">\n<tr>`;
    out += props.map((p) => `<th>${escapeText(p.name)}</th>`).join("") + "</tr>\n";
    for (const r of rows) {
      out += "<tr>" + props.map((p) => {
        if (p.type === "title") {
          const t = titleOf(this.store, r.id);
          const l = this.pageLink(r.id);
          return l ? `<td><a href="${escapeAttribute(l.url)}">${escapeText(t)}</a></td>` : `<td>${escapeText(t)}</td>`;
        }
        if (this.derivedFromHidden(db, p)) return "<td></td>";
        const v = this.query.value(r, p, db);
        if (v.t === "bool") return `<td>${v.v ? "☑︎" : "☐"}</td>`;
        return `<td>${escapeText(this.cell(db, p, v))}</td>`;
      }).join("") + "</tr>\n";
    }
    return out + "</table>\n";
  }

  /** Eigenschaften einer Datenbankzeile als Tabelle (Seitenexport). */
  properties(page: Block): string {
    const parent = page.parent;
    const db = parent.startsWith("d:") ? this.store.databases.get(parent.slice(2)) : undefined;
    if (!db) return "";
    let rows = "";
    for (const p of db.properties) {
      if (p.type === "title") continue;
      if (this.derivedFromHidden(db, p)) continue;
      const v = this.visibleValue(this.query.value(page, p, db));
      if (isEmptyValue(v)) continue;
      rows += `<tr><th>${escapeText(p.name)}</th><td>${escapeText(this.cell(db, p, v))}</td></tr>\n`;
    }
    return rows === "" ? "" : `<table class="properties">\n${rows}</table>\n`;
  }

  private meeting(b: Block): string {
    let html = `<section class="meeting"><h2>${escapeText(plain(runsOf(b.text)))}</h2>\n`;
    const content = this.contentBlocks(b.id);
    for (const kind of ["summary", "notes"] as const) {
      const sec = content.find((c) => c.props?.meetingSection === kind);
      if (!sec || this.contentBlocks(sec.id).length === 0) continue;
      html += `<h3>${kind === "summary" ? "Summary" : "Notes"}</h3>\n` + this.children(sec);
    }
    const segs = content.filter((c) => c.type === "transcript").flatMap((c) => c.props?.segments ?? []).filter((s) => s.p !== true)
      .sort((x, y) => (x.s !== y.s ? x.s - y.s : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    if (segs.length > 0) {
      html += "<details class=\"transcript\"><summary>Transcript</summary>\n";
      const paragraphs: { speaker: string | undefined; segs: typeof segs }[] = [];
      for (const s of segs) {
        const last = paragraphs[paragraphs.length - 1];
        if (last && last.speaker === s.sp && s.s - last.segs[last.segs.length - 1]!.e <= 8) last.segs.push(s);
        else paragraphs.push({ speaker: s.sp, segs: [s] });
      }
      const info = b.props?.meeting;
      const speakerName = (id: string | undefined) => {
        if (!info) return "Unknown";
        if (id === undefined) return "Unknown";
        const sp = info.speakers?.find((x) => x.id === id);
        if (sp) return sp.name;
        return id === "me" ? "Me" : id === "others" ? "Others" : id;
      };
      for (const para of paragraphs) {
        html += `<p><strong>${escapeText(speakerName(para.speaker))}</strong> <span class="time">${timecode(para.segs[0]!.s)}</span><br>${escapeText(para.segs.map((s) => s.t).join(" "))}</p>\n`;
      }
      html += "</details>\n";
    }
    return html + "</section>\n";
  }

  // MARK: Inline

  inline(t: RichText | undefined): string {
    let out = "";
    for (const run of runsOf(t)) {
      let s: string;
      const mention = run.mention as Record<string, { _0?: unknown }> | undefined;
      if (run.eq !== undefined) {
        s = `<span class="equation inline">\\(${escapeText(run.eq)}\\)</span>`;
      } else if (mention && typeof mention === "object") {
        const kind = Object.keys(mention)[0];
        const value = kind !== undefined ? mention[kind]?._0 : undefined;
        if (kind === "page" && typeof value === "string" && !this.readable(value)) {
          s = `<span class="mention">No access</span>`;
        } else if (kind === "page" && typeof value === "string") {
          const title = titleOf(this.store, value);
          const l = this.pageLink(value);
          s = l ? `<a class="mention" href="${escapeAttribute(l.url)}">${escapeText(title)}</a>` : `<span class="mention">${escapeText(title)}</span>`;
        } else if (kind === "link" && typeof value === "string") {
          s = `<a class="mention" href="${escapeAttribute(sanitizeURL(value))}">${escapeText(run.t)}</a>`;
        } else {
          s = `<span class="mention">${escapeText(run.t)}</span>`;
        }
      } else {
        s = escapeText(run.t).replaceAll("\n", "<br>");
      }
      const m = run.m;
      if (m.c) s = `<code>${s}</code>`;
      if (m.b) s = `<strong>${s}</strong>`;
      if (m.i) s = `<em>${s}</em>`;
      if (m.u) s = `<u>${s}</u>`;
      if (m.s) s = `<s>${s}</s>`;
      if (m.color !== undefined && m.color !== "default") s = `<span class="color-${m.color}">${s}</span>`;
      if (m.link !== undefined) s = `<a href="${escapeAttribute(sanitizeURL(m.link))}">${s}</a>`;
      out += s;
    }
    return out;
  }
}

/** BSD-290: Ausrichtung eines Bildes/Videos (Notion: links, Mitte, rechts) im HTML-Export. */
function figureAlign(p: BlockProps): string {
  return p.align === "center" || p.align === "right" ? ` style="text-align: ${p.align}"` : "";
}
