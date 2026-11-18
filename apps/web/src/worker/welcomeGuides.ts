// BSD-275 (Mac-Beta, erster Start ohne Konto): kurze Willkommensseiten unter „Welcome to Based“. Sie entstehen erst,
// wenn jemand auf dem Willkommensbildschirm wählt (leer starten oder aus Notion importieren), nicht beim Anlegen des
// Workspace – so bleibt der frische Workspace für Tests und Sync derselbe wie vorher. Texte englisch, kurz, ohne
// Gedankenstriche (Plan im Backlog-Eintrag).
import { insertPage, keysBetween, type Block, type WorkspaceStore } from "@based/core";
import { AI_OPTION } from "../shell/ai.js";

type Line = readonly [type: string, text: string];

export interface WelcomeGuide {
  readonly title: string;
  readonly lines: readonly Line[];
}

/** Satz über AI in „Your data“ – nur in Builds, die AI anbieten (auf beta gibt es keinen Schalter dafür). */
const AI_LINE: Line = ["bulletedList", "AI is off. Agents only run after you turn them on in Settings and choose a model."];

/** Die Anleitungsseiten für einen Build; `aiOption` = darf der Build AI anbieten (BSD-305 Teil 5: nicht auf beta). */
export function welcomeGuides(aiOption: boolean = AI_OPTION): readonly WelcomeGuide[] {
  return GUIDES.map((g) => (aiOption ? g : { ...g, lines: g.lines.filter((l) => l !== AI_LINE) }));
}

const GUIDES: readonly WelcomeGuide[] = [
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
      ["text", "Importing a Notion export keeps your databases and their properties. Connect Notion directly to bring the views too."],
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
      AI_LINE,
    ],
  },
];

/**
 * BSD-552 (Mac-Beta, Einstieg 2): „Everything in Based“ – alle Funktionen der Beta, eine Zeile je Funktion. Jede Zeile
 * nennt die Zeile in replica/features.csv, aus der sie kommt (Spalte `feature`); welcomeGuides.test.ts prüft, dass
 * jede davon `beta = beta` und `ts = yes|partial` hat. Nichts, was auf beta ausgeblendet ist (AI, Graph, Coding,
 * Echtzeit, Teilen, Whiteboard).
 */
export interface FeatureLine {
  /** Name der Zeile in replica/features.csv */
  readonly feature: string;
  readonly text: string;
}

export const EVERYTHING_TITLE = "Everything in Based";

export const EVERYTHING_GROUPS: readonly { readonly heading: string; readonly items: readonly FeatureLine[] }[] = [
  {
    heading: "Pages and writing",
    items: [
      { feature: "Slash command menu with search", text: "Type / in an empty line for any block: headings, lists, to-dos, toggles, callouts, code, tables, images and more." },
      { feature: "Markdown block shortcuts (# - * + 1. [] > ``` ---)", text: "Markdown works as you type: # for a heading, - for a list, [] for a to-do, > for a quote." },
      { feature: "Nested subpages (page inside page)", text: "Pages hold other pages, as deep as you like." },
      { feature: "Columns (2-5)", text: "Drag a block next to another to make columns." },
      { feature: "Turn into (any block type)", text: "Turn any block into another type from the block menu (⌘/)." },
      { feature: "Undo / redo for text and structure", text: "⌘Z undoes typing, moves and deletes." },
      { feature: "Page mention (@ / [[)", text: "Type @ to link a page or a date. Backlinks show where a page is mentioned." },
      { feature: "Page icon (emoji)", text: "Give pages an icon, a cover, a font and full width." },
      { feature: "Synced block", text: "Synced blocks show the same content in several places." },
      { feature: "Find in page", text: "⌘F finds text on the page." },
    ],
  },
  {
    heading: "Databases",
    items: [
      { feature: "Database full page", text: "Create a database with ⌘N, as a full page or inside a page." },
      { feature: "Multiple views per database", text: "See the same rows as a table, board, list, gallery, calendar, timeline or chart." },
      { feature: "Filters (and/or groups)", text: "Filter, sort and group each view on its own." },
      { feature: "Property: formula (Formula 2.0)", text: "Properties for text, numbers, dates, select, status, people, files, formulas, relations and rollups." },
      { feature: "Row opens as page (side peek / center / full)", text: "Every row is a page. Open it at the side, in the center or full screen." },
      { feature: "Database templates", text: "Templates fill new rows for you." },
      { feature: "Large database performance (50k rows)", text: "Tens of thousands of rows stay fast." },
    ],
  },
  {
    heading: "Search and navigation",
    items: [
      { feature: "Quick Find search (titles + content)", text: "⌘K searches titles and text of every page, with recent pages first." },
      { feature: "Tabs (Mac)", text: "Open pages in tabs (⌘T, ⌘W) or in a new window." },
      { feature: "Favorites", text: "Star pages to keep them at the top of the sidebar." },
      { feature: "Back / forward history", text: "⌘[ and ⌘] go back and forward." },
      { feature: "Choose Home page", text: "Pick any page as Home." },
    ],
  },
  {
    heading: "Import and export",
    items: [
      { feature: "Import Notion export (Markdown & CSV)", text: "Bring your Notion export over with pages, databases and relations. Connect Notion directly to bring the views too." },
      { feature: "Import Markdown files", text: "Import Markdown, HTML, CSV, Word, Obsidian, Logseq, Bear and Evernote." },
      { feature: "Export page as Markdown", text: "Export a page or the whole workspace as Markdown, HTML, PDF or Word." },
      { feature: "Lossless workspace archive export/import", text: "A Based archive keeps everything and imports back one to one." },
    ],
  },
  {
    heading: "Your data",
    items: [
      { feature: "Offline editing", text: "Everything works offline. Your workspace is a file on this Mac." },
      { feature: "Automatic local backups + one-click restore", text: "Backups every hour, when you quit and before updates. Restore one in Settings." },
      { feature: "Page history / versions", text: "Every page keeps its versions. Open the history to restore an older one." },
      { feature: "Trash with restore and delete forever", text: "Deleted pages wait in the Trash until you empty it." },
    ],
  },
  {
    heading: "Meeting notes",
    items: [
      { feature: "Meeting notes (/meet): recording and on-device transcript", text: "Type /meet to record a meeting. The transcript is made on this Mac." },
    ],
  },
  {
    heading: "The Mac app",
    items: [
      { feature: "Dark mode (system + toggle)", text: "Light, dark or the system setting. ⇧⌘L switches." },
      { feature: "Keyboard shortcuts: ⌘N ⌘P ⌘\\ ⌘[ ⌘] ⇧⌘L", text: "Hold ⌘ to see the shortcuts for where you are. ⇧⌘/ shows all of them." },
      { feature: "Diagnostics: logs, hang watchdog, crash report, layout audit", text: "⇧⌘B saves a report of what just happened, to send to hello@basednotes.app." },
    ],
  },
];

/** Am Ende der Seite: was die Beta noch nicht kann (Entscheidung Elija 18.11.). */
export const NOT_IN_BETA: readonly string[] = ["AI and agents", "The iPhone app", "Sync through a server for everyone", "Sharing pages with other people"];

const EVERYTHING: WelcomeGuide = {
  title: EVERYTHING_TITLE,
  lines: [
    ["text", "What you can do in this beta, one line each. Skim it now and come back when you need it."],
    ...EVERYTHING_GROUPS.flatMap((g): Line[] => [["heading2", g.heading], ...g.items.map((it): Line => ["bulletedList", it.text])]),
    ["heading2", "Not in this beta yet"],
    ...NOT_IN_BETA.map((t): Line => ["bulletedList", t]),
  ],
};

export const WELCOME_GUIDES: readonly WelcomeGuide[] = [...welcomeGuides(), EVERYTHING];

/**
 * Legt die Willkommensseiten unter `parentID` an (am Ende, in fester Reihenfolge) und gibt ihre IDs zurück.
 * Idempotent: Seiten mit demselben Titel unter `parentID` werden nicht noch einmal angelegt (zweiter Klick,
 * zweites Fenster). Ohne gültige Elternseite passiert nichts.
 */
export function addWelcomeGuides(store: WorkspaceStore, parentID: string): string[] {
  const parent = store.blocks.get(parentID);
  if (!parent || parent.type !== "page" || store.isReadOnly) return [];
  const existing = new Set<string>();
  for (const b of store.skeletonBlocks()) if (b.parent === "b:" + parentID && b.type === "page" && typeof b.text === "string") existing.add(b.text);
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
