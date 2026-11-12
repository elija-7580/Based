// BSD-275 (Mac-Beta, erster Start ohne Konto): kurze Willkommensseiten unter „Welcome to Based“. Sie entstehen erst,
// wenn jemand auf dem Willkommensbildschirm wählt (leer starten oder aus Notion importieren), nicht beim Anlegen des
// Workspace – so bleibt der frische Workspace für Tests und Sync derselbe wie vorher. Texte englisch, kurz, ohne
// Gedankenstriche (Plan im Backlog-Eintrag).
import { insertPage, keysBetween, type Block, type WorkspaceStore } from "@based/core";

type Line = readonly [type: string, text: string];

export interface WelcomeGuide {
  readonly title: string;
  readonly lines: readonly Line[];
}

export const WELCOME_GUIDES: readonly WelcomeGuide[] = [
  {
    title: "Basics",
    lines: [
      ["text", "Everything in Based is a page. Pages hold text, lists, tasks, images and other pages."],
      ["heading2", "Write"],
      ["bulletedList", "Type / in an empty line to add a heading, a list, a to-do or a database."],
      ["bulletedList", "Select text to format it or to turn it into a link."],
      ["bulletedList", "Drag the handle next to a block to move it."],
      ["heading2", "Organize"],
      ["bulletedList", "Nest pages by dragging them onto each other in the sidebar."],
      ["bulletedList", "Right-click a page in the sidebar to rename, move or set it as Home."],
      ["bulletedList", "Deleted pages wait in the Trash until you empty it."],
    ],
  },
  {
    title: "Databases",
    lines: [
      ["text", "A database is a collection of pages with properties, like a task list, a reading list or a CRM."],
      ["bulletedList", "Create one with ⌘N, then choose Database."],
      ["bulletedList", "Every row is a page. Open it to write notes inside."],
      ["bulletedList", "Add views to see the same rows as a table, a board, a list or a calendar."],
      ["bulletedList", "Filter and sort per view. Your other views stay as they are."],
      ["text", "Importing from Notion keeps your databases, their properties and their views."],
    ],
  },
  {
    title: "Keyboard",
    lines: [
      ["text", "Most things work without the mouse. Hold ⌘ for a moment to see the shortcuts on screen. On Windows and Linux, use Ctrl instead of ⌘."],
      ["bulletedList", "⌘K finds any page."],
      ["bulletedList", "⌘N opens New: page, database, import."],
      ["bulletedList", "⌥⌘N creates a page right away."],
      ["bulletedList", "⌘[ and ⌘] go back and forward."],
      ["bulletedList", "⌘T and ⌘W open and close tabs."],
      ["bulletedList", "⌘, opens Settings."],
    ],
  },
  {
    title: "Your data",
    lines: [
      ["text", "Based works without an account. Your workspace lives in a file on this Mac and nothing leaves it unless you ask."],
      ["bulletedList", "Export a page or the whole workspace as Markdown, HTML or a Based archive at any time."],
      ["bulletedList", "Connect your own sync server in Settings to use the same workspace on other devices."],
      ["bulletedList", "AI is off. Agents only run after you turn them on in Settings and choose a model."],
    ],
  },
];

/**
 * Legt die Willkommensseiten unter `parentID` an (am Ende, in fester Reihenfolge) und gibt ihre IDs zurück.
 * Idempotent: Seiten mit demselben Titel unter `parentID` werden nicht noch einmal angelegt (zweiter Klick,
 * zweites Fenster). Ohne gültige Elternseite passiert nichts.
 */
export function addWelcomeGuides(store: WorkspaceStore, parentID: string): string[] {
  const parent = store.blocks.get(parentID);
  if (!parent || parent.type !== "page" || store.isReadOnly) return [];
  const existing = new Set<string>();
  for (const b of store.blocks.values()) if (b.parent === "b:" + parentID && b.type === "page" && typeof b.text === "string") existing.add(b.text);
  const missing = WELCOME_GUIDES.filter((g) => !existing.has(g.title));
  if (missing.length === 0) return [];
  // je Seite eine Transaktion: die Sortierschlüssel „am Ende“ sehen so die gerade angelegte Schwester
  return missing.map((g) => store.transact("Welcome guides", (tx) => {
    const id = insertPage(store, tx, { parent: parentID, title: g.title });
    const keys = keysBetween(g.lines.length, undefined, undefined);
    const now = store.now();
    g.lines.forEach(([type, text], i) => {
      const b: Block = { id: crypto.randomUUID().toUpperCase(), type, parent: "b:" + id, sk: keys[i]!, text, createdAt: now, updatedAt: now };
      tx.put({ kind: "block", data: b });
    });
    return id;
  }, { undoable: false }));
}
