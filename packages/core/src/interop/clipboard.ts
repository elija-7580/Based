// Eingefügtes HTML (Notion-Zwischenablage, Webseiten, Google Docs, Mail …) → Based-Blöcke.
// Port von Swift BasedCore Interop/ClipboardHTML.swift (ClipboardHTMLImporter).
import type { BlockProps, RichText } from "../model/records.js";
import { ENUMS } from "../model/schema.js";
import { parseSwiftDouble } from "../query/value.js";
import { graphemes, HTMLNode, isBlank, parseHTML, collapse, pageIDFromLink, trimNewlines } from "./html.js";
import { normalize, plain, PLAIN, runsLength, slice, toRichText, type Marks, type Run } from "./runs.js";

/** Swift `ImportedBlock` ohne id. */
export interface ImportedBlock {
  type: string;
  text: Run[];
  props: BlockProps;
  children: ImportedBlock[];
  linkTarget?: string;
}

const imported = (type: string, text: Run[] = [], props: BlockProps = {}, children: ImportedBlock[] = []): ImportedBlock => ({ type, text, props, children });

/** Wire-nahe Form wie im Fixture: `{type, text, children, props?, linkTarget?}`. */
export function importedJSON(b: ImportedBlock): Record<string, unknown> {
  const o: Record<string, unknown> = { type: b.type, text: toRichText(b.text), children: b.children.map(importedJSON) };
  if (Object.keys(b.props).length > 0) o.props = b.props;
  if (b.linkTarget !== undefined) o.linkTarget = b.linkTarget;
  return o;
}

const TCOLORS = new Set<string>(ENUMS.TColor);
const known = (c: string) => (TCOLORS.has(c) ? c : undefined);
const isBackground = (c: string) => TCOLORS.has(c) && c.endsWith("Background");
const background = (c: string) => (isBackground(c) || c === "default" ? c : known(c + "Background") ?? c);

/** Notion-Farbname (`red`, `gray_background`, `grey`) → TColor (Swift `NotionHTMLImporter.tcolor`). */
export function notionColor(notion: string): string | undefined {
  let s = notion.toLowerCase();
  let bg = false;
  if (s.endsWith("_background")) { bg = true; s = s.slice(0, -"_background".length); }
  if (s.startsWith("translucent") || s === "default" || s === "") return undefined;
  const hue = known(s === "grey" ? "gray" : s);
  if (hue === undefined || hue === "default") return undefined;
  return bg ? background(hue) : hue;
}

const BLOCK_TAGS = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "details", "blockquote",
  "pre", "table", "hr", "figure", "aside", "img", "section", "article", "header", "footer", "main"]);

export class ClipboardHTMLImporter {
  /** Vorhandene Seite für ein Linkziel (based://page/…, notion.so/…-<32 hex>). */
  constructor(readonly resolvePage: (href: string) => string | undefined = () => undefined) {}

  /** Seiten-ID aus Based- oder Notion-Link, wenn es sie gibt (Swift `pageResolver`). */
  static pageResolver(exists: (id: string) => boolean): (href: string) => string | undefined {
    return (href) => {
      const id = pageIDFromLink(href);
      if (id !== undefined && exists(id)) return id;
      if (!href.includes("notion.so") && !href.includes("notion.site")) return undefined;
      const path = href.split("?").find((p) => p.length > 0) ?? href;
      let start = -1;
      for (let i = path.length - 32; i >= 0; i--) if (/^[0-9a-fA-F]{32}$/.test(path.slice(i, i + 32))) { start = i; break; }
      if (start < 0) return undefined;
      const h = path.slice(start, start + 32).toLowerCase();
      const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
      return exists(uuid) ? uuid : undefined;
    };
  }

  /** Ob das HTML mehr Struktur trägt als sein reiner Text. */
  static isStructured(html: string): boolean {
    const l = html.toLowerCase();
    const tags = ["<h1", "<h2", "<h3", "<ul", "<ol", "<details", "<table", "<aside", "<blockquote", "<pre", "<hr", "<img", "<figure"];
    if (tags.some((t) => l.includes(t))) return true;
    return l.split("<p").length > 2 || l.includes("highlight-") || l.includes("block-color-");
  }

  parse(html: string): ImportedBlock[] {
    const root = parseHTML(html);
    const body = root.first((n) => n.tag === "body") ?? root;
    return this.blocks(body.children);
  }

  // MARK: Blöcke

  blocks(nodes: HTMLNode[]): ImportedBlock[] {
    const out: ImportedBlock[] = [];
    let inline: HTMLNode[] = [];
    const flush = () => {
      const rt = this.richText(inline);
      inline = [];
      if (!isBlank(plain(rt))) out.push(imported("text", trimmed(rt)));
    };
    for (const n of nodes) {
      if (n.isText || !BLOCK_TAGS.has(n.tag)) {
        if (["style", "script", "meta", "head", "title"].includes(n.tag)) continue;
        if (n.tag === "br") { flush(); continue; }
        inline.push(n); continue;
      }
      flush();
      out.push(...this.block(n));
    }
    flush();
    return out;
  }

  private block(n: HTMLNode): ImportedBlock[] {
    const color = blockColor(n);
    const colored = (b: ImportedBlock) => (color !== undefined ? { ...b, props: { ...b.props, color } } : b);
    switch (n.tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        const type = n.tag === "h1" ? "heading1" : n.tag === "h2" ? "heading2" : "heading3";
        return [colored(imported(type, trimmed(this.richText(n.children))))];
      }
      case "hr": return [imported("divider")];
      case "ul": case "ol": {
        const todoList = n.has("to-do-list");
        return n.elements.filter((e) => e.tag === "li").map((li) => this.listItem(li, n.tag === "ol", todoList));
      }
      case "li": return [this.listItem(n, false, false)];
      case "details": {
        const summary = n.elements.find((e) => e.tag === "summary");
        const rest = n.children.filter((c) => c.tag !== "summary");
        return [colored(imported("toggle", trimmed(this.richText(summary?.children ?? [])), {}, this.blocks(rest)))];
      }
      case "blockquote": {
        const kids = this.blocks(n.children);
        if (kids.length <= 1) return [colored(imported("quote", kids[0]?.text ?? trimmed(this.richText(n.children))))];
        return [colored(imported("quote", kids[0]!.text, {}, kids.slice(1)))];
      }
      case "aside": return [this.callout(n)];
      case "pre": {
        const codeNode = n.first((x) => x.tag === "code") ?? n;
        const props: BlockProps = {};
        const lang = [...codeNode.classList, ...n.classList].find((c) => c.startsWith("language-"));
        if (lang !== undefined) props.language = lang.slice(9);
        const src = trimNewlines(codeNode.rawText);
        return [imported("code", src ? [{ t: src, m: PLAIN }] : [], props)];
      }
      case "table": return [this.table(n)];
      case "img": return this.image(n, undefined);
      case "figure": {
        if (n.has("callout")) return [this.callout(n)];
        const fc = n.first((x) => x.tag === "figcaption");
        const cap = fc ? trimmed(this.richText(fc.children)) : undefined;
        const img = n.first((x) => x.tag === "img");
        if (img) return this.image(img, cap);
        const a = n.first((x) => x.tag === "a");
        const href = a?.attr("href");
        if (href !== undefined) {
          const props: BlockProps = { url: href };
          if (cap !== undefined) props.caption = toRichText(cap);
          return [imported("bookmark", [], props)];
        }
        return this.blocks(n.children);
      }
      default: {
        if (n.has("callout")) return [this.callout(n)];
        if (n.elements.some((e) => BLOCK_TAGS.has(e.tag))) return this.blocks(n.children).map(colored);
        const rt = trimmed(this.richText(n.children));
        if (isBlank(plain(rt))) return [];
        return [colored(imported("text", rt))];
      }
    }
  }

  private listItem(li: HTMLNode, numbered: boolean, todo: boolean): ImportedBlock {
    const checkbox = li.first((x) => x.tag === "input" && (x.attr("type") ?? "") === "checkbox") ?? li.first((x) => x.has("checkbox"));
    const isTodo = todo || checkbox !== undefined || li.has("to-do");
    const checked = (checkbox ? checkbox.attrs.has("checked") || checkbox.has("checkbox-on") : false)
      || li.has("checked") || li.first((x) => x.has("to-do-children-checked")) !== undefined;
    const containers = ["ul", "ol", "details", "blockquote", "pre", "table", "div"];
    const nested = li.elements.filter((e) => (containers.includes(e.tag) && e.elements.some((x) => BLOCK_TAGS.has(x.tag))) || e.tag === "ul" || e.tag === "ol");
    const nestedHTML = nested.map((x) => x.outerHTML);
    const inline = li.children.filter((c) => !nestedHTML.includes(c.outerHTML) && c.tag !== "input" && !c.has("checkbox"));
    const b = imported(isTodo ? "todo" : numbered ? "numberedList" : "bulletedList", trimmed(this.richText(inline)));
    if (isTodo) b.props.checked = checked;
    b.children = nested.flatMap((x) => this.block(x));
    const c = blockColor(li);
    if (c !== undefined) b.props.color = c;
    return b;
  }

  private callout(n: HTMLNode): ImportedBlock {
    const props: BlockProps = {};
    let nodes = n.children;
    const icon = n.first((x) => x.has("icon"));
    if (icon) {
      const t = icon.textContent;
      if (t) props.icon = t;
      nodes = nodes.filter((x) => !x.has("icon"));
    }
    const kids = this.blocks(nodes);
    let text: Run[] = kids[0]?.type === "text" ? kids.shift()!.text : [];
    const first = graphemes(plain(text))[0];
    if (props.icon === undefined && first !== undefined && /^\p{Emoji_Presentation}/u.test(first)) {
      props.icon = first;
      text = trimmed(slice(text, first.length, runsLength(text)));
    }
    props.color = blockColor(n) ?? "grayBackground";
    return imported("callout", text, props, kids);
  }

  private table(n: HTMLNode): ImportedBlock {
    const rows = n.all((x) => x.tag === "tr");
    const cellsOf = (tr: HTMLNode) => tr.elements.filter((e) => e.tag === "td" || e.tag === "th");
    const cols = rows.length ? Math.max(...rows.map((r) => cellsOf(r).length)) : 1;
    const t = imported("table");
    t.props.tableColumns = Math.max(1, cols);
    t.props.tableHeaderRow = rows[0] ? rows[0].elements.every((e) => e.tag === "th") : false;
    t.children = rows.map((tr) => {
      const cells: RichText[] = cellsOf(tr).map((c) => toRichText(trimmed(this.richText(c.children))));
      while (cells.length < cols) cells.push("");
      return imported("tableRow", [], { cells });
    });
    return t;
  }

  private image(img: HTMLNode, caption: Run[] | undefined): ImportedBlock[] {
    const src = img.attr("src");
    if (src === undefined || !src.startsWith("http")) return [];
    const props: BlockProps = { url: src };
    if (caption !== undefined) props.caption = toRichText(caption);
    return [imported("image", [], props)];
  }

  // MARK: Inline

  richText(nodes: HTMLNode[]): Run[] {
    const runs: Run[] = [];
    const add = (s: string, m: Marks) => { if (s) runs.push({ t: s.replaceAll(" ", " "), m }); };
    const walk = (n: HTMLNode, inherited: Marks) => {
      if (n.isText) { add(collapse(n.text), inherited); return; }
      let m: Marks = inherited;
      const set = (patch: Marks) => { m = { ...m, ...patch }; };
      switch (n.tag) {
        case "br": add("\n", m); return;
        case "style": case "script": case "svg": case "input": return;
        case "strong": case "b": set({ b: true }); break;
        case "em": case "i": set({ i: true }); break;
        case "u": case "ins": set({ u: true }); break;
        case "s": case "del": case "strike": set({ s: true }); break;
        case "code": case "kbd": set({ c: true }); break;
        case "mark": set({ color: colorClass(n) ?? "yellowBackground" }); break;
        case "img": {
          const alt = n.attr("alt");
          if (alt && graphemes(alt).length <= 4) add(alt, m);
          return;
        }
        case "span": case "font": {
          const c = colorClass(n) ?? cssColor(n);
          if (c !== undefined) set({ color: c });
          const fw = n.style("font-weight");
          if (fw !== undefined && (fw === "bold" || (swiftInt(fw) ?? 400) >= 600)) set({ b: true });
          if (n.style("font-style") === "italic") set({ i: true });
          if (n.style("text-decoration")?.includes("line-through")) set({ s: true });
          if (n.style("text-decoration")?.includes("underline")) set({ u: true });
          break;
        }
        case "a": {
          const href = n.attr("href");
          if (href === undefined || href === "" || href.startsWith("#")) break;
          const id = this.resolvePage(href);
          if (id !== undefined) {
            const label = n.textContent;
            runs.push({ t: label ? label : "Untitled", m, mention: { page: { _0: id } } });
            return;
          }
          set({ link: href });
          break;
        }
        default: break;
      }
      for (const c of n.children) walk(c, m);
    };
    for (const n of nodes) walk(n, PLAIN);
    return normalize(runs);
  }
}

/** Swift `Int(String)`: optionales Vorzeichen, nur Ziffern. */
function swiftInt(s: string): number | undefined {
  return /^[+-]?[0-9]+$/.test(s) ? Number(s) : undefined;
}

/** Führende/folgende Leerzeichen und Zeilenumbrüche weg (Swift `trimmed`). */
function trimmed(rt: Run[]): Run[] {
  const s = plain(rt);
  let lead = 0;
  while (lead < s.length && (s[lead] === " " || s[lead] === "\n")) lead++;
  let trail = 0;
  while (trail < s.length - lead) {
    const ch = s[s.length - 1 - trail];
    if (ch === " " || (ch === "\n" && s[s.length - 2 - trail] !== "\r")) trail++;
    else break;
  }
  if (lead + trail >= s.length) return [];
  return slice(rt, lead, runsLength(rt) - trail);
}

// MARK: Farben

function colorClass(n: HTMLNode): string | undefined {
  for (const c of n.classList) {
    for (const prefix of ["highlight-", "block-color-"]) {
      if (!c.startsWith(prefix)) continue;
      const t = notionColor(c.slice(prefix.length));
      if (t !== undefined) return t;
    }
  }
  return undefined;
}

function blockColor(n: HTMLNode): string | undefined {
  const c = n.classList.find((x) => x.startsWith("block-color-"));
  return c === undefined ? undefined : notionColor(c.slice(12));
}

function cssColor(n: HTMLNode): string | undefined {
  const bg = n.style("background-color");
  const b = bg !== undefined ? nearest(bg) : undefined;
  if (b !== undefined) return known(b + "Background") ?? b;
  const fg = n.style("color");
  return fg !== undefined ? nearest(fg) : undefined;
}

function nearest(css: string): string | undefined {
  const s = css.toLowerCase().replaceAll(" ", "");
  const names: [string, string][] = [["red", "red"], ["orange", "orange"], ["yellow", "yellow"], ["green", "green"], ["blue", "blue"],
    ["purple", "purple"], ["pink", "pink"], ["brown", "brown"], ["gray", "gray"], ["grey", "gray"]];
  const hit = names.find(([k]) => s.includes(k));
  if (hit) return hit[1];
  if (!s.startsWith("#") && !s.startsWith("rgb")) return undefined;
  let r: number, g: number, b: number;
  const hex = s.slice(1, 7);
  const open = s.indexOf("("), close = s.indexOf(")");
  if (s.startsWith("#") && graphemes(s).length >= 7 && /^[0-9a-f]{6}$/.test(hex)) {
    const v = parseInt(hex, 16);
    r = (v >> 16) & 0xff; g = (v >> 8) & 0xff; b = v & 0xff;
  } else if (open >= 0 && close >= 0 && open < close) {
    const parts = s.slice(open + 1, close).split(",").filter((p) => p.length > 0).map(parseSwiftDouble).filter((x): x is number => x !== undefined);
    if (parts.length < 3) return undefined;
    [r, g, b] = [parts[0]!, parts[1]!, parts[2]!];
  } else return undefined;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx - mn < 24) return undefined;
  if (r >= g && r >= b) return g > b + 40 ? (g > 150 ? "yellow" : "orange") : (b > 120 ? "pink" : "red");
  if (g >= r && g >= b) return "green";
  return r > g + 30 ? "purple" : "blue";
}

