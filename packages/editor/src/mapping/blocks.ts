// BSD-154: Records → BlockNote-Blöcke (Projektion) und BlockNote-Block → eigene Felder (Extraktion).
// Jeder Based-Typ „besitzt“ im Editor nur bestimmte Felder (Text, einige Props); alles andere bleibt im Record
// und wird beim Zurückschreiben übernommen. Unbekannte Typen werden als `opaque` mit dem ganzen Record (`raw`)
// transportiert, damit auch Kopieren/Einfügen sie nicht verliert.
//
// Ein Dokument (ein Y.Doc) gehört zu einer Wurzel: einer Seite oder dem Original eines Synced Blocks.
// Grenzblöcke (Unterseiten, Datenbanken, Synced Blocks, Seitenlinks) erscheinen als Atom; ihre Kinder gehören
// nicht zu diesem Dokument. Tabellenzeilen stecken im Inhalt des Tabellenblocks.
import { canonicalStringify, plainText, type Block, type BlockProps, type RichText } from "@based/core";
import { ASSET_URL_PREFIX, CUSTOM, type BNBlock, type BNTableCell, type BNTableContent } from "./bn.js";
import { canonicalRichText, colorFromBN, colorToBN, inlineToRichText, richTextToInline } from "./richtext.js";

/** Lesender Zugriff auf Records (WorkspaceStore erfüllt das). */
export interface BlockSource {
  readonly blocks: ReadonlyMap<string, Block>;
  children(parent: string): readonly string[];
}

/** Kinder gehören nicht zum Dokument dieses Blocks. */
/** BSD-226: Abschnitte und Transkript eines Meetings zeigt der Meeting-Block selbst (Notizen als eigener Editor). */
/** BSD-210: Die Kinder eines Buttons sind seine Vorlage („Insert blocks“), bearbeitet in der Einrichtung des Buttons. */
export const BOUNDARY_TYPES: ReadonlySet<string> = new Set(["page", "databasePage", "syncedBlock", "databaseInline", "linkToPage", "meeting", "button"]);

/** Bekannte Typen, die der Editor nur als Atom zeigt (Inhalt bleibt unverändert im Record). */
const OPAQUE_KNOWN: ReadonlySet<string> = new Set(["meetingSection", "transcript", "tableRow"]);

const LIST_COLOR = ["color"];
/** Felder (in `props`), die der Editor je Typ besitzt; `text` siehe OWNS_TEXT. */
export const OWNED_PROPS: Readonly<Record<string, readonly string[]>> = {
  text: LIST_COLOR, bulletedList: LIST_COLOR, numberedList: LIST_COLOR, toggle: LIST_COLOR, quote: LIST_COLOR,
  heading1: ["color", "toggleable"], heading2: ["color", "toggleable"], heading3: ["color", "toggleable"], heading4: ["color", "toggleable"],
  todo: ["checked", "color"],
  callout: ["color", "icon"],
  code: ["language", "wrap"],
  equation: ["expression"],
  image: ["url", "asset", "caption", "width", "align"], video: ["url", "asset", "caption", "width", "align"], audio: ["url", "asset", "caption"], file: ["url", "asset", "caption"],
  pdf: ["url", "asset"], embed: ["url"], bookmark: ["url", "bookmark"],
  linkToPage: ["linkTarget"],
  syncedBlock: ["syncSource"],
  databaseInline: ["databaseID", "viewIDs"],
  column: ["ratio"],
  table: ["tableColumns", "tableHeaderRow", "tableHeaderColumn", "tableColumnWidths"],
  tableRow: ["cells", "cellColors"],
  meeting: [],
};

export const OWNS_TEXT: ReadonlySet<string> = new Set([
  "text", "heading1", "heading2", "heading3", "heading4", "bulletedList", "numberedList", "todo", "toggle", "quote", "callout", "code",
]);

/** Metadaten, die nie im Editor stehen. */
const META_KEYS = ["id", "parent", "sk", "createdAt", "updatedAt", "createdBy", "updatedBy", "stamp", "trashedAt"] as const;

/** BSD-209: Bookmark-Vorschau aus dem JSON im Editor; Ungültiges oder Leeres → keine. */
export function bookmarkMeta(v: unknown): Record<string, unknown> | undefined {
  if (typeof v !== "string" || v === "") return undefined;
  try {
    const o: unknown = JSON.parse(v);
    return o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length > 0 ? (o as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** BSD-290: Ausrichtung eines Medienblocks; „left“ (Vorgabe) und Unbekanntes werden nicht gespeichert. */
export function mediaAlign(v: unknown): "center" | "right" | undefined {
  return v === "center" || v === "right" ? v : undefined;
}

export function isOpaqueType(type: string): boolean {
  return OPAQUE_KNOWN.has(type) || !(type in OWNED_PROPS || OWNS_TEXT.has(type) || KNOWN_ATOMS.has(type));
}
const KNOWN_ATOMS: ReadonlySet<string> = new Set(["divider", "tableOfContents", "breadcrumb", "button", "page", "databasePage", "columnList"]);

/** Der Record ohne Metadaten, als JSON – Inhalt eines `opaque`-Blocks. */
export function rawOf(b: Block): string {
  const d = { ...(b as Record<string, unknown>) };
  for (const k of META_KEYS) delete d[k];
  return canonicalStringify(d);
}

const visible = (src: BlockSource, parent: string) =>
  src.children(parent).map((id) => src.blocks.get(id)).filter((b): b is Block => b !== undefined && b.trashedAt === undefined);

/** Die Blöcke eines Dokuments (Kinder der Wurzel, ohne Papierkorb). */
export function projectDoc(src: BlockSource, rootID: string): BNBlock[] {
  return visible(src, "b:" + rootID).map((b) => projectBlock(b, src));
}

/** Alle Record-IDs, die das Dokument zeigt (inkl. Tabellenzeilen). */
export function docBlockIDs(src: BlockSource, rootID: string): Set<string> {
  const out = new Set<string>();
  const walk = (parent: string) => {
    for (const b of visible(src, parent)) {
      out.add(b.id);
      if (b.type === "table") {
        for (const r of tableRows(src, b.id)) out.add(r.id);
      } else if (!BOUNDARY_TYPES.has(b.type)) walk("b:" + b.id);
    }
  };
  walk("b:" + rootID);
  return out;
}

export function tableRows(src: BlockSource, tableID: string): Block[] {
  return visible(src, "b:" + tableID).filter((r) => r.type === "tableRow");
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Ein Record als BlockNote-Block. Ohne `src` ohne Kinder und Tabellenzeilen. */
export function projectBlock(b: Block, src?: BlockSource): BNBlock {
  const p: BlockProps = b.props ?? {};
  const children = (): BNBlock[] => (src && !BOUNDARY_TYPES.has(b.type) ? projectDoc(src, b.id) : []);
  const colored = (type: string, extra: Record<string, unknown> = {}): BNBlock => ({
    id: b.id, type, props: { ...colorToBN(p.color), ...extra }, content: richTextToInline(b.text), children: children(),
  });
  const atom = (type: string, props: Record<string, unknown> = {}): BNBlock => ({ id: b.id, type, props, children: children() });
  if (isOpaqueType(b.type)) return atom(CUSTOM.opaque, { blockType: b.type, raw: rawOf(b) });
  switch (b.type) {
    case "text": return colored("paragraph");
    case "heading1": case "heading2": case "heading3": case "heading4":
      return colored("heading", { level: Number(b.type.slice(-1)), isToggleable: p.toggleable === true });
    case "bulletedList": return colored("bulletListItem");
    case "numberedList": return colored("numberedListItem");
    case "todo": return colored("checkListItem", { checked: p.checked === true });
    case "toggle": return colored("toggleListItem");
    case "quote": return colored("quote");
    case "callout": return colored(CUSTOM.callout, { icon: typeof p.icon === "string" ? p.icon : "" });
    case "divider": return atom("divider");
    // Umbruch: an, solange er nicht ausdrücklich abgeschaltet ist (so zeichnet Based Next Code seit jeher).
    case "code": return { id: b.id, type: "codeBlock", props: { language: p.language ?? "text", wrap: p.wrap !== false }, content: plainText(b.text), children: children() };
    case "equation": return atom(CUSTOM.equation, { expression: p.expression ?? "" });
    case "image": case "video": case "audio": case "file":
      return atom(b.type, {
        url: p.url ?? (p.asset ? ASSET_URL_PREFIX + p.asset.id : ""),
        name: p.asset?.name ?? "",
        caption: plainText(p.caption),
        // BSD-168/290: Breite eines Bildes/Videos (Griff ziehen) wie Swift `props.width` in Punkten.
        ...((b.type === "image" || b.type === "video") && typeof p.width === "number" && p.width > 0 ? { previewWidth: p.width } : {}),
        // BSD-290: Ausrichtung eines Bildes/Videos (links, Mitte, rechts) wie Notion; fehlt = links.
        ...((b.type === "image" || b.type === "video") ? { textAlignment: mediaAlign(p.align) ?? "left" } : {}),
      });
    // BSD-208: hochgeladene PDFs liegen wie Dateien als `asset` vor (Swift), im Editor als based-asset:-URL.
    case "pdf": case "embed": case "bookmark": return atom(CUSTOM.embed, {
      kind: b.type, url: p.url ?? (b.type === "pdf" && p.asset ? ASSET_URL_PREFIX + p.asset.id : ""),
      // BSD-209: geholte Bookmark-Vorschau (Titel, Beschreibung, …) wie Swift `props.bookmark`, im Editor als JSON.
      ...(b.type === "bookmark" && p.bookmark ? { meta: canonicalStringify(p.bookmark) } : {}),
    });
    case "tableOfContents": return atom(CUSTOM.toc);
    case "breadcrumb": return atom(CUSTOM.breadcrumb);
    case "button": return atom(CUSTOM.button);
    case "page": case "databasePage": return atom(CUSTOM.page, { variant: b.type === "databasePage" ? "database" : "page" });
    case "linkToPage": return atom(CUSTOM.linkToPage, { target: p.linkTarget ?? "" });
    case "syncedBlock": return atom(CUSTOM.syncedBlock, { source: p.syncSource ?? "" });
    case "databaseInline": return atom(CUSTOM.database, { databaseID: p.databaseID ?? "", viewID: p.viewIDs?.[0] ?? "" });
    case "columnList": return atom(CUSTOM.columnList);
    case "meeting": return atom(CUSTOM.meeting);
    case "column": return atom(CUSTOM.column, { width: p.ratio ?? 0 });
    case "table": return projectTable(b, src ? tableRows(src, b.id) : []);
  }
  return atom(CUSTOM.opaque, { blockType: b.type, raw: rawOf(b) });
}

function projectTable(b: Block, rows: Block[]): BNBlock {
  const p = b.props ?? {};
  const cols = Math.max(p.tableColumns ?? 0, ...rows.map((r) => r.props?.cells?.length ?? 0), 1);
  const widths = Array.from({ length: cols }, (_, i) => p.tableColumnWidths?.[i]);
  const content: BNTableContent = {
    type: "tableContent",
    columnWidths: widths,
    headerRows: p.tableHeaderRow ? 1 : 0,
    headerCols: p.tableHeaderColumn ? 1 : 0,
    // Eine Tabelle ohne Zeilen-Records zeigt eine leere Zeile (BlockNote braucht mindestens eine).
    rows: (rows.length ? rows : [undefined]).map((r) => ({
      cells: Array.from({ length: cols }, (_, i): BNTableCell => ({
        type: "tableCell",
        props: { ...colorToBN(r?.props?.cellColors?.[i]), textAlignment: "left" },
        content: richTextToInline(r?.props?.cells?.[i]),
      })),
    })),
  };
  return { id: b.id, type: "table", props: { textColor: "default" }, content, children: [] };
}

/** Was der Editor an einem Block besitzt, in Record-Begriffen. */
export interface Owned {
  type: string;
  /** Nur für Typen mit Text (OWNS_TEXT). */
  text?: RichText | undefined;
  props: Partial<Record<string, unknown>>;
  /** Für `opaque`: der ganze Record (ohne Metadaten). */
  raw?: Record<string, unknown>;
  /** Für Tabellen: Zeilen mit ihren Feldern. */
  rows?: { cells: (RichText | undefined)[]; cellColors?: (string | null)[] | undefined }[];
}

const nonEmpty = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/** Eigene Felder eines BlockNote-Blocks. */
export function extractOwned(bn: BNBlock): Owned {
  const p = bn.props ?? {};
  const color = colorFromBN(p.textColor, p.backgroundColor);
  const withText = (type: string, props: Record<string, unknown> = {}): Owned => ({
    type, text: inlineToRichText(bn.content), props: { color, ...props },
  });
  switch (bn.type) {
    case "paragraph": return withText("text");
    case "heading": {
      const level = Math.min(Math.max(Number(p.level) || 1, 1), 4);
      return withText("heading" + level, { toggleable: p.isToggleable === true ? true : undefined });
    }
    case "bulletListItem": return withText("bulletedList");
    case "numberedListItem": return withText("numberedList");
    case "checkListItem": return withText("todo", { checked: p.checked === true ? true : undefined });
    case "toggleListItem": return withText("toggle");
    case "quote": return withText("quote");
    case CUSTOM.callout: return withText("callout", { icon: nonEmpty(p.icon) });
    case "divider": return { type: "divider", props: {} };
    case "codeBlock": {
      const code = Array.isArray(bn.content) ? (bn.content as { text?: string }[]).map((c) => c.text ?? "").join("") : str(bn.content);
      const lang = str(p.language);
      return { type: "code", text: code === "" ? undefined : code, props: { language: lang === "" || lang === "text" ? undefined : lang, wrap: p.wrap === false ? false : undefined } };
    }
    case CUSTOM.equation: return { type: "equation", props: { expression: nonEmpty(p.expression) } };
    case "image": case "video": case "audio": case "file": {
      const url = str(p.url);
      const asset = url.startsWith(ASSET_URL_PREFIX) ? { id: url.slice(ASSET_URL_PREFIX.length), name: str(p.name) } : undefined;
      const w = Number(p.previewWidth);
      const width = (bn.type === "image" || bn.type === "video") && Number.isFinite(w) && w > 0 ? w : undefined;
      const align = bn.type === "image" || bn.type === "video" ? mediaAlign(p.textAlignment) : undefined;
      return { type: bn.type, props: { url: asset ? undefined : nonEmpty(url), asset, caption: nonEmpty(p.caption), width, align } };
    }
    case CUSTOM.embed: {
      const kind = str(p.kind);
      const url = str(p.url);
      if (kind === "pdf" && url.startsWith(ASSET_URL_PREFIX)) return { type: "pdf", props: { asset: { id: url.slice(ASSET_URL_PREFIX.length), name: "" } } };
      if (kind === "bookmark") return { type: "bookmark", props: { url: nonEmpty(url), bookmark: bookmarkMeta(p.meta) } };
      return { type: kind === "pdf" ? kind : "embed", props: { url: nonEmpty(url) } };
    }
    case CUSTOM.toc: return { type: "tableOfContents", props: {} };
    case CUSTOM.breadcrumb: return { type: "breadcrumb", props: {} };
    case CUSTOM.button: return { type: "button", props: {} };
    case CUSTOM.page: return { type: p.variant === "database" ? "databasePage" : "page", props: {} };
    case CUSTOM.linkToPage: return { type: "linkToPage", props: { linkTarget: nonEmpty(p.target) } };
    case CUSTOM.syncedBlock: return { type: "syncedBlock", props: { syncSource: nonEmpty(p.source) } };
    case CUSTOM.database: {
      const view = nonEmpty(p.viewID);
      return { type: "databaseInline", props: { databaseID: nonEmpty(p.databaseID), viewIDs: view ? [view] : undefined } };
    }
    case CUSTOM.columnList: return { type: "columnList", props: {} };
    case CUSTOM.meeting: return { type: "meeting", props: {} };
    case CUSTOM.column: {
      const w = Number(p.width);
      return { type: "column", props: { ratio: w > 0 ? w : undefined } };
    }
    case CUSTOM.opaque: {
      let raw: Record<string, unknown> = {};
      try {
        raw = JSON.parse(str(p.raw) || "{}") as Record<string, unknown>;
      } catch { /* kaputtes raw: leerer Block */ }
      const type = typeof raw.type === "string" ? raw.type : str(p.blockType) || "text";
      return { type, props: {}, raw: { ...raw, type } };
    }
    case "table": return extractTable(bn);
  }
  // Unbekannter BlockNote-Typ: als Text retten.
  return withText("text");
}

function extractTable(bn: BNBlock): Owned {
  const c = bn.content as BNTableContent | undefined;
  const widths = c?.columnWidths ?? [];
  const rows = (c?.rows ?? []).map((r) => {
    const cells = r.cells.map((cell): { props: Record<string, unknown>; content: unknown } => (Array.isArray(cell) ? { props: {}, content: cell } : cell));
    const colors = cells.map((cell) => colorFromBN(cell.props?.textColor, cell.props?.backgroundColor) ?? null);
    return {
      cells: cells.map((cell) => inlineToRichText(cell.content)),
      cellColors: colors.some((x) => x !== null) ? colors : undefined,
    };
  });
  const cols = Math.max(widths.length, ...rows.map((r) => r.cells.length), 0);
  return {
    type: "table",
    props: {
      tableColumns: cols || undefined,
      tableHeaderRow: c?.headerRows ? true : undefined,
      // Bestehen alle Zeilen aus Kopfzellen, lässt sich eine Kopfspalte nicht unterscheiden.
      tableHeaderColumn: c?.headerCols && rows.length > (c.headerRows ?? 0) ? true : undefined,
      tableColumnWidths: widths.length > 0 && widths.every((w) => typeof w === "number") ? (widths as number[]) : undefined,
    },
    rows,
  };
}

/** Felder eines Tabellenzeilen-Records, wie der Editor sie sieht (für den Vergleich). */
export function ownedRow(r: Block, cols: number): { cells: (RichText | undefined)[]; cellColors?: (string | null)[] | undefined } {
  const cells = Array.from({ length: cols }, (_, i) => canonicalRichText(r.props?.cells?.[i]));
  const colors = Array.from({ length: cols }, (_, i) => colorFromBN(colorToBN(r.props?.cellColors?.[i]).textColor, colorToBN(r.props?.cellColors?.[i]).backgroundColor) ?? null);
  return { cells, cellColors: colors.some((x) => x !== null) ? colors : undefined };
}
