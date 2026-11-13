// ADR 0016 (E5, erster Teil): Einträge des Slash-Menüs im Block-Editor. Reine Daten + Filter; Kürzel im Mac-Stil.
import { createDatabase, insertPage, type Block, type WorkspaceStore } from "@based/core";

export interface SlashItem {
  type: string;
  label: string;
  group: string;
  icon: string;
  keywords: string;
  hint?: string;
  props?: Block["props"];
  /** Sonderfall Unterseite: legt sie an (an Stelle des leeren Blocks oder dahinter) und gibt ihre ID zurück. */
  page?: (store: WorkspaceStore, replace: string | undefined, after: string) => string | undefined;
  /** Spaltenliste mit so vielen Spalten. */
  columns?: number;
  /** Sonderfall mit eigenen Records (Datenbank): legt an und gibt die Block-ID zurück. */
  create?: (store: WorkspaceStore, after: string, replace: boolean) => string | undefined;
}

const subPage = (store: WorkspaceStore, replace: string | undefined, after: string): string | undefined => {
  const a = store.blocks.get(after);
  if (!a) return undefined;
  const parentPage = a.parent.startsWith("b:") ? a.parent.slice(2) : undefined;
  if (!parentPage) return undefined;
  let id: string | undefined;
  store.transact("New page", (tx) => {
    id = insertPage(store, tx, { parent: parentPage, position: { kind: "after", id: after } });
    if (replace) tx.remove(`block:${replace}`);
  });
  return id;
};

export const SLASH_ITEMS: readonly SlashItem[] = [
  { type: "text", label: "Text", group: "Basic blocks", icon: "T", keywords: "paragraph plain" },
  { type: "heading1", label: "Heading 1", group: "Basic blocks", icon: "H1", keywords: "h1 title big", hint: "#" },
  { type: "heading2", label: "Heading 2", group: "Basic blocks", icon: "H2", keywords: "h2 subtitle", hint: "##" },
  { type: "heading3", label: "Heading 3", group: "Basic blocks", icon: "H3", keywords: "h3", hint: "###" },
  { type: "bulletedList", label: "Bulleted list", group: "Basic blocks", icon: "•", keywords: "bullet unordered ul", hint: "-" },
  { type: "numberedList", label: "Numbered list", group: "Basic blocks", icon: "1.", keywords: "ordered ol number", hint: "1." },
  { type: "todo", label: "To-do list", group: "Basic blocks", icon: "☐", keywords: "checkbox task todo", hint: "[]" },
  { type: "toggle", label: "Toggle list", group: "Basic blocks", icon: "▸", keywords: "collapse details", hint: ">", props: { isOpen: true } },
  { type: "quote", label: "Quote", group: "Basic blocks", icon: "❝", keywords: "blockquote citation", hint: "\"" },
  { type: "heading1", label: "Toggle heading 1", group: "Basic blocks", icon: "▸H1", keywords: "toggle collapse h1", props: { toggleable: true, isOpen: true } },
  { type: "heading2", label: "Toggle heading 2", group: "Basic blocks", icon: "▸H2", keywords: "toggle collapse h2", props: { toggleable: true, isOpen: true } },
  { type: "heading3", label: "Toggle heading 3", group: "Basic blocks", icon: "▸H3", keywords: "toggle collapse h3", props: { toggleable: true, isOpen: true } },
  { type: "callout", label: "Callout", group: "Basic blocks", icon: "💡", keywords: "note info tip" },
  { type: "code", label: "Code", group: "Basic blocks", icon: "</>", keywords: "snippet pre", hint: "```" },
  { type: "divider", label: "Divider", group: "Basic blocks", icon: "—", keywords: "hr line separator", hint: "---" },
  { type: "table", label: "Simple table", group: "Basic blocks", icon: "▦", keywords: "grid cells rows columns", props: { tableColumns: 2, tableHeaderRow: true, cells: ["", "", "", ""] } },
  ...[2, 3, 4, 5].map((n): SlashItem => ({ type: "columnList", label: `${n} columns`, group: "Advanced", icon: "▥", keywords: `columns layout side ${n}`, columns: n })),
  { type: "page", label: "Page", group: "Pages", icon: "📄", keywords: "subpage new page", page: subPage },
  { type: "databaseInline", label: "Database", group: "Pages", icon: "▦", keywords: "table inline database grid", create: (store, after, replace) => {
    const a = store.blocks.get(after);
    if (!a) return undefined;
    const r = createDatabase(store, { parent: a.parent, inline: true, position: { after } });
    if (replace) store.transact("Remove empty block", (tx) => tx.remove(`block:${after}`), { coalesce: "db:" + r.blockID });
    return r.blockID;
  } },
  { type: "image", label: "Image", group: "Media", icon: "🖼", keywords: "picture photo upload" },
  { type: "video", label: "Video", group: "Media", icon: "▶", keywords: "movie clip upload" },
  { type: "audio", label: "Audio", group: "Media", icon: "♪", keywords: "sound music recording" },
  { type: "file", label: "File", group: "Media", icon: "📎", keywords: "attachment upload document" },
  { type: "bookmark", label: "Web bookmark", group: "Media", icon: "🔖", keywords: "link url preview" },
  { type: "embed", label: "Embed", group: "Media", icon: "⧉", keywords: "iframe link url" },
  { type: "equation", label: "Block equation", group: "Advanced", icon: "∑", keywords: "math latex tex formula", props: { expression: "" } },
  { type: "tableOfContents", label: "Table of contents", group: "Advanced", icon: "≡", keywords: "toc outline headings" },
];

/** Einträge passend zur Eingabe nach „/“ (Anfang von Name oder Suchwort). */
export function filterSlash(items: readonly SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((it) => it.label.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || it.label.toLowerCase().startsWith(q)
    || it.keywords.split(/\s+/).some((w) => w.startsWith(q)) || it.type.toLowerCase().startsWith(q));
}
