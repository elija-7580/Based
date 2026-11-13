// ADR 0016 (E5, erster Teil): Einträge des Slash-Menüs im Block-Editor. Reine Daten + Filter; Kürzel im Mac-Stil.
import { insertPage, type Block, type WorkspaceStore } from "@based/core";

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
  { type: "callout", label: "Callout", group: "Basic blocks", icon: "💡", keywords: "note info tip" },
  { type: "code", label: "Code", group: "Basic blocks", icon: "</>", keywords: "snippet pre", hint: "```" },
  { type: "divider", label: "Divider", group: "Basic blocks", icon: "—", keywords: "hr line separator", hint: "---" },
  { type: "page", label: "Page", group: "Pages", icon: "📄", keywords: "subpage new page", page: subPage },
];

/** Einträge passend zur Eingabe nach „/“ (Anfang von Name oder Suchwort). */
export function filterSlash(items: readonly SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((it) => it.label.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || it.label.toLowerCase().startsWith(q)
    || it.keywords.split(/\s+/).some((w) => w.startsWith(q)) || it.type.toLowerCase().startsWith(q));
}
