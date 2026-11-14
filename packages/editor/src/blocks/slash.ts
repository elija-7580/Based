// ADR 0016 (E5, erster Teil): Einträge des Slash-Menüs im Block-Editor. Reine Daten + Filter; Kürzel im Mac-Stil.
import type { BlockIconName } from "./icons.js";
import { blockCommands, createDatabase, insertMeetingAfter, insertPage, type Block, type WorkspaceStore } from "@based/core";

export interface SlashItem {
  type: string;
  label: string;
  group: string;
  /** Icon aus dem Based-Satz (blocks/icons.tsx), kein Emoji. */
  icon: BlockIconName;
  keywords: string;
  hint?: string;
  props?: Block["props"];
  /** Sonderfall Unterseite: legt sie an (an Stelle des leeren Blocks oder dahinter) und gibt ihre ID zurück. */
  page?: (store: WorkspaceStore, replace: string | undefined, after: string) => string | undefined;
  /** BSD-407: kein Block, sondern ein Element im Text (Inline-Gleichung). */
  inline?: "equation";
  /** Spaltenliste mit so vielen Spalten. */
  columns?: number;
  /** BSD-407 Teil 3: „Linked view of database“ – erst eine Datenbank wählen (Auswahl wie im alten Editor). */
  linkDatabase?: true;
  /** BSD-407 Teil 6.6: kein Block – öffnet „Ask AI“ (nur mit eingeschaltetem AI-Schalter im Menü). */
  ai?: true;
  /** Block, dessen Einrichtung gleich aufgehen soll (Button). */
  setup?: true;
  /** Sonderfall mit eigenen Records (Datenbank): legt an und gibt die Block-ID zurück. */
  create?: (store: WorkspaceStore, after: string, replace: boolean) => string | undefined;
  /** `create` gibt einen Textblock zurück: Schreibmarke hinein statt Blockauswahl (Meeting: erste Notiz). */
  caret?: true;
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
  { type: "text", label: "Text", group: "Basic blocks", icon: "text", keywords: "paragraph plain" },
  { type: "heading1", label: "Heading 1", group: "Basic blocks", icon: "heading1", keywords: "h1 title big", hint: "#" },
  { type: "heading2", label: "Heading 2", group: "Basic blocks", icon: "heading2", keywords: "h2 subtitle", hint: "##" },
  { type: "heading3", label: "Heading 3", group: "Basic blocks", icon: "heading3", keywords: "h3", hint: "###" },
  { type: "bulletedList", label: "Bulleted list", group: "Basic blocks", icon: "bulletedList", keywords: "bullet unordered ul", hint: "-" },
  { type: "numberedList", label: "Numbered list", group: "Basic blocks", icon: "numberedList", keywords: "ordered ol number", hint: "1." },
  { type: "todo", label: "To-do list", group: "Basic blocks", icon: "todo", keywords: "checkbox task todo", hint: "[]" },
  { type: "toggle", label: "Toggle list", group: "Basic blocks", icon: "toggle", keywords: "collapse details", hint: ">", props: { isOpen: true } },
  { type: "quote", label: "Quote", group: "Basic blocks", icon: "quote", keywords: "blockquote citation", hint: "\"" },
  { type: "heading1", label: "Toggle heading 1", group: "Basic blocks", icon: "toggleHeading1", keywords: "toggle collapse h1", props: { toggleable: true, isOpen: true } },
  { type: "heading2", label: "Toggle heading 2", group: "Basic blocks", icon: "toggleHeading2", keywords: "toggle collapse h2", props: { toggleable: true, isOpen: true } },
  { type: "heading3", label: "Toggle heading 3", group: "Basic blocks", icon: "toggleHeading3", keywords: "toggle collapse h3", props: { toggleable: true, isOpen: true } },
  { type: "heading1", label: "Section", group: "Basic blocks", icon: "section", keywords: "section colored toggle area group bereich abschnitt", props: { toggleable: true, isOpen: true, color: "grayBackground" } },
  { type: "callout", label: "Callout", group: "Basic blocks", icon: "callout", keywords: "note info tip" },
  { type: "code", label: "Code", group: "Basic blocks", icon: "code", keywords: "snippet pre", hint: "```" },
  { type: "divider", label: "Divider", group: "Basic blocks", icon: "divider", keywords: "hr line separator", hint: "---" },
  // BSD-407 Teil 3: Tabelle im gemeinsamen Format (Zeilen als `tableRow`-Blöcke, Kern insertTable)
  { type: "table", label: "Simple table", group: "Basic blocks", icon: "table", keywords: "grid cells rows columns", create: (store, after, replace) => {
    const f = blockCommands.insertTable(store, after, replace);
    return f && "blockId" in f ? f.blockId : undefined;
  } },
  ...[2, 3, 4, 5].map((n): SlashItem => ({ type: "columnList", label: `${n} columns`, group: "Advanced", icon: "columns", keywords: `columns layout side ${n}`, columns: n })),
  { type: "page", label: "Page", group: "Pages", icon: "page", keywords: "subpage new page", page: subPage },
  { type: "databaseInline", label: "Database", group: "Pages", icon: "database", keywords: "table inline database grid", create: (store, after, replace) => {
    const a = store.blocks.get(after);
    if (!a) return undefined;
    const r = createDatabase(store, { parent: a.parent, inline: true, position: { after } });
    if (replace) store.transact("Remove empty block", (tx) => tx.remove(`block:${after}`), { coalesce: "db:" + r.blockID });
    return r.blockID;
  } },
  { type: "databaseInline", label: "Linked view of database", group: "Pages", icon: "linkedDatabase", keywords: "linked database view existing", linkDatabase: true },
  { type: "image", label: "Image", group: "Media", icon: "image", keywords: "picture photo upload" },
  { type: "video", label: "Video", group: "Media", icon: "video", keywords: "movie clip upload" },
  { type: "audio", label: "Audio", group: "Media", icon: "audio", keywords: "sound music recording" },
  { type: "file", label: "File", group: "Media", icon: "file", keywords: "attachment upload document" },
  { type: "bookmark", label: "Web bookmark", group: "Media", icon: "bookmark", keywords: "link url preview" },
  { type: "embed", label: "Embed", group: "Media", icon: "embed", keywords: "iframe link url" },
  { type: "equation", label: "Block equation", group: "Advanced", icon: "equation", keywords: "math latex tex formula", props: { expression: "" } },
  { type: "inlineEquation", label: "Inline equation", group: "Advanced", icon: "inlineEquation", keywords: "math latex tex formula inline", inline: "equation" },
  // BSD-407 Teil 3: wie im alten Editor eigene Einträge für Codeblöcke mit Vorschau
  { type: "code", label: "Mermaid diagram", group: "Advanced", icon: "mermaid", keywords: "diagram flowchart chart graph", props: { language: "mermaid" } },
  { type: "code", label: "HTML", group: "Advanced", icon: "html", keywords: "html web preview markup", props: { language: "html" } },
  // BSD-407 Teil 5: Meeting wie im alten Editor (gleiche Records); die Schreibmarke kommt in die erste Notiz
  { type: "meeting", label: "Meeting notes", group: "Advanced", icon: "meeting", keywords: "meet meeting transcribe record notes", caret: true,
    create: (store, after, replace) => insertMeetingAfter(store, after, { replace })?.noteID },
  { type: "tableOfContents", label: "Table of contents", group: "Advanced", icon: "tableOfContents", keywords: "toc outline headings" },
  // BSD-407 Teil 6.5: Button (Schritte wie im alten Editor); die Einrichtung geht nach dem Anlegen auf
  { type: "button", label: "Button", group: "Advanced", icon: "button", keywords: "button action automation", setup: true },
];

/** „Ask AI“ steht nur im Menü, wenn die Hülle AI anbietet (AI-Schalter an). */
export const ASK_AI_ITEM: SlashItem = { type: "ai", label: "Ask AI", group: "AI", icon: "askAI", keywords: "ai write assistant generate", ai: true };

/** Einträge passend zur Eingabe nach „/“ (Anfang von Name oder Suchwort). */
export function filterSlash(items: readonly SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((it) => it.label.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || it.label.toLowerCase().startsWith(q)
    || it.keywords.split(/\s+/).some((w) => w.startsWith(q)) || it.type.toLowerCase().startsWith(q));
}
