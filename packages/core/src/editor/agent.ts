// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Agent-Parität (docs/agent-parity.md, Eintrag 2/7): der Seiten-Editor für Agenten – als Text, wie das Whiteboard
// (whiteboard/agent.ts). Wenige Token, nie halb geschrieben.
//
// Lesen – `blockOutline`: eine Zeile je Block mit kurzer Kennung, Art, Einrückung, Text und Stil.
// Schreiben – `runBlockScript`: eine Anweisung je Zeile; `BLOCK_SCRIPT_HELP` beschreibt sie für Agenten. Jede
// Anweisung benutzt die Befehle des Editors (commands/), also dieselbe Logik wie Griff, Blockmenü und Tastatur.
// Das ganze Skript ist EINE Transaktion (`store.atomic`); eine falsche Zeile wird mit Grund gemeldet und allein
// zurückgedreht, der Rest gilt.
import type { Block, BlockProps, RichText } from "../model/records.js";
import { ENUMS } from "../model/schema.js";
import type { Tx, WorkspaceStore } from "../store/store.js";
import { insertPage, isPageLike, sortKeys, type InsertPosition } from "../store/pages.js";
import { createDatabase, createLinkedView } from "../store/database-ops.js";
import { syncedOriginal, syncedPasteProblem, unsyncCopy } from "../store/synced.js";
import { setButton, type ButtonAction } from "../store/button-ops.js";
import { parseDate } from "../query/value.js";
import type { BookmarkMeta } from "../interop/link-preview.js";
import { createMeeting } from "../store/meeting-ops.js";
import { insertBoardPage, isBoardPage } from "../whiteboard/records.js";
import type { BoardFileInfo } from "../whiteboard/placefile.js";
import { encodeInlineMarkdown, formatDateValue, type MarkdownBlock, type MarkdownImporter } from "../interop/markdown.js";
import { makeBlock, makeRecordID } from "../interop/builder.js";
import { toRichText, type Run } from "../interop/runs.js";
import { plainText } from "../richtext.js";
import { titleOf } from "../query/engine.js";
import { CODE_VIEWS, codeLanguageID, codePreviewKind } from "./syntax.js";
import { create, wrapInSyncedBlock, deleteBlocks, dissolveColumns, duplicateBlocks, indentBlocks, moveBlocks, moveBlocksToPage, outdentBlocks, setBlockProps, setBlockText, setChecked, turnInto, turnIntoEquation, turnIntoPage } from "./commands/blocks.js";
import { addTableColumn, addTableRow, deleteTableColumn, deleteTableRow, setTableCell, tableModel, tableProps } from "./commands/table.js";
import { blockText, plainRuns } from "./commands/text.js";
import { canNestUnder, isToggle, liveChildren, TEXT_TYPES } from "./commands/tree.js";

/** Größtes Skript (Zeichen) und größte Zahl Anweisungen je Aufruf. */
export const BLOCK_SCRIPT_MAX = 200_000;
export const BLOCK_SCRIPT_MAX_LINES = 2_000;

// MARK: Arten und Farben – Namen wie in der Oberfläche, aus den Listen des Kerns

/** Kurzname im Skript ↔ Blockart im Record. */
const TYPE_NAMES: readonly (readonly [string, string])[] = [
  ["text", "text"], ["h1", "heading1"], ["h2", "heading2"], ["h3", "heading3"], ["h4", "heading4"], ["bullet", "bulletedList"], ["number", "numberedList"],
  ["todo", "todo"], ["toggle", "toggle"], ["quote", "quote"], ["callout", "callout"], ["code", "code"], ["divider", "divider"], ["equation", "equation"],
  ["image", "image"], ["video", "video"], ["audio", "audio"], ["file", "file"], ["pdf", "pdf"], ["bookmark", "bookmark"], ["embed", "embed"],
  ["toc", "tableOfContents"], ["table", "table"], ["cols", "columnList"], ["col", "column"], ["page", "page"], ["database", "databaseInline"],
  ["synced", "syncedBlock"], ["button", "button"], ["meeting", "meeting"], ["breadcrumb", "breadcrumb"], ["link", "linkToPage"],
];
const TO_TYPE = new Map<string, string>([...TYPE_NAMES, ["linked", "databaseInline"]]);
const TO_NAME = new Map(TYPE_NAMES.map(([n, t]) => [t, n]));
TO_NAME.set("databasePage", "database");
const MEDIA = new Set(["image", "video", "audio", "file", "pdf"]);
/** Was `<art>: …` anlegen kann (dazu `md` und `board`). */
const CREATABLE = ["text", "h1", "h2", "h3", "h4", "bullet", "number", "todo", "toggle", "quote", "callout", "code", "divider", "equation", "image", "video", "audio", "file", "pdf", "bookmark", "embed", "toc", "table", "cols", "page", "database", "meeting", "linked", "synced", "button"];

/** Farbnamen der Blöcke (`color=` Textfarbe, `bg=` Hintergrund) aus der Liste des Kerns. */
export const BLOCK_COLOR_NAMES: readonly string[] = (ENUMS.TColor as readonly string[]).filter((c) => c !== "default" && !c.endsWith("Background"));
const ALIGNS = ["left", "center", "right"];
/** `show=` am HTML- und Mermaid-Block ↔ `codeView` im Record. */
const SHOW: Record<string, string> = { code: "code", both: "split", result: "preview" };
const SHOWN = new Map(Object.entries(SHOW).map(([k, v]) => [v, k]));

/** Kurzbeschreibung des Skripts für Agenten (Werkzeugbeschreibung von edit_blocks, MCP und Baseds eigene Agenten). */
export const BLOCK_SCRIPT_HELP = [
  "One statement per line; handles come from read_blocks (or names you give in this script). Write line breaks inside a text as \\n.",
  `Create: <kind>: text  or  <kind> name: text — kinds: ${CREATABLE.join(" ")}. Text is inline Markdown (**bold**, *italic*, \`code\`, [link](url), [Page](based://page/<id>) = mention).`,
  "  md: <Markdown> inserts any number of blocks (headings, nested lists, tables, code fences). page/database/board/meeting: the text is the title. image/video/audio/file/pdf: a file ref (list_files, upload_file) or an https URL. bookmark/embed: a URL. equation: TeX. table: cells with | and rows with \\n (a | b\\nc | d). cols: the number of columns (2–5); fill them with {in=name.1}, {in=name.2}.",
  "Where: {after=h} {before=h} {in=h} (as the last block inside a toggle, callout, list item, column …) {left=h} {right=h} (in a column beside h). Without it: after the block the previous line put into the flow (lines with in=, left=, right= don't count), else at the end of the page.",
  "  linked: <database id> shows an existing database here ({view=table|board|…}). synced: <id of a synced block> puts a live copy here; sync h [h…] turns blocks into a synced block others can copy; unsync h makes a copy independent. button: Label {add=<database id> open=<page id> url=https://… confirm=\"Sure?\" insert} – the steps run in this order; insert adds the blocks you put {in=} the button.",
  "  A date in a text: @2026-11-20, @2026-11-20 14:00, @2026-11-20 → 2026-11-22, with a reminder @2026-11-20 09:00 (remind).",
  "Change: set h: new text | set h {attrs} | move h [h…] {after=|before=|in=|left=|right=|page=<page id>} | indent h… | outdent h… | dup h… | del h… | check h… | uncheck h… | uncols h (columns back to one flow)",
  "Tables: cell h 2,1: text (row,column from 1) | row h add | row h del 3 | col h add | col h del 2",
  `Attributes go last in braces: {color=blue} or {bg=blue} (${BLOCK_COLOR_NAMES.join(" ")}; color=default clears) · {type=h2} turns a block into another kind (also page, equation) · {toggle} on headings · {open=false} · {checked} · {icon=💡} on callouts · {lang=js wrap} on code · {show=code|both|result} on html and mermaid code · {width=400 align=center caption="…"} on media · {ratio=0.6} on a column (h.1 = first column of cols h) · {header=false} on tables.`,
  "A text that itself ends in {…} and has no attributes needs an empty {} after it. Lines starting with # are comments. A wrong line is skipped with its reason; the other lines are applied. One call is one undo step.",
].join("\n");

// MARK: Lesen

interface Line {
  block: Block;
  depth: number;
}

/**
 * Die Blöcke einer Seite in Lesereihenfolge. Unterseiten, Datenbanken und Meetings stehen als eine Zeile da; ihr
 * Inhalt gehört nicht zur Seite (eigene Seite bzw. eigener Reiter), Tabellenzeilen zeigt der Umriss an der Tabelle.
 */
function pageLines(store: WorkspaceStore, pageID: string): Line[] {
  const out: Line[] = [];
  const visit = (parent: string, depth: number) => {
    for (const id of store.children(parent)) {
      const b = store.blocks.get(id);
      if (!b || b.trashedAt !== undefined || b.type === "tableRow") continue;
      out.push({ block: b, depth });
      if (isPageLike(b) || b.type === "databaseInline" || b.type === "table" || b.type === "meeting" || b.type === "linkToPage") continue;
      visit("b:" + id, depth + 1);
    }
  };
  visit("b:" + pageID, 0);
  return out;
}

/** Kürzeste eindeutige Kennung je ID (mindestens 4 Zeichen vom Anfang, klein geschrieben). */
export function shortHandles(ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const sorted = ids.map((id) => [id.toLowerCase(), id] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (let i = 0; i < sorted.length; i++) {
    const [low, id] = sorted[i]!;
    const common = (o: string | undefined) => { if (!o) return 0; let n = 0; while (n < low.length && n < o.length && low[n] === o[n]) n += 1; return n; };
    const n = Math.max(4, common(sorted[i - 1]?.[0]) + 1, common(sorted[i + 1]?.[0]) + 1);
    out.set(id, low.slice(0, Math.min(n, low.length)));
  }
  return out;
}

/** Kennungen aller Blöcke einer Seite (Block-ID → Kennung). */
export function blockHandles(store: WorkspaceStore, pageID: string): Map<string, string> {
  return shortHandles(pageLines(store, pageID).map((l) => l.block.id));
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s*\n\s*/g, " ⏎ ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}… (+${t.length - max + 1})` : t;
};
const quote = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

function colorAttr(c: string | undefined): string | undefined {
  if (!c || c === "default") return undefined;
  return c.endsWith("Background") ? `bg=${c.slice(0, -"Background".length)}` : `color=${c}`;
}

export interface BlockOutlineOptions {
  /** Erste Zeile (0 = von vorn) und höchstens so viele Zeilen. */
  offset?: number;
  limit?: number;
  /** Längster Text je Zeile (Zeichen); der Rest steht als „… (+N)“ da. `read_page` hat den vollen Text. */
  maxText?: number;
  /** Erwähnungen als Markdown-Links schreiben. */
  pageLink?: (id: string) => { title: string; url: string } | undefined;
}

/**
 * Eine Seite als knapper Text: eine Zeile je Block – Kennung, Art, Text, `{Stil}`; Einrückung = Verschachtelung. Die
 * Kennungen gelten in `runBlockScript`. Lange Seiten: `offset`/`limit`, das Ende nennt, wie es weitergeht.
 */
export function blockOutline(store: WorkspaceStore, pageID: string, opts: BlockOutlineOptions = {}): string {
  const lines = pageLines(store, pageID);
  if (lines.length === 0) return "(empty page)";
  const handles = shortHandles(lines.map((l) => l.block.id));
  const max = opts.maxText ?? 140;
  const md = (t: RichText | undefined) => encodeInlineMarkdown(t, opts.pageLink);
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, opts.limit ?? 200);
  const out: string[] = [];
  for (const { block: b, depth } of lines.slice(offset, offset + limit)) {
    const p = b.props ?? {};
    const name = TO_NAME.get(b.type) ?? b.type;
    const attrs: string[] = [];
    let body = "";
    const color = colorAttr(p.color);
    if (color) attrs.push(color);
    switch (b.type) {
      case "todo": body = `${p.checked ? "[x]" : "[ ]"} ${quote(oneLine(md(b.text), max))}`; break;
      case "code": {
        const text = plainText(b.text);
        const n = text.split("\n").length;
        body = `${quote(oneLine(text.split("\n")[0] ?? "", Math.min(max, 60)))}${n > 1 ? ` (${n} lines)` : ""}`;
        if (p.language) attrs.push(`lang=${p.language}`);
        if (p.wrap) attrs.push("wrap");
        if (p.codeView && codePreviewKind(p.language)) attrs.push(`show=${SHOWN.get(p.codeView) ?? p.codeView}`);
        break;
      }
      case "equation": body = quote(oneLine(p.expression ?? plainText(b.text), max)); break;
      case "image": case "video": case "audio": case "file": case "pdf": {
        body = p.asset ? `${quote(p.asset.name)} based-asset:${p.asset.id}` : p.url ? p.url : "(empty)";
        if (p.width) attrs.push(`width=${Math.round(p.width)}`);
        const align = (p as { align?: string }).align;
        if (align) attrs.push(`align=${align}`);
        const cap = md(p.caption);
        if (cap) attrs.push(`caption=${quote(oneLine(cap, 60))}`);
        break;
      }
      case "bookmark": case "embed": body = p.url ?? "(empty)"; break;
      case "table": {
        const m = tableModel(store, b.id);
        body = `${m?.rows.length ?? 0}x${m?.cols ?? 0}`;
        if (m && !m.header) attrs.push("header=false");
        break;
      }
      case "columnList": body = String(liveChildren(store, b.id).length); break;
      case "column": if (p.ratio !== undefined) attrs.push(`ratio=${p.ratio}`); break;
      case "page": case "databasePage": body = `${quote(titleOf(store, b.id) || "Untitled")} (id: ${b.id})${isBoardPage(b) ? " board" : ""}`; break;
      case "databaseInline": body = `${quote(p.databaseID ? plainText(store.databases.get(p.databaseID)?.title) || "Untitled" : "Untitled")}${p.databaseID ? ` (id: ${p.databaseID})` : ""}`; break;
      case "linkToPage": body = p.linkTarget ? `${quote(titleOf(store, p.linkTarget) || "Untitled")} (id: ${p.linkTarget})` : "(empty)"; break;
      case "meeting": body = quote(oneLine(plainText(b.text) || "Meeting", max)); break;
      case "syncedBlock": body = p.syncSource ? `copy of ${p.syncSource}` : `(id: ${b.id})`; break;
      case "button": {
        body = quote(p.buttonLabel ?? (plainText(b.text) || "Button"));
        for (const act of p.buttonActions ?? (p.buttonAction ? [p.buttonAction] : [])) {
          attrs.push(act.kind === "addPage" ? `add=${act.targetID ?? "?"}` : act.kind === "openPage" ? `open=${act.targetID ?? "?"}` : act.kind === "openURL" ? `url=${act.url ?? "?"}` : act.kind === "confirm" ? `confirm=${quote(act.message ?? "")}` : act.kind === "insertBlocks" ? "insert" : String(act.kind));
        }
        break;
      }
      case "divider": case "tableOfContents": case "breadcrumb": break;
      default: {
        body = quote(oneLine(md(b.text), max));
        if (b.type === "callout" && typeof p.icon === "string") attrs.push(`icon=${p.icon}`);
        if (p.toggleable) attrs.push("toggle");
        if (isToggle(b) && p.isOpen === false) attrs.push("open=false");
      }
    }
    out.push(`${"  ".repeat(depth)}${handles.get(b.id)!} ${name}${body ? " " + body : ""}${attrs.length ? ` {${attrs.join(" ")}}` : ""}`);
    if (b.type === "table") {
      const m = tableModel(store, b.id);
      for (const r of m?.rows ?? []) out.push(`${"  ".repeat(depth + 1)}| ${r.cells.map((c) => oneLine(plainText(c), 40)).join(" | ")} |`);
    }
  }
  const rest = lines.length - offset - Math.min(limit, Math.max(0, lines.length - offset));
  if (rest > 0) out.push(`… ${rest} more blocks (offset: ${offset + limit})`);
  return out.length ? out.join("\n") : `(no blocks from offset ${offset}; the page has ${lines.length})`;
}

// MARK: Schreiben

/** Markdown-Blöcke in einer Transaktion schreiben; `firstID` = ID des ersten Blocks. Gibt die IDs der obersten Ebene zurück. */
export function putMarkdownBlocks(store: WorkspaceStore, tx: Tx, items: MarkdownBlock[], parent: string, keys: string[], firstID?: string): string[] {
  const ids: string[] = [];
  items.forEach((item, i) => {
    const props: BlockProps = { ...item.props };
    if (item.type === "table" && props.tableColumns === undefined) props.tableColumns = 2;
    const id = i === 0 && firstID ? firstID : makeRecordID();
    ids.push(id);
    tx.put({ kind: "block", data: makeBlock({ id, type: item.type, parent, sk: keys[i]!, text: toRichText(item.text), props, createdBy: store.userID }, store.now()) });
    if (item.children.length > 0) putMarkdownBlocks(store, tx, item.children, "b:" + id, sortKeys(store, "b:" + id, { kind: "end" }, item.children.length));
  });
  return ids;
}

export interface BlockScriptOptions {
  /** Markdown lesen (Text der Blöcke, `md`); löst Links auf Seiten zu Erwähnungen auf. */
  importer: MarkdownImporter;
  /** Was über eine Datei bekannt ist (Name, Art, Größe) – für `image`, `file` … mit einer Datei-Adresse. */
  files?: (ref: string) => BoardFileInfo | undefined;
  /**
   * Vorschau eines Links (Titel, Beschreibung, Bild), wenn der Host sie vorher geholt hat – dann zeigt ein neues
   * Bookmark gleich die Karte. Ohne: nur der Link (der Mensch kann „Fetch preview“ drücken).
   */
  linkPreview?: (url: string) => BookmarkMeta | undefined;
}

const DATE_MENTION = /@(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)(?: (?:→|->) (\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?))?( \(remind\))?/g;

/**
 * Daten im Text (`@2026-11-20`, mit Uhrzeit, als Bereich, mit „(remind)“) werden Datums-Erwähnungen – dieselbe Form,
 * in der der Markdown-Export sie schreibt. Nur in gewöhnlichem Text (nicht in Code, Links, anderen Erwähnungen).
 */
export function withDateMentions(runs: readonly Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (r.mention !== undefined || r.eq !== undefined || r.m.c || r.m.link || !r.t.includes("@")) { out.push(r); continue; }
    let last = 0;
    for (const m of r.t.matchAll(DATE_MENTION)) {
      const start = parseDate(m[1]!);
      const end = m[2] ? parseDate(m[2]) : undefined;
      if (!start || (m[2] && !end)) continue;
      const value = { start: start.start, includeTime: start.includeTime, ...(end ? { end: end.start } : {}), ...(m[3] ? { remind: true } : {}) };
      if (m.index > last) out.push({ ...r, t: r.t.slice(last, m.index) });
      out.push({ t: "@" + formatDateValue(value), m: {}, mention: { date: { _0: value } } } as Run);
      last = m.index + m[0].length;
    }
    if (last === 0) out.push(r);
    else if (last < r.t.length) out.push({ ...r, t: r.t.slice(last) });
  }
  return out;
}

/** Wie `withDateMentions`, für ganze Markdown-Blöcke (auch verschachtelt; Code bleibt, wie er ist). */
export function markdownWithDateMentions(blocks: MarkdownBlock[]): MarkdownBlock[] {
  return blocks.map((b) => ({ ...b, text: b.type === "code" ? b.text : withDateMentions(b.text), children: markdownWithDateMentions(b.children) }));
}

export interface BlockScriptResult {
  added: number;
  changed: number;
  moved: number;
  removed: number;
  /** Namen aus dem Skript → Block-ID (bei `page`/`board` die neue Seite, bei `database` ihr Block). */
  names: Map<string, string>;
  /** Neu angelegte Datenbanken: Block-ID → Datenbank-ID (für add_row, create_view …). */
  databases: Map<string, string>;
  /** IDs neuer Synced-Originale (`sync …`) – mit `synced: <id>` auf jeder Seite als Kopie einsetzbar. */
  synced: string[];
  /** Übersprungene Zeilen mit Grund („line 3: …“). */
  errors: string[];
}

class LineError extends Error {}
const fail = (msg: string): never => {
  throw new LineError(msg);
};

type Attrs = Map<string, string | true>;

/** `{a=b c="d e" flag}` am Zeilenende abtrennen. Kein gültiger Attribut-Block → gehört zum Text. `{}` = leer (Trenner). */
function splitAttrs(line: string): { rest: string; attrs: Attrs } {
  const attrs: Attrs = new Map();
  if (!line.endsWith("}")) return { rest: line, attrs };
  // die letzte öffnende Klammer, die nicht in Anführungszeichen steht
  let open = -1, inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i - 1] !== "\\") inQuote = !inQuote;
    else if (c === "{" && !inQuote) open = i;
  }
  if (open < 0 || (open > 0 && !/\s/.test(line[open - 1]!))) return { rest: line, attrs };
  const inner = line.slice(open + 1, -1).trim();
  const re = /([A-Za-z_][\w-]*)(?:=(?:"((?:[^"\\]|\\.)*)"|(\S+)))?(?:\s+|$)/y;
  let pos = 0;
  while (pos < inner.length) {
    re.lastIndex = pos;
    const m = re.exec(inner);
    if (!m) return { rest: line, attrs: new Map() };
    attrs.set(m[1]!.toLowerCase(), m[2] !== undefined ? m[2].replace(/\\(["\\])/g, "$1") : m[3] !== undefined ? m[3] : true);
    pos = re.lastIndex;
  }
  return { rest: line.slice(0, open).trimEnd(), attrs };
}

const unescape = (s: string) => s.replace(/\\(n|\\)/g, (_, c: string) => (c === "n" ? "\n" : "\\"));

const PLACE_KEYS = ["after", "before", "in", "left", "right"] as const;
type PlaceKey = (typeof PLACE_KEYS)[number];

function colorOf(attrs: Attrs): string | undefined | null {
  const c = attrs.get("color"), bg = attrs.get("bg");
  if (c === undefined && bg === undefined) return null;
  if (c !== undefined && bg !== undefined) return fail("give color= or bg=, not both");
  const v = String(c ?? bg).toLowerCase();
  if (v === "default" || v === "none") return undefined;
  if (!BLOCK_COLOR_NAMES.includes(v)) return fail(`unknown colour ${v} — use ${BLOCK_COLOR_NAMES.join(", ")} or default`);
  return bg !== undefined ? `${v}Background` : v;
}

const flag = (attrs: Attrs, k: string): boolean | undefined => {
  const v = attrs.get(k);
  if (v === undefined) return undefined;
  if (v === true || v === "true" || v === "yes") return true;
  if (v === "false" || v === "no") return false;
  return fail(`${k} must be true or false`);
};

/**
 * Ein Skript auf einer Seite ausführen (siehe `BLOCK_SCRIPT_HELP`). Eine Transaktion; jede Zeile für sich: scheitert
 * sie, ist nichts von ihr geschrieben, und der Grund steht in `errors`.
 */
export function runBlockScript(store: WorkspaceStore, pageID: string, script: string, opts: BlockScriptOptions): BlockScriptResult {
  const result: BlockScriptResult = { added: 0, changed: 0, moved: 0, removed: 0, names: new Map(), databases: new Map(), synced: [], errors: [] };
  if (script.length > BLOCK_SCRIPT_MAX) {
    result.errors.push(`script too long (${script.length} characters, max ${BLOCK_SCRIPT_MAX}) — nothing was changed`);
    return result;
  }
  const lines = script.split(/\r?\n/).map((l) => l.trim());
  if (lines.filter((l) => l && !l.startsWith("#")).length > BLOCK_SCRIPT_MAX_LINES) {
    result.errors.push(`too many statements (max ${BLOCK_SCRIPT_MAX_LINES}) — nothing was changed`);
    return result;
  }
  const names = result.names;
  /** Wohin die nächste neue Zeile ohne Ortsangabe kommt: hinter den zuletzt angelegten Block. */
  let cursor: string | undefined;
  /** In diesem Skript angelegte Spaltenlisten: leere Spalten bekommen am Ende einen leeren Textblock. */
  const newLists: string[] = [];

  const inPage = (id: string): boolean => {
    for (let b = store.blocks.get(id), i = 0; b && i < 200; i++) {
      if (b.id === pageID) return true;
      if (!b.parent.startsWith("b:")) return false;
      const up = store.blocks.get(b.parent.slice(2));
      // eine Unterseite ist Teil der Seite, ihr Inhalt nicht
      if (up && up.id !== pageID && isPageLike(up)) return false;
      b = up;
    }
    return false;
  };

  /** BSD-663: Blöcke der Seite vor dem Skript – auf sie beziehen sich die Kennungen aus read_blocks. */
  const readBefore = new Set(pageLines(store, pageID).map((l) => l.block.id));

  /** Kennung, Name aus dem Skript oder volle ID → Block-ID. `x.2` = zweites Kind (Spalte) von x. */
  const resolve = (raw: string): string => {
    const dot = /^(.+)\.(\d+)$/.exec(raw);
    if (dot && !names.has(raw)) {
      const base = resolve(dot[1]!);
      const kids = liveChildren(store, base);
      return kids[Number(dot[2]) - 1] ?? fail(`${raw}: ${dot[1]} has ${kids.length} part${kids.length === 1 ? "" : "s"}`);
    }
    const named = names.get(raw);
    if (named !== undefined) return store.blocks.has(named) ? named : fail(`${raw} no longer exists`);
    const low = raw.toLowerCase();
    const ids = pageLines(store, pageID).map((l) => l.block.id);
    const exact = ids.find((id) => id.toLowerCase() === low);
    if (exact) return exact;
    const hits = low.length >= 4 ? ids.filter((id) => id.toLowerCase().startsWith(low)) : [];
    if (hits.length === 1) return hits[0]!;
    // BSD-663: Kennungen stammen aus read_blocks vor dem Skript. Ein Block, den eine frühere Zeile angelegt hat (neue,
    // zufällige ID mit gleichem Anfang), macht sie nicht mehrdeutig – dann gilt der Block, der schon vorher da war.
    const old = hits.filter((id) => readBefore.has(id));
    if (old.length === 1) return old[0]!;
    if (hits.length > 1) return fail(`${raw} matches ${hits.length} blocks — use a longer handle from read_blocks`);
    // Spalten und Blöcke in Spalten stehen im Umriss; alles andere gehört nicht zu dieser Seite
    if (store.blocks.has(raw) && inPage(raw)) return raw;
    return fail(`no block ${raw} on this page (read_blocks shows the handles)`);
  };

  const refs = (s: string): string[] => {
    const parts = s.split(/[\s,]+/).filter(Boolean);
    if (parts.length === 0) fail("which block? give a handle");
    return parts.map(resolve);
  };

  /** `flow`: die Stelle liegt im Fluss der Seite (ohne Angabe, after=, before=) – nur dann wandert die Schreibmarke mit. */
  interface Place { parent: string; position: InsertPosition; flow: boolean; side?: { zone: "left" | "right"; target: string } }

  const placeOf = (attrs: Attrs, fallback: boolean): Place | undefined => {
    const given = PLACE_KEYS.filter((k) => attrs.has(k));
    if (given.length > 1) return fail(`give one place, not ${given.join(" and ")}`);
    const key: PlaceKey | undefined = given[0];
    if (!key) {
      if (!fallback) return undefined;
      const c = cursor && store.blocks.has(cursor) ? store.blocks.get(cursor)! : undefined;
      return c ? { parent: c.parent, position: { kind: "after", id: c.id }, flow: true } : { parent: "b:" + pageID, position: { kind: "end" }, flow: true };
    }
    const v = attrs.get(key);
    if (v === true) return fail(`${key}= needs a handle`);
    const id = resolve(String(v));
    const b = store.blocks.get(id)!;
    switch (key) {
      case "after": case "before":
        if (b.type === "column") return fail(`${v} is a column — use in=${v}`);
        return { parent: b.parent, position: { kind: key, id }, flow: true };
      case "in":
        if (b.type === "columnList") return fail(`${v} is a column list — use in=${v}.1, in=${v}.2 …`);
        if (b.type === "syncedBlock" && b.props?.syncSource) return fail(`${v} is a copy of a synced block — change the original (${b.props.syncSource})`);
        if (b.type !== "column" && b.type !== "syncedBlock" && b.type !== "button" && !canNestUnder(b)) return fail(`nothing can go inside a ${TO_NAME.get(b.type) ?? b.type} block — use after=${v}`);
        return { parent: "b:" + id, position: { kind: "end" }, flow: false };
      default:
        if (b.type === "column" || b.type === "columnList") return fail(`${key}= needs a block, not a column`);
        return { parent: "b:" + pageID, position: { kind: "end" }, flow: false, side: { zone: key, target: id } };
    }
  };

  const keyAt = (tx: Tx, p: Place, n = 1): string[] => {
    void tx;
    return sortKeys(store, p.parent, p.position, n);
  };

  /** Nach dem Anlegen: neben einen Block stellen (`left=`/`right=`), Namen merken, Schreibmarke weitersetzen. */
  const placed = (ids: string[], p: Place, name: string | undefined) => {
    if (ids.length === 0) return;
    if (p.side) moveBlocks(store, ids, p.side.target, p.side.zone);
    if (name) names.set(name, ids[0]!);
    // in=, left=, right= sind Abstecher: die nächste Zeile ohne Ortsangabe geht im Fluss weiter, nicht im Kasten.
    if (p.flow) cursor = ids[ids.length - 1]!;
    result.added += ids.length;
  };

  const inline = (s: string): Run[] => withDateMentions(opts.importer.inline(s));

  const mediaProps = (type: string, content: string, attrs: Attrs): { type: string; props: BlockProps } => {
    const props: Record<string, unknown> = {};
    let kind = type;
    const src = content.trim();
    if (src.startsWith("based-asset:")) {
      const info = opts.files?.(src);
      if (!info) return fail(`unknown file ${src.slice(0, 24)}… — list_files shows the refs`);
      props.asset = { id: src.slice("based-asset:".length), name: info.name, ...(info.mime ? { mime: info.mime } : {}), ...(info.size ? { size: Math.round(info.size) } : {}) };
      // `file` nimmt die Art aus der Datei: ein Bild wird ein Bild, ein PDF ein PDF.
      if (type === "file") kind = info.mime.startsWith("image/") ? "image" : info.mime === "application/pdf" || info.pages?.length ? "pdf" : info.mime.startsWith("video/") ? "video" : info.mime.startsWith("audio/") ? "audio" : "file";
    } else if (/^https?:\/\//i.test(src)) props.url = src;
    else if (src !== "") return fail(`${type} needs a file ref (based-asset:…) or an https URL`);
    Object.assign(props, mediaAttrs(attrs));
    return { type: kind, props: props as BlockProps };
  };

  const mediaAttrs = (attrs: Attrs): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const w = attrs.get("width");
    if (w !== undefined) {
      const n = Number(w);
      if (!Number.isFinite(n) || n < 40 || n > 4000) return fail("width must be between 40 and 4000 (px)");
      out.width = Math.round(n);
    }
    const al = attrs.get("align");
    if (al !== undefined) {
      if (!ALIGNS.includes(String(al))) return fail(`align must be ${ALIGNS.join(", ")}`);
      out.align = al === "left" ? undefined : al;
    }
    const cap = attrs.get("caption");
    if (cap !== undefined) out.caption = cap === true || cap === "" ? undefined : blockText(inline(unescape(String(cap))));
    return out;
  };

  /** Stil-Attribute, die es für die Art gibt, als Props (`undefined` = entfernen). Unbekannte Attribute sind ein Fehler. */
  const styleProps = (type: string, attrs: Attrs, known: Set<string>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const color = colorOf(attrs);
    if (color !== null) { out.color = color; known.add("color"); known.add("bg"); }
    const use = (k: string) => { known.add(k); return attrs.get(k); };
    if (type === "todo") { const c = flag(attrs, "checked"); known.add("checked"); if (c !== undefined) out.checked = c ? true : undefined; }
    if (/^heading[1-4]$/.test(type)) { const t = flag(attrs, "toggle"); known.add("toggle"); if (t !== undefined) { out.toggleable = t ? true : undefined; if (t) out.isOpen = true; } }
    if (type === "toggle" || /^heading[1-4]$/.test(type)) { const o = flag(attrs, "open"); known.add("open"); if (o !== undefined) out.isOpen = o; }
    if (type === "callout") { const i = use("icon"); if (i !== undefined) out.icon = i === true || i === "" || i === "none" ? undefined : String(i); }
    if (type === "code") {
      const l = use("lang");
      if (l !== undefined) out.language = l === true || l === "" ? undefined : codeLanguageID(String(l));
      const w = flag(attrs, "wrap"); known.add("wrap");
      if (w !== undefined) out.wrap = w ? true : undefined;
      const s = use("show");
      if (s !== undefined) {
        const view = SHOW[String(s)];
        if (!view || !(CODE_VIEWS as readonly string[]).includes(view)) return fail("show must be code, both or result");
        out.codeView = view;
      }
    }
    if (MEDIA.has(type)) { for (const k of ["width", "align", "caption"]) known.add(k); Object.assign(out, mediaAttrs(attrs)); }
    if (type === "column") {
      const r = use("ratio");
      if (r !== undefined) {
        const n = Number(r);
        if (!Number.isFinite(n) || n <= 0 || n >= 1) return fail("ratio must be between 0 and 1 (share of the width)");
        out.ratio = Math.round(n * 1000) / 1000;
      }
    }
    if (type === "table") { const h = flag(attrs, "header"); known.add("header"); if (h !== undefined) out.tableHeaderRow = h; }
    return out;
  };

  const checkKnown = (attrs: Attrs, known: Set<string>, what: string) => {
    for (const k of attrs.keys()) if (!known.has(k)) fail(`${what} has no attribute ${k}`);
  };

  const clean = (p: Record<string, unknown>): BlockProps | undefined => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) if (v !== undefined) out[k] = v;
    return Object.keys(out).length ? (out as BlockProps) : undefined;
  };

  // MARK: die Anweisungen

  const doCreate = (kindName: string, name: string | undefined, raw: string, attrs: Attrs) => {
    const place = placeOf(attrs, true)!;
    const known = new Set<string>(PLACE_KEYS);
    const content = unescape(raw);
    if (kindName === "md") {
      checkKnown(attrs, known, "md");
      const blocks = markdownWithDateMentions(opts.importer.parse(content));
      if (blocks.length === 0) return fail("md: nothing to insert");
      const ids = store.transact("Insert", (tx) => putMarkdownBlocks(store, tx, blocks, place.parent, keyAt(tx, place, blocks.length)));
      return placed(ids, place, name);
    }
    const parentID = place.parent.startsWith("b:") ? place.parent.slice(2) : undefined;
    if (kindName === "page" || kindName === "board") {
      checkKnown(attrs, known, kindName);
      const id = store.transact("New page", (tx) => (kindName === "board" ? insertBoardPage : insertPage)(store, tx, { ...(parentID ? { parent: parentID } : {}), position: place.position, ...(content.trim() ? { title: content.trim() } : {}) }));
      return placed([id], place, name);
    }
    if (kindName === "database") {
      known.add("view");
      checkKnown(attrs, known, "database");
      const view = attrs.get("view");
      if (view !== undefined && !(ENUMS.ViewType as readonly string[]).includes(String(view))) return fail(`view must be one of ${(ENUMS.ViewType as readonly string[]).join(", ")}`);
      const pos = place.position;
      const made = createDatabase(store, {
        parent: place.parent, title: content.trim() || "Untitled", inline: true, sampleRows: 0, ...(view !== undefined ? { viewType: String(view) } : {}),
        position: pos.kind === "end" ? "end" : pos.kind === "before" ? { before: pos.id } : { after: pos.id },
      });
      result.databases.set(made.blockID, made.databaseID);
      return placed([made.blockID], place, name);
    }
    if (kindName === "meeting") {
      checkKnown(attrs, known, "meeting");
      const id = createMeeting(store, { parent: place.parent, sk: sortKeys(store, place.parent, place.position, 1)[0]!, ...(content.trim() ? { title: content.trim() } : {}) });
      return placed([id], place, name);
    }
    const dbPosition = (): { before: string } | { after: string } | "end" => (place.position.kind === "end" ? "end" : place.position.kind === "before" ? { before: place.position.id } : { after: place.position.id });
    if (kindName === "linked") {
      known.add("view");
      checkKnown(attrs, known, "linked");
      const view = attrs.get("view") === undefined ? "table" : String(attrs.get("view"));
      if (!(ENUMS.ViewType as readonly string[]).includes(view)) return fail(`view must be one of ${(ENUMS.ViewType as readonly string[]).join(", ")}`);
      const given = content.trim();
      const db = store.databases.get(given) ?? [...store.databases.values()].find((d) => d.blockID === given);
      if (!db) return fail("linked needs the id of a database (list_databases shows the ids)");
      const made = createLinkedView(store, db.id, place.parent, view, { position: dbPosition() });
      if (!made) return fail("could not link that database");
      result.databases.set(made.blockID, db.id);
      return placed([made.blockID], place, name);
    }
    if (kindName === "synced") {
      checkKnown(attrs, known, "synced");
      const given = content.trim();
      if (!given) return fail("synced needs the id of a synced block (read_blocks shows it as synced (id: …)); to make one use: sync h [h…]");
      let source = given;
      try { source = resolve(given); } catch { /* eine ID von einer anderen Seite */ }
      const problem = syncedPasteProblem(store, source, pageID);
      if (problem) return fail(problem === "noSource" ? `${given} is not a synced block` : problem === "insideItself" ? "a synced block can't contain a copy of itself" : "this page already shows that synced block");
      const original = syncedOriginal(store, source)!;
      const id = store.transact("Synced copy", (tx) => create(store, tx, "syncedBlock", place.parent, keyAt(tx, place)[0]!, [], { syncSource: original }));
      return placed([id], place, name);
    }
    if (kindName === "button") {
      const actions: ButtonAction[] = [];
      for (const [k, v] of attrs) {
        if ((PLACE_KEYS as readonly string[]).includes(k)) continue;
        const val = v === true ? "" : String(v);
        switch (k) {
          case "add": {
            const db = store.databases.get(val) ?? [...store.databases.values()].find((d) => d.blockID === val);
            if (!db) return fail("add= needs the id of a database");
            actions.push({ kind: "addPage", targetID: db.id });
            break;
          }
          case "open": {
            const pg = store.blocks.get(val);
            if (!pg || !isPageLike(pg)) return fail("open= needs the id of a page");
            actions.push({ kind: "openPage", targetID: pg.id });
            break;
          }
          case "url": if (!/^https?:\/\//i.test(val)) return fail("url= needs an http(s) URL"); actions.push({ kind: "openURL", url: val }); break;
          case "confirm": actions.push({ kind: "confirm", message: unescape(val) || "Continue?" }); break;
          case "insert": actions.push({ kind: "insertBlocks" }); break;
          default: return fail(`button has no attribute ${k} — use add=, open=, url=, confirm=, insert`);
        }
      }
      if (actions.length === 0) actions.push({ kind: "insertBlocks" });
      const id = store.transact("New button", (tx) => create(store, tx, "button", place.parent, keyAt(tx, place)[0]!, [], { buttonLabel: content.trim() || "Button", buttonActions: actions }));
      return placed([id], place, name);
    }
    const type = TO_TYPE.get(kindName);
    if (!type || !CREATABLE.includes(kindName)) return fail(`unknown kind ${kindName} — use ${CREATABLE.join(", ")}, md or board`);
    if (type === "columnList") {
      checkKnown(attrs, known, "cols");
      const n = content.trim() === "" ? 2 : Number(content.trim());
      if (!Number.isInteger(n) || n < 2 || n > 5) return fail("cols takes the number of columns, 2 to 5");
      const id = store.transact("Columns", (tx) => {
        const list = create(store, tx, "columnList", place.parent, keyAt(tx, place)[0]!);
        const keys = sortKeys(store, "b:" + list, { kind: "end" }, n);
        for (let i = 0; i < n; i++) create(store, tx, "column", "b:" + list, keys[i]!);
        return list;
      });
      newLists.push(id);
      return placed([id], place, name);
    }
    if (type === "table") {
      const style = styleProps(type, attrs, known);
      checkKnown(attrs, known, "table");
      const rows = content.trim() === "" ? [["", ""], ["", ""]] : content.split("\n").filter((r) => r.trim() !== "").map((r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim()));
      const cols = Math.max(1, ...rows.map((r) => r.length));
      const id = store.transact("New table", (tx) => {
        const t = create(store, tx, "table", place.parent, keyAt(tx, place)[0]!, [], { ...tableProps(cols), ...(style.tableHeaderRow === false ? { tableHeaderRow: false } : {}) });
        const keys = sortKeys(store, "b:" + t, { kind: "end" }, rows.length);
        rows.forEach((r, i) => create(store, tx, "tableRow", "b:" + t, keys[i]!, [], { cells: Array.from({ length: cols }, (_, k) => blockText(inline(r[k] ?? "")) ?? "") }));
        return t;
      });
      return placed([id], place, name);
    }
    let finalType = type;
    let props: Record<string, unknown> = {};
    let runs: Run[] = [];
    if (MEDIA.has(type)) {
      const m = mediaProps(type, content, attrs);
      finalType = m.type;
      props = { ...(m.props as Record<string, unknown>) };
      for (const k of ["width", "align", "caption"]) known.add(k);
      const color = colorOf(attrs);
      if (color !== null) { known.add("color"); known.add("bg"); }
    } else if (type === "bookmark" || type === "embed") {
      if (!/^https?:\/\//i.test(content.trim())) return fail(`${kindName} needs an http(s) URL`);
      props.url = content.trim();
      const preview = type === "bookmark" ? opts.linkPreview?.(content.trim()) : undefined;
      if (preview && Object.keys(preview).length > 0) props.bookmark = preview;
    } else if (type === "equation") props.expression = content;
    else if (type === "divider" || type === "tableOfContents") { if (content.trim()) return fail(`${kindName} takes no text`); }
    else {
      runs = type === "code" ? plainRuns([{ t: content, m: {} } as Run]) : inline(content);
      if (type === "toggle") props.isOpen = true;
      Object.assign(props, styleProps(type, attrs, known));
    }
    if (type === "equation" || type === "bookmark" || type === "embed" || type === "divider" || type === "tableOfContents") {
      const color = colorOf(attrs);
      if (color !== null) { props.color = color; known.add("color"); known.add("bg"); }
    }
    checkKnown(attrs, known, kindName);
    const id = store.transact("New block", (tx) => create(store, tx, finalType, place.parent, keyAt(tx, place)[0]!, runs, clean(props)));
    placed([id], place, name);
  };

  const doSet = (target: string, raw: string | undefined, attrs: Attrs) => {
    const id = resolve(target);
    let b = store.blocks.get(id)!;
    const known = new Set<string>(["type"]);
    // 1. Art ändern (Turn into)
    const to = attrs.get("type");
    if (to !== undefined) {
      const kind = String(to).toLowerCase();
      if (kind === "page") {
        if (!TEXT_TYPES.has(b.type)) return fail(`only a text block can become a page, ${target} is a ${TO_NAME.get(b.type) ?? b.type}`);
        if (!turnIntoPage(store, id)) return fail(`${target} could not become a page`);
      } else if (kind === "equation") {
        if (!turnIntoEquation(store, [id])) return fail(`only a text block can become an equation`);
      } else {
        const type = TO_TYPE.get(kind);
        if (!type || !TEXT_TYPES.has(type)) return fail(`type must be one of ${[...TEXT_TYPES].map((t) => TO_NAME.get(t)).join(", ")}, page or equation`);
        if (!TEXT_TYPES.has(b.type)) return fail(`${target} is a ${TO_NAME.get(b.type) ?? b.type} block and can't be turned into ${kind}`);
        if (b.type !== type) turnInto(store, [id], type, type === "toggle" ? { isOpen: true } : {});
      }
      b = store.blocks.get(id)!;
    }
    // 2. Text
    if (raw !== undefined) {
      const content = unescape(raw);
      if (TEXT_TYPES.has(b.type)) setBlockText(store, id, blockText(b.type === "code" ? plainRuns([{ t: content, m: {} } as Run]) : inline(content)));
      else if (isPageLike(b)) store.transact("Rename", (tx) => tx.update(id, (x) => { if (content.trim()) x.text = content.trim(); else delete x.text; }));
      else if (b.type === "equation") setBlockProps(store, [id], { expression: content });
      else if (b.type === "bookmark" || b.type === "embed") {
        if (!/^https?:\/\//i.test(content.trim())) return fail(`${TO_NAME.get(b.type)} needs an http(s) URL`);
        const preview = b.type === "bookmark" ? opts.linkPreview?.(content.trim()) : undefined;
        setBlockProps(store, [id], { url: content.trim(), ...(b.type === "bookmark" ? { bookmark: preview && Object.keys(preview).length > 0 ? preview : undefined } : {}) } as Partial<BlockProps>);
      } else if (MEDIA.has(b.type)) {
        const m = mediaProps(b.type, content, new Map());
        setBlockProps(store, [id], { asset: undefined, url: undefined, ...m.props });
      } else if (b.type === "button") setButton(store, id, { label: content.trim() });
      else if (b.type === "meeting") store.transact("Rename", (tx) => tx.update(id, (x) => { x.text = content.trim() || "Meeting"; }));
      else return fail(`a ${TO_NAME.get(b.type) ?? b.type} block has no text to set`);
    }
    // 3. Stil
    const style = styleProps(b.type, attrs, known);
    checkKnown(attrs, known, `a ${TO_NAME.get(b.type) ?? b.type} block`);
    if (Object.keys(style).length > 0) {
      if (style.checked !== undefined || (b.type === "todo" && "checked" in style)) setChecked(store, id, style.checked === true);
      const rest = { ...style };
      delete rest.checked;
      if (Object.keys(rest).length > 0) setBlockProps(store, [id], rest as Partial<BlockProps>);
    }
    if (to === undefined && raw === undefined && Object.keys(style).length === 0) return fail("set needs a text or attributes");
    result.changed += 1;
  };

  const doMove = (targets: string, attrs: Attrs) => {
    const ids = refs(targets);
    const page = attrs.get("page");
    const known = new Set<string>([...PLACE_KEYS, "page"]);
    checkKnown(attrs, known, "move");
    if (page !== undefined) {
      if (PLACE_KEYS.some((k) => attrs.has(k))) return fail("give page= or a place on this page, not both");
      const dest = store.blocks.get(String(page));
      if (!dest || !isPageLike(dest) || dest.trashedAt !== undefined) return fail(`no page ${String(page)}`);
      const n = moveBlocksToPage(store, ids, dest.id);
      if (n === 0) return fail("nothing was moved (a block can't move into itself)");
      result.moved += n;
      return;
    }
    const place = placeOf(attrs, false);
    if (!place) return fail("move needs a place: after=, before=, in=, left=, right= or page=");
    let ok;
    if (place.side) ok = moveBlocks(store, ids, place.side.target, place.side.zone);
    else if (place.position.kind === "end") {
      // `in=`: ans Ende des Ziels (der Griff legt an den Anfang; für Agenten ist „hinten anfügen“ das Erwartbare)
      const target = place.parent.slice(2);
      const kids = liveChildren(store, target).filter((k) => !ids.includes(k));
      ok = kids.length > 0 ? moveBlocks(store, ids, kids[kids.length - 1]!, "after") : moveBlocks(store, ids, target, "inside");
    } else ok = moveBlocks(store, ids, place.position.id, place.position.kind);
    if (!ok) return fail("nothing was moved (already there, or a block can't move into itself)");
    result.moved += ids.length;
  };

  const doTable = (verb: "row" | "col", rest: string) => {
    const m = /^(\S+)\s+(add|del)(?:\s+(\d+))?$/.exec(rest.trim());
    if (!m) return fail(`${verb} h add | ${verb} h del <number>`);
    const id = resolve(m[1]!);
    if (store.blocks.get(id)?.type !== "table") return fail(`${m[1]} is not a table`);
    let ok: boolean;
    if (m[2] === "add") ok = verb === "row" ? addTableRow(store, id) : addTableColumn(store, id);
    else {
      if (!m[3]) return fail(`${verb} del needs the number (from 1)`);
      ok = verb === "row" ? deleteTableRow(store, id, Number(m[3]) - 1) : deleteTableColumn(store, id, Number(m[3]) - 1);
    }
    if (!ok) return fail(`no such ${verb === "row" ? "row" : "column"}, or it is the last one`);
    result.changed += 1;
  };

  const statement = (line: string) => {
    const { rest, attrs } = splitAttrs(line);
    // Anweisungen ohne Doppelpunkt
    const verb = /^(set|move|del|dup|indent|outdent|check|uncheck|uncols|sync|unsync|row|col)\s+([^:]*)$/.exec(rest);
    if (verb) {
      const [, v, arg] = verb as unknown as [string, string, string];
      switch (v) {
        case "set": return doSet(arg.trim(), undefined, attrs);
        case "move": return doMove(arg, attrs);
        case "row": case "col": return doTable(v, arg);
      }
      if (attrs.size > 0) return fail(`${v} takes no attributes`);
      const ids = refs(arg);
      switch (v) {
        case "del": {
          const n = new Set(ids).size;
          deleteBlocks(store, ids);
          result.removed += n;
          return;
        }
        case "dup": if (!duplicateBlocks(store, ids)) return fail("nothing to duplicate"); result.added += ids.length; return;
        case "indent": if (!indentBlocks(store, ids)) return fail("can't indent: there is no block above to go under"); result.moved += ids.length; return;
        case "outdent": if (!outdentBlocks(store, ids)) return fail("can't outdent: already at the top level"); result.moved += ids.length; return;
        case "check": case "uncheck":
          for (const id of ids) {
            if (store.blocks.get(id)?.type !== "todo") return fail("check works on to-do blocks");
            setChecked(store, id, v === "check");
          }
          result.changed += ids.length;
          return;
        case "sync": {
          const made = wrapInSyncedBlock(store, ids);
          if (!made) return fail("sync needs blocks that sit next to each other (same parent)");
          result.synced.push(made);
          result.changed += 1;
          return;
        }
        case "unsync":
          for (const id of ids) if (!unsyncCopy(store, id)) return fail("unsync works on a copy of a synced block");
          result.changed += ids.length;
          return;
        case "uncols": {
          for (const id of ids) {
            if (store.blocks.get(id)?.type !== "columnList") return fail("uncols works on a cols block");
            dissolveColumns(store, id);
          }
          result.changed += ids.length;
          return;
        }
      }
    }
    const setText = /^set\s+(\S+)\s*:\s?(.*)$/s.exec(rest);
    if (setText) return doSet(setText[1]!, setText[2]!, attrs);
    const cell = /^cell\s+(\S+)\s+(\d+)\s*,\s*(\d+)\s*:\s?(.*)$/s.exec(rest);
    if (cell) {
      if (attrs.size > 0) return fail("cell takes no attributes");
      const id = resolve(cell[1]!);
      const m = tableModel(store, id);
      if (!m) return fail(`${cell[1]} is not a table`);
      const r = Number(cell[2]) - 1, c = Number(cell[3]) - 1;
      if (r < 0 || r >= m.rows.length || c < 0 || c >= m.cols) return fail(`the table has ${m.rows.length} rows and ${m.cols} columns`);
      setTableCell(store, id, r, c, unescape(cell[4]!));
      result.changed += 1;
      return;
    }
    const make = /^([A-Za-z][\w]*)(?:\s+([A-Za-z_][\w-]*))?\s*:\s?(.*)$/s.exec(rest);
    if (make) return doCreate(make[1]!.toLowerCase(), make[2], make[3]!, attrs);
    // `divider`, `toc` und `cols` gehen auch ohne Doppelpunkt
    const bare = /^(divider|toc|cols)(?:\s+([A-Za-z_][\w-]*))?$/.exec(rest);
    if (bare) return doCreate(bare[1]!, bare[2], "", attrs);
    return fail("not understood — see the statement list in the tool description");
  };

  store.atomic("Agent: edit blocks", () => {
    lines.forEach((line, i) => {
      if (!line || line.startsWith("#")) return;
      try {
        // Eine Zeile = ein Teil der Transaktion: wirft sie, wird genau sie zurückgedreht.
        store.transact("line", () => statement(line));
      } catch (e) {
        if (!(e instanceof LineError)) throw e;
        result.errors.push(`line ${i + 1}: ${line.length > 60 ? line.slice(0, 59) + "…" : line} — ${e.message}`);
      }
    });
    // Leere Spalten kann man in der Oberfläche nicht anklicken: jede bekommt einen leeren Textblock.
    for (const list of newLists) {
      if (!store.blocks.has(list)) continue;
      const empty = liveChildren(store, list).filter((c) => store.blocks.get(c)?.type === "column" && store.children("b:" + c).length === 0);
      if (empty.length > 0) store.transact("Columns", (tx) => { for (const c of empty) create(store, tx, "text", "b:" + c, sortKeys(store, "b:" + c, { kind: "end" }, 1)[0]!); });
    }
  });
  return result;
}
