// Markdown ⇄ Based: Block-Parser (Swift Interop/MarkdownImport.swift), Inline-Markdown ⇄ RichText
// (InlineMarkdownCodec.swift) und CSV (CSV.swift). Rein, ohne DOM.
import type { BlockProps, RichText } from "../model/records.js";
import type { DateValue } from "../query/value.js";
import { formatICU } from "../query/value.js";
import type { ImportedBlock } from "./clipboard.js";
import { graphemes, trimSpaces } from "./html.js";
import { removingPercentEncoding } from "./importids.js";
import { normalize, PLAIN, runsOf, toRichText, type Marks, type Run } from "./runs.js";
import type { AssetRef } from "./builder.js";

/** Ein Block aus dem Parser (Swift `ImportedBlock`; die ID vergibt der Aufrufer). */
export type MarkdownBlock = ImportedBlock & { children: MarkdownBlock[] };

const block = (type: string, text: Run[] = [], props: BlockProps = {}, children: MarkdownBlock[] = []): MarkdownBlock => ({ type, text, props, children });

const isBlank = (s: string) => trimSpaces(s) === "";
const indentOf = (s: string) => { let n = 0; while (s[n] === " ") n++; return n; };

/** Swift `BlockType.supportsChildren`. */
const SUPPORTS_CHILDREN = new Set(["text", "bulletedList", "numberedList", "todo", "toggle", "quote", "callout", "page", "column", "columnList",
  "table", "syncedBlock", "meeting", "meetingSection", "heading1", "heading2", "heading3", "heading4"]);

const charCount = (s: string) => graphemes(s).length;
const dropChars = (s: string, n: number) => graphemes(s).slice(n).join("");

export interface MarkdownImporterOptions {
  /** Linkziel → Seiten-ID (dann wird der Link eine Erwähnung). */
  resolveLink?: (target: string) => string | undefined;
  /** Bild-Quelle → URL oder Datei. */
  resolveAsset?: (src: string) => { url?: string | undefined; asset?: AssetRef | undefined };
  /** Großzügiger lesen als der Swift-Import (Einfügen im Editor): mehr To-do-Schreibweisen. */
  lenient?: boolean;
}

export class MarkdownImporter {
  readonly resolveLink: (target: string) => string | undefined;
  readonly resolveAsset: (src: string) => { url?: string | undefined; asset?: AssetRef | undefined };
  readonly lenient: boolean;

  constructor(opts: MarkdownImporterOptions = {}) {
    this.resolveLink = opts.resolveLink ?? (() => undefined);
    this.resolveAsset = opts.resolveAsset ?? ((src) => ({ url: src }));
    this.lenient = opts.lenient ?? false;
  }

  /** Trennt eine führende „# Titel“-Zeile ab. */
  static splitTitle(md: string): { title: string | undefined; body: string } {
    const lines = md.split("\n");
    while (lines.length > 0 && isBlank(lines[0]!)) lines.shift();
    const f = lines[0];
    if (f !== undefined && f.startsWith("# ")) {
      lines.shift();
      return { title: trimSpaces(f.slice(2)), body: lines.join("\n") };
    }
    return { title: undefined, body: lines.join("\n") };
  }

  parse(markdown: string): MarkdownBlock[] {
    return this.parseLines(markdown.replaceAll("\r\n", "\n").replaceAll("\t", "    ").split("\n"));
  }

  inline(s: string): Run[] {
    return decodeInlineMarkdown(s.replaceAll("<br>", "\n"), this.resolveLink);
  }

  /** „[!NOTE] Text“ / „[!warning]“ → Callout-Look (Icon und Hintergrund wie in Notion). */
  static alert(line: string): { emoji: string; color: string; text: string } | undefined {
    const close = line.indexOf("]");
    if (!line.startsWith("[!") || close < 0) return undefined;
    const kind = line.slice(2, close).toLowerCase();
    const text = trimSpaces(line.slice(close + 1));
    switch (kind) {
      case "note": case "info": return { emoji: "ℹ️", color: "blueBackground", text };
      case "tip": case "hint": case "success": return { emoji: "💡", color: "greenBackground", text };
      case "important": case "abstract": case "summary": return { emoji: "📌", color: "purpleBackground", text };
      case "warning": case "caution": case "attention": return { emoji: "⚠️", color: "yellowBackground", text };
      case "danger": case "error": case "bug": case "failure": return { emoji: "🚨", color: "redBackground", text };
      case "question": case "faq": case "help": return { emoji: "❓", color: "grayBackground", text };
      case "example": case "quote": case "cite": return { emoji: "📝", color: "grayBackground", text };
      default: return undefined;
    }
  }

  parseLines(lines: string[]): MarkdownBlock[] {
    const out: MarkdownBlock[] = [];
    let i = 0;
    const n = lines.length;
    const firstContent = lines.find((l) => !isBlank(l));
    const base = firstContent !== undefined ? indentOf(firstContent) : 0;

    /** Zeilen des Blocks ab `start`, die tiefer als `indent` eingerückt sind. */
    const childLines = (start: number, indent: number): [string[], number] => {
      let j = start + 1, lastContent = start;
      while (j < n) {
        const l = lines[j]!;
        if (isBlank(l)) { j++; continue; }
        if (indentOf(l) > indent) { lastContent = j; j++; } else break;
      }
      return [lines.slice(start + 1, lastContent + 1), lastContent + 1];
    };

    while (i < n) {
      const raw = lines[i]!;
      const trimmed = trimSpaces(raw);
      if (trimmed === "") { i++; continue; }
      const indent = indentOf(raw);
      if (indent > base && out.length > 0) {
        // BSD-183: bewusste Abweichung von Swift. Dort entnimmt `out.popLast()` den Vorgänger auch dann, wenn er
        // keine Kinder haben kann (Code, Trenner, Gleichung …), und der Block fällt weg. Hier bleibt er stehen;
        // die eingerückte Zeile wird darunter als eigener Block gelesen.
        const last = out[out.length - 1]!;
        if (SUPPORTS_CHILDREN.has(last.type)) {
          const [kids, next] = childLines(i - 1, indent - 1);
          last.children.push(...this.parseLines(kids));
          i = next;
          continue;
        }
      }

      // Code-Block
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        // Zaun mit ``` oder ~~~ (Einfügen aus anderen Editoren); geschlossen wird mit demselben Zeichen.
        const fence = trimmed.slice(0, 3);
        const lang = trimSpaces(trimmed.replace(/^(`{3,}|~{3,})/, "")).split(/\s+/)[0] ?? "";
        const body: string[] = [];
        let j = i + 1;
        while (j < n && !trimSpaces(lines[j]!).startsWith(fence)) {
          body.push(lines[j]!.slice(Math.min(indent, indentOf(lines[j]!))));
          j++;
        }
        const text = body.join("\n");
        out.push(block("code", text ? [{ t: text, m: PLAIN }] : [], { language: lang === "" ? "plain text" : lang.toLowerCase() }));
        i = Math.min(j + 1, n);
        continue;
      }
      // Gleichung
      const count = charCount(trimmed);
      if (trimmed === "$$" || (trimmed.startsWith("$$") && trimmed.endsWith("$$") && count > 4)) {
        let expr: string;
        let j = i + 1;
        if (count > 4) expr = graphemes(trimmed).slice(2, -2).join("");
        else {
          const body: string[] = [];
          while (j < n && trimSpaces(lines[j]!) !== "$$") { body.push(trimSpaces(lines[j]!)); j++; }
          expr = body.join("\n");
          j++;
        }
        out.push(block("equation", [], { expression: expr }));
        i = count > 4 ? i + 1 : Math.min(j, n);
        continue;
      }
      // <details>-Toggle (Notion-Export)
      if (trimmed.startsWith("<details")) {
        let j = i + 1;
        let summary = "";
        const r = trimmed.indexOf("<summary>"), e = trimmed.indexOf("</summary>");
        if (r >= 0 && e >= 0) summary = trimmed.slice(r + 9, e);
        else if (j < n && lines[j]!.includes("<summary>")) {
          const l = lines[j]!;
          const s = l.indexOf("<summary>") + 9;
          const end = l.indexOf("</summary>");
          summary = l.slice(s, end < 0 ? l.length : end);
          j++;
        }
        let depth = 1;
        const body: string[] = [];
        while (j < n) {
          const t = trimSpaces(lines[j]!);
          if (t.startsWith("<details")) depth++;
          if (t.startsWith("</details>")) { depth--; if (depth === 0) break; }
          body.push(lines[j]!);
          j++;
        }
        out.push(block("toggle", this.inline(summary), {}, this.parseLines(body)));
        i = Math.min(j + 1, n);
        continue;
      }
      // <aside>-Callout (Notion-Export)
      if (trimmed.startsWith("<aside>")) {
        let j = i + 1;
        const body: string[] = [];
        const rest = trimmed.slice(7).replaceAll("</aside>", "");
        if (!isBlank(rest)) body.push(rest);
        if (!trimmed.includes("</aside>")) {
          while (j < n && !lines[j]!.includes("</aside>")) { body.push(lines[j]!); j++; }
          j++;
        }
        const p: BlockProps = {};
        const fi = body.findIndex((l) => !isBlank(l));
        let first = fi >= 0 ? trimSpaces(body[fi]!) : "";
        const c = graphemes(first)[0];
        const scalar = c?.codePointAt(0);
        if (c !== undefined && scalar !== undefined && /\p{Emoji}/u.test(String.fromCodePoint(scalar)) && scalar > 0x2000) {
          p.icon = c;
          first = trimSpaces(dropChars(first, 1));
        } else {
          p.icon = "💡";
        }
        if (fi >= 0) body.splice(fi, 1);
        out.push(block("callout", this.inline(first), p, this.parseLines(body)));
        i = Math.min(j, n);
        continue;
      }
      // Tabelle
      if (trimmed.startsWith("|")) {
        const rows: string[][] = [];
        let j = i;
        while (j < n && trimSpaces(lines[j]!).startsWith("|")) {
          const cells = tableCells(trimSpaces(lines[j]!));
          if (!cells.every((c) => [...c].every((x) => "-: ".includes(x)) && c !== "")) rows.push(cells);
          j++;
        }
        const cols = rows.length ? Math.max(...rows.map((r) => r.length)) : 1;
        const table = block("table", [], { tableColumns: cols, tableHeaderRow: true });
        for (const r of rows) {
          table.children.push(block("tableRow", [], { cells: Array.from({ length: cols }, (_, k) => (k < r.length ? toRichText(this.inline(r[k]!)) : "")) }));
        }
        out.push(table);
        i = j;
        continue;
      }
      // Trennlinie
      if (/^(-{3,}|\*{3,}|_{3,}|(- ){2,}-|(\* ){2,}\*)$/.test(trimmed)) { out.push(block("divider")); i++; continue; }
      // Überschriften
      const h = MarkdownImporter.heading(trimmed);
      if (h) { out.push(block(h[0], this.inline(h[1]))); i++; continue; }
      // Zitat (aufeinanderfolgende Zeilen)
      if (trimmed.startsWith(">")) {
        const parts: string[] = [];
        let j = i;
        while (j < n) {
          const t = trimSpaces(lines[j]!);
          if (!t.startsWith(">")) break;
          parts.push(trimSpaces(t.slice(1)));
          j++;
        }
        // GitHub-/Obsidian-Hinweise: „> [!NOTE] Text“ → Callout mit Icon und Farbe.
        const alert = parts[0] !== undefined ? MarkdownImporter.alert(parts[0]) : undefined;
        if (alert) {
          const body = [alert.text, ...parts.slice(1)].filter((s) => s !== "").join("\n");
          out.push(block("callout", this.inline(body), { icon: alert.emoji, color: alert.color as BlockProps["color"] }));
          i = j;
          continue;
        }
        out.push(block("quote", this.inline(parts.join("\n"))));
        i = j;
        continue;
      }
      // Bild
      const mid = trimmed.indexOf("](");
      if (trimmed.startsWith("![") && mid >= 0 && trimmed.endsWith(")")) {
        const alt = trimmed.slice(2, mid);
        // Optionaler Titel hinter der Quelle: ![alt](bild.png "Titel")
        const src = trimmed.slice(mid + 2, -1).replace(/\s+"[^"]*"$/, "");
        const r = this.resolveAsset(removingPercentEncoding(src) ?? src);
        const p: BlockProps = {};
        if (r.asset === undefined) p.url = r.url ?? src;
        else p.asset = r.asset;
        if (alt !== "") p.caption = alt;
        out.push(block("image", [], p));
        i++;
        continue;
      }
      // Listen
      const item = MarkdownImporter.listItem(trimmed, this.lenient);
      if (item) {
        const p: BlockProps = {};
        if (item[0] === "todo") p.checked = item[1];
        const b = block(item[0], this.inline(item[2]), p);
        const [kids, next] = childLines(i, indent);
        if (kids.length > 0) b.children = this.parseLines(kids);
        out.push(b);
        i = next;
        continue;
      }
      // Absatz (einzelne Links merken für die Platzierung von Unterseiten)
      const b = block("text", this.inline(trimmed));
      const m = trimmed.indexOf("](");
      if (trimmed.startsWith("[") && trimmed.endsWith(")") && m >= 0 && !trimmed.slice(1, m).includes("]")) b.linkTarget = trimmed.slice(m + 2, -1);
      const [kids, next] = childLines(i, indent);
      if (kids.length > 0) b.children = this.parseLines(kids);
      out.push(b);
      i = next;
    }
    return out;
  }

  static heading(t: string): [string, string] | undefined {
    // Based kennt vier Ebenen: H5 und H6 werden zur kleinsten Überschrift.
    for (const [prefix, type] of [["###### ", "heading4"], ["##### ", "heading4"], ["#### ", "heading4"], ["### ", "heading3"], ["## ", "heading2"], ["# ", "heading1"]] as const) {
      if (t.startsWith(prefix)) return [type, t.slice(prefix.length).replace(/\s+#+\s*$/, "")];
    }
    return undefined;
  }

  static listItem(t: string, lenient = false): [string, boolean, string] | undefined {
    // `lenient` (Einfügen im Editor): auch „* [X]“ und „+ [ ]“; der Datei-Import bleibt wie Swift (Golden Fixtures).
    const todo = lenient
      ? ["- [ ] ", "* [ ] ", "+ [ ] ", "- [x] ", "- [X] ", "* [x] ", "* [X] ", "+ [x] ", "+ [X] "]
      : ["- [ ] ", "* [ ] ", "- [x] ", "- [X] ", "* [x] "];
    for (const p of todo) {
      if (t.startsWith(p)) return ["todo", p.includes("x") || p.includes("X"), t.slice(p.length)];
    }
    if (t === "- [ ]") return ["todo", false, ""];
    for (const p of ["- ", "* ", "+ ", "• "]) if (t.startsWith(p)) return ["bulletedList", false, t.slice(p.length)];
    if (t === "-" || t === "*") return ["bulletedList", false, ""];
    const digits = /^\p{N}*/u.exec(t)![0];
    if (digits.length > 0 && [...digits].length <= 9) {
      const rest = t.slice(digits.length);
      if (rest.startsWith(". ") || rest.startsWith(") ")) return ["numberedList", false, rest.slice(2)];
    }
    return undefined;
  }
}

/** Zellen einer Markdown-Tabellenzeile (`\|` bleibt ein Strich im Text). */
export function tableCells(line: string): string[] {
  let s = line;
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let esc = false;
  for (const c of graphemes(s)) {
    if (esc) { if (c !== "|") cur += "\\"; cur += c; esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === "|") { cells.push(trimSpaces(cur)); cur = ""; continue; }
    cur += c;
  }
  cells.push(trimSpaces(cur));
  return cells;
}

// MARK: Inline-Markdown (Swift `InlineMarkdownCodec`)

const ESCAPE = new Set([..."*_`~[]\\$"]);

/** Swift `InlineMarkdownCodec.escape`. */
export function escapeMarkdown(s: string): string {
  let out = "";
  for (const c of graphemes(s)) { if (ESCAPE.has(c)) out += "\\"; out += c; }
  return out;
}

/** Swift `DateParsing.format`: „2024-05-04“ bzw. „2024-05-04 15:30“, mit Ende „ → …“ (lokale Zeitzone). */
export function formatDateValue(d: DateValue): string {
  const f = d.includeTime ? "yyyy-MM-dd HH:mm" : "yyyy-MM-dd";
  let s = formatICU(d.start, f);
  if (d.end !== undefined) s += " → " + formatICU(d.end, f);
  return s;
}

/** RichText → Inline-Markdown. `pageLink` schreibt Erwähnungen von Seiten als Links. */
export function encodeInlineMarkdown(text: RichText | undefined, pageLink: (id: string) => { title: string; url: string } | undefined = () => undefined): string {
  let out = "";
  for (const run of runsOf(text)) {
    if (run.eq !== undefined) { out += `$${run.eq}$`; continue; }
    if (run.mention !== undefined) {
      const m = run.mention as Record<string, { _0: unknown }>;
      const [kind] = Object.keys(m);
      const v = kind !== undefined ? m[kind]?._0 : undefined;
      switch (kind) {
        case "page": { const l = pageLink(v as string); out += l ? `[${escapeMarkdown(l.title)}](${l.url})` : run.t; break; }
        case "date": out += "@" + formatDateValue(v as DateValue); break;
        case "user": out += "@" + (v as string); break;
        case "link": out += `[${escapeMarkdown(run.t)}](${v as string})`; break;
        default: out += run.t;
      }
      continue;
    }
    let s = run.m.c ? run.t : escapeMarkdown(run.t);
    if (s === "") continue;
    // Leerzeichen außen vor den Markierungen lassen.
    const lead = /^ */.exec(s)![0], trail = / *$/.exec(s)![0];
    if (lead.length === s.length) { out += s; continue; }
    s = s.slice(lead.length, s.length - trail.length);
    const m = run.m;
    if (m.c) s = "`" + s + "`";
    if (m.b) s = "**" + s + "**";
    if (m.i) s = "*" + s + "*";
    if (m.s) s = "~~" + s + "~~";
    if (m.u) s = "<u>" + s + "</u>";
    if (m.link !== undefined) s = `[${s}](${m.link})`;
    out += lead + s + trail;
  }
  return out;
}

const SPANS: [string, (m: Marks) => void][] = [
  ["**", (m) => { m.b = true; }], ["__", (m) => { m.b = true; }], ["~~", (m) => { m.s = true; }],
  ["<u>", (m) => { m.u = true; }], ["<b>", (m) => { m.b = true; }], ["<i>", (m) => { m.i = true; }],
  // BSD-260 Teil 9: <mark> (aus ==Hervorheben== in Obsidian/Bear) → gelber Hintergrund
  ["<mark>", (m) => { m.color = "yellowBackground"; }],
  ["*", (m) => { m.i = true; }], ["_", (m) => { m.i = true; }], ["~", (m) => { m.s = true; }],
];

class InlineParser {
  i = 0;
  constructor(readonly chars: string[], readonly resolve: (target: string) => string | undefined) {}

  peek(s: string, at = this.i): boolean {
    const a = graphemes(s);
    if (at + a.length > this.chars.length) return false;
    for (let k = 0; k < a.length; k++) if (this.chars[at + k] !== a[k]) return false;
    return true;
  }

  /** Index des schließenden Trenners (Escapes beachtet). */
  find(d: string, from: number): number | undefined {
    let k = from;
    while (k < this.chars.length) {
      if (this.chars[k] === "\\") { k += 2; continue; }
      if (this.peek(d, k)) return k;
      k++;
    }
    return undefined;
  }

  parse(end: string | undefined, marks: Marks): Run[] {
    const runs: Run[] = [];
    const chars = this.chars;
    let buf = "";
    const flush = () => { if (buf !== "") { runs.push({ t: buf, m: marks }); buf = ""; } };
    while (this.i < chars.length) {
      if (end !== undefined && this.peek(end)) break;
      const i = this.i;
      const c = chars[i]!;
      if (c === "\\" && i + 1 < chars.length) { buf += chars[i + 1]; this.i += 2; continue; }
      if (c === "`") {
        const close = this.find("`", i + 1);
        if (close !== undefined && close > i + 1) {
          flush();
          runs.push({ t: chars.slice(i + 1, close).join(""), m: { ...marks, c: true } });
          this.i = close + 1;
          continue;
        }
      }
      if (c === "$" && i + 1 < chars.length && chars[i + 1] !== " ") {
        const close = this.find("$", i + 1);
        if (close !== undefined && close > i + 1) {
          flush();
          const expr = chars.slice(i + 1, close).join("");
          runs.push({ t: expr, m: PLAIN, eq: expr });
          this.i = close + 1;
          continue;
        }
      }
      let handled = false;
      for (const [d, f] of SPANS) {
        if (!this.peek(d)) continue;
        const closeD = d.startsWith("<") ? "</" + d.slice(1) : d;
        const start = i + graphemes(d).length;
        if (start >= chars.length || chars[start] === " ") continue;
        const close = this.find(closeD, start);
        if (close === undefined || close <= start) continue;
        if (d === "_" && i > 0 && /[\p{L}\p{N}]/u.test(chars[i - 1]!)) continue;
        flush();
        const m: Marks = { ...marks };
        f(m);
        this.i = start;
        runs.push(...this.parse(closeD, m));
        this.i = Math.min(chars.length, this.i + graphemes(closeD).length);
        handled = true;
        break;
      }
      if (handled) continue;
      if (c === "[") {
        const mid = this.find("](", i + 1);
        const close = mid !== undefined ? this.find(")", mid + 2) : undefined;
        if (mid !== undefined && close !== undefined) {
          flush();
          const label = chars.slice(i + 1, mid).join("");
          const target = trimSpaces(chars.slice(mid + 2, close).join(""));
          const page = this.resolve(target);
          if (page !== undefined) runs.push({ t: label, m: PLAIN, mention: { page: { _0: page } } });
          else runs.push(...new InlineParser(graphemes(label), this.resolve).parse(undefined, { ...marks, link: target }));
          this.i = close + 1;
          continue;
        }
      }
      if (c === "<" && (this.peek("<http://") || this.peek("<https://") || this.peek("<mailto:"))) {
        // Autolink <https://…>
        const close = this.find(">", i + 1);
        const url = close !== undefined ? chars.slice(i + 1, close).join("") : "";
        if (close !== undefined && !/\s/.test(url)) {
          flush();
          runs.push({ t: url.replace(/^mailto:/, ""), m: { ...marks, link: url } });
          this.i = close + 1;
          continue;
        }
      }
      if (c === "<" && (this.peek("<br>") || this.peek("<br/>"))) {
        buf += "\n";
        this.i += this.peek("<br>") ? 4 : 5;
        continue;
      }
      buf += c;
      this.i += 1;
    }
    flush();
    return runs;
  }
}

/** Inline-Markdown → Läufe. `resolveLink` macht aus einem Linkziel eine Seitenerwähnung. */
export function decodeInlineMarkdown(s: string, resolveLink: (target: string) => string | undefined = () => undefined): Run[] {
  return normalize(new InlineParser(graphemes(s), resolveLink).parse(undefined, PLAIN));
}

// MARK: CSV (RFC 4180)

export function encodeCSV(rows: string[][], opts: { guardFormulas?: boolean } = {}): string {
  const cell = (raw: string) => {
    const f = opts.guardFormulas ? guardCSVFormula(raw) : raw;
    return /[,"\n\r]/.test(f) ? "\"" + f.replaceAll("\"", "\"\"") + "\"" : f;
  };
  return rows.map((row) => row.map(cell).join(",")).join("\n") + "\n";
}

/**
 * BSD-82: Formel-Injection beim CSV-Export verhindern – Zellen, die Tabellenprogramme als Formel lesen würden
 * (`= + - @`, Tab, CR am Anfang), bekommen ein `'` davor. Reine Zahlen („-5“, „+3,5“) bleiben, wie sie sind.
 */
export function guardCSVFormula(cell: string): string {
  if (!/^[=+\-@\t\r]/.test(cell)) return cell;
  if (/^[+-]?(\d+([.,]\d+)*|[.,]\d+)([eE][+-]?\d+)?%?$/.test(cell)) return cell;
  return "'" + cell;
}

export function decodeCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const chars = graphemes(text);
  let i = chars[0] === "﻿" ? 1 : 0;
  for (; i < chars.length; i++) {
    const c = chars[i]!;
    if (inQuotes) {
      if (c === "\"") {
        if (chars[i + 1] === "\"") { field += "\""; i++; } else inQuotes = false;
      } else field += c;
    } else {
      switch (c) {
        case "\"": inQuotes = true; break;
        case ",": row.push(field); field = ""; break;
        case "\r\n": case "\n": case "\r": row.push(field); field = ""; rows.push(row); row = []; break;
        default: field += c;
      }
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}
