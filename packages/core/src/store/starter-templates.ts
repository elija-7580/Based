// BSD-436 (Mac-Beta): Startvorlagen beim ersten Start – Aufgaben, Notizen, Journal, Wiki. Elija 16.11.: drei bis vier
// Vorlagen als dritter Weg im Willkommensbildschirm neben Notion-Import und leerem Start, ohne AI. Jede Vorlage ist
// eine kleine, sofort nutzbare Seite bzw. Datenbank oben unter Private, aus den gewöhnlichen Store-Operationen gebaut
// (damit gilt sie in beiden Datenformaten, BSD-30). Texte englisch und kurz; nichts davon braucht einen Server.
import type { Block, PropertyValue } from "../model/records.js";
import { keysBetween } from "../sortkeys.js";
import { addOption, addProperty, addRow, addView, createDatabase, pv as v, setGroupHidden } from "./database-ops.js";
import { createPage } from "./pages.js";
import type { WorkspaceStore } from "./store.js";

export type StarterTemplateID = "tasks" | "notes" | "journal" | "wiki";

export interface StarterTemplate {
  readonly id: StarterTemplateID;
  readonly title: string;
  readonly description: string;
  /** Symbolname (apps/web icons.tsx), kein Emoji. */
  readonly icon: string;
}

export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  { id: "tasks", title: "Tasks", description: "A board from Not started to Done.", icon: "check" },
  { id: "notes", title: "Notes", description: "A list of notes with tags.", icon: "edit" },
  { id: "journal", title: "Journal", description: "One entry per day, on a calendar.", icon: "calendar" },
  { id: "wiki", title: "Wiki", description: "Pages for how things work.", icon: "outline" },
];

type Line = readonly [type: string, text: string];

/** Blöcke unter eine Seite oder Zeile hängen (am Ende, eine Transaktion). */
function addLines(store: WorkspaceStore, pageID: string, lines: readonly Line[]) {
  if (lines.length === 0) return;
  const existing = store.children("b:" + pageID);
  const last = existing.length ? store.blocks.get(existing[existing.length - 1]!)?.sk : undefined;
  const keys = keysBetween(lines.length, last, undefined);
  store.transact("Template", (tx) => {
    const now = store.now();
    lines.forEach(([type, text], i) => {
      const b: Block = { id: crypto.randomUUID().toUpperCase(), type, parent: "b:" + pageID, sk: keys[i]!, text, createdAt: now, updatedAt: now };
      tx.put({ kind: "block", data: b });
    });
  }, { undoable: false });
}

const optionID = (store: WorkspaceStore, db: string, prop: string, name: string) =>
  store.databases.get(db)?.properties.find((p) => p.id === prop)?.options?.find((o) => o.name === name)?.id;
const DAY = 86_400;

function tasks(store: WorkspaceStore): string {
  const made = createDatabase(store, { parent: "w", title: "Tasks", viewType: "board", sampleRows: 0, undoable: false });
  const db = made.databaseID;
  const status = store.databases.get(db)!.properties.find((p) => p.type === "status")!.id;
  const due = addProperty(store, db, "Due", "date")!;
  const priority = addProperty(store, db, "Priority", "select")!;
  for (const [name, color] of [["High", "red"], ["Medium", "yellow"], ["Low", "gray"]] as const) addOption(store, db, priority, name, color);
  // Jede Aufgabe hat einen Status: die leere Spalte „No Status“ bleibt zu (sonst passt Done bei 1280 nicht mehr hin).
  setGroupHidden(store, made.viewID, "", true);
  addView(store, made.blockID, "table", "All tasks");
  const today = Math.floor(store.now() / DAY) * DAY;
  const rows: [string, string, string, number | undefined][] = [
    ["Try Based for a day", "In progress", "High", today],
    ["Move one list from Notion", "Not started", "Medium", today + 2 * DAY],
    ["Drag a card to Done", "Not started", "Low", undefined],
    ["Open Based", "Done", "Low", undefined],
  ];
  for (const [title, s, p, d] of rows) {
    const values: Record<string, PropertyValue> = {};
    const sid = optionID(store, db, status, s), pid = optionID(store, db, priority, p);
    if (sid) values[status] = v("status", sid);
    if (pid) values[priority] = v("select", pid);
    if (d !== undefined) values[due] = v("date", { start: d, includeTime: false });
    addRow(store, db, { title, values });
  }
  return made.blockID;
}

function notes(store: WorkspaceStore): string {
  const made = createDatabase(store, { parent: "w", title: "Notes", viewType: "list", sampleRows: 0, undoable: false });
  const db = made.databaseID;
  const tags = store.databases.get(db)!.properties.find((p) => p.type === "multiSelect")!.id;
  for (const [name, color] of [["Idea", "yellow"], ["Reference", "blue"], ["Meeting", "green"]] as const) addOption(store, db, tags, name, color);
  addView(store, made.blockID, "table", "Table");
  const rows: [string, string, Line[]][] = [
    ["How to use this list", "Reference", [["text", "Every note is a page. Click one to write inside it."], ["bulletedList", "Tag notes to find them again."], ["bulletedList", "Switch to Table to sort and filter."]]],
    ["First idea", "Idea", [["text", "Write anything here."]]],
  ];
  for (const [title, tag, lines] of rows) {
    const id = optionID(store, db, tags, tag);
    const row = addRow(store, db, { title, values: id ? { [tags]: v("multiSelect", [id]) } : {} });
    if (row) addLines(store, row, lines);
  }
  return made.blockID;
}

function journal(store: WorkspaceStore): string {
  const made = createDatabase(store, { parent: "w", title: "Journal", viewType: "calendar", sampleRows: 0, undoable: false });
  const db = made.databaseID;
  const date = store.databases.get(db)!.properties.find((p) => p.type === "date")!.id;
  addView(store, made.blockID, "list", "Entries");
  const today = Math.floor(store.now() / DAY) * DAY;
  const row = addRow(store, db, { title: "Today", values: { [date]: v("date", { start: today, includeTime: false }) } });
  if (row) addLines(store, row, [["heading2", "What happened"], ["text", ""], ["heading2", "What I want to remember"], ["text", ""]]);
  return made.blockID;
}

function wiki(store: WorkspaceStore): string {
  const root = createPage(store, { title: "Wiki" });
  addLines(store, root, [["text", "A home for how things work. Add a page for each topic and link pages with @."]]);
  const pages: [string, Line[]][] = [
    ["Getting started", [["text", "What someone new should read first."], ["todo", "Write the first three steps"]]],
    ["How we work", [["text", "Habits, tools and agreements."]]],
    ["Glossary", [["text", "Words that mean something special here."]]],
  ];
  for (const [title, lines] of pages) {
    const id = createPage(store, { parent: root, title });
    addLines(store, id, lines);
  }
  return root;
}

/** Legt die Vorlage oben unter Private an und gibt die ID der Seite bzw. Datenbankseite zurück. */
export function addStarterTemplate(store: WorkspaceStore, id: StarterTemplateID): string | undefined {
  if (store.isReadOnly) return undefined;
  switch (id) {
    case "tasks": return tasks(store);
    case "notes": return notes(store);
    case "journal": return journal(store);
    case "wiki": return wiki(store);
    default: return undefined;
  }
}
