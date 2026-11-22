// BSD-275 (Mac-Beta, erster Start ohne Konto): kurze Willkommensseiten unter „Welcome to Based“. Sie entstehen erst,
// wenn jemand auf dem Willkommensbildschirm wählt (leer starten oder aus Notion importieren), nicht beim Anlegen des
// Workspace – so bleibt der frische Workspace für Tests und Sync derselbe wie vorher. Texte englisch, kurz, ohne
// Gedankenstriche (Plan im Backlog-Eintrag).
// BSD-552: fünfte Seite „Everything in Based“ – alle Funktionen der Beta, gruppiert. Jede Zeile nennt die Zeilen aus
// replica/features.csv, die sie abdeckt (welcomeGuides.test.ts prüft: nur Zeilen mit beta = beta, und jede solche
// Zeile ist abgedeckt). Auf beta ohne ausgeblendete Funktionen (shell/beta.ts) und ohne AI.
import { insertPage, keysBetween, type Block, type WorkspaceStore } from "@based/core";
import { AI_OPTION } from "../shell/ai.js";
import { CHANNEL, featureVisible, type Channel, type GatedFeature } from "../shell/beta.js";

type Line = readonly [type: string, text: string];

export interface WelcomeGuide {
  readonly title: string;
  readonly lines: readonly Line[];
}

/** Satz über AI in „Your data“ – nur in Builds, die AI anbieten (auf beta gibt es keinen Schalter dafür). */
const AI_LINE: Line = ["bulletedList", "AI is off. Agents only run after you turn them on in Settings and choose a model."];

/** Die Anleitungsseiten für einen Build; `aiOption` = darf der Build AI anbieten (BSD-305 Teil 5: nicht auf beta). */
export function welcomeGuides(aiOption: boolean = AI_OPTION, channel: Channel = CHANNEL): readonly WelcomeGuide[] {
  return [...GUIDES.map((g) => (aiOption ? g : { ...g, lines: g.lines.filter((l) => l !== AI_LINE) })), everythingGuide(channel)];
}

/** Eine Zeile der Seite „Everything in Based“ mit den Zeilen aus features.csv, die sie abdeckt. */
export interface FeatureLine {
  readonly text: string;
  readonly rows: readonly string[];
}

export interface FeatureGroup {
  readonly title: string;
  /** Gruppe nur, wenn die Funktion in diesem Kanal sichtbar ist */
  readonly feature?: GatedFeature;
  readonly lines: readonly FeatureLine[];
}

/** BSD-552: alle Funktionen der Beta, gruppiert. Kurz halten: die Seite soll sich in unter drei Minuten lesen. */
export const EVERYTHING: readonly FeatureGroup[] = [
  {
    title: "Pages and writing",
    lines: [
      { text: "Pages and subpages. Create, nest, move, duplicate and lock them.", rows: ["Create / rename / delete pages", "Nested subpages (page inside page)", "Move page to another page", "Duplicate page", "Lock page", "Child page block in content"] },
      { text: "Icons, covers, fonts, small text and full width for each page.", rows: ["Page icon (emoji)", "Page icon (uploaded image)", "Page cover (gallery / color / gradient)", "Page cover (upload / link / reposition)", "Page font (default / serif / mono)", "Small text", "Full width", "Emoji picker with search"] },
      { text: "Text, headings, lists, to-dos, toggles, quotes, callouts, dividers, columns, tables and a table of contents.", rows: ["Text block", "Heading 1/2/3", "Heading 4", "Bulleted list", "Numbered list (1. a. i. by depth)", "To-do list", "Toggle list", "Toggle headings", "Quote", "Callout with icon and color", "Divider", "Columns (2-5)", "Simple table block", "Table of contents", "Breadcrumb block", "Placeholders per block type"] },
      { text: "Code with syntax highlighting, equations, and HTML or Mermaid with a live preview.", rows: ["Code block with language + syntax highlight", "Block equation (KaTeX)", "Inline equation", "HTML / Mermaid block preview"] },
      { text: "Images, video, audio, PDFs, files, bookmarks and embeds like YouTube or Figma.", rows: ["Image block (upload / link) with caption", "Video / audio blocks", "File block", "PDF block", "Web bookmark with preview", "Embed (web)"] },
      { text: "Synced blocks that show the same content on several pages, and buttons that run steps.", rows: ["Synced block", "Button block"] },
      { text: "Type / for any block. Markdown like # or - works as you type.", rows: ["Slash command menu with search", "Markdown block shortcuts (# - * + 1. [] > ``` ---)", "Inline Markdown (** * ` ~)", "Enter splits block / continues lists", "Backspace at start merges / turns into text", "Tab / Shift-Tab indent and outdent", "Arrow keys move between blocks", "Soft line break (Shift-Enter)"] },
      { text: "Select text for bold, italic, colors and links.", rows: ["Bold / italic / underline / strikethrough / code", "Links in text (⌘K)", "Text color and background color", "Block color", "Formatting toolbar over selection"] },
      { text: "Drag the handle to move blocks or make columns. Esc selects blocks, ⇧⌘↑ and ⇧⌘↓ move them, ⌘D duplicates.", rows: ["Drag handle to reorder blocks", "Drag to nest / create columns", "Multi-block selection (Esc / shift)", "Move block up/down (⌘⇧↑↓)", "Duplicate block (⌘D)", "Block action menu (delete / duplicate / move / color)", "Turn into (any block type)", "Turn into page", "Turn-into shortcuts (⌘⌥0-9)", "Expand / collapse all toggles (⌘⌥T)"] },
      { text: "Undo and redo everything with ⌘Z and ⇧⌘Z.", rows: ["Undo / redo for text and structure"] },
      { text: "Paste Markdown, web pages and links. Copy blocks as Markdown.", rows: ["Paste Markdown / multi-line as blocks", "Paste URL as bookmark / mention / link", "Copy blocks as Markdown"] },
      { text: "Link pages with @ or [[. Backlinks show at the end of each page.", rows: ["Page mention (@ / [[)", "Backlinks", "Link to page block", "Copy link to block / page (deep link)"] },
      { text: "Dates in text, like @today or @friday.", rows: ["Date mention", "Reminders on date mentions"] },
      { text: "Find in page with ⌘F, word count in the ••• menu, and an outline on the right.", rows: ["Find in page", "Word / character count", "Floating page outline (right rail)"] },
    ],
  },
  {
    title: "Databases",
    lines: [
      { text: "Databases on a page or as a full page, and linked views of other databases.", rows: ["Database inline", "Database full page", "Linked database view"] },
      { text: "Views: table, board, list, gallery, calendar, timeline, chart, form, map and dashboard.", rows: ["Table view", "Board view (group by select/status)", "List view", "Gallery view with card preview", "Calendar view", "Timeline view", "Chart view", "Chart view (bar/line/area/pie/donut)", "Form view", "Feed / map views", "Map view", "Dashboard view (widgets from several databases)", "Number chart + caption / color theme / height", "Multiple views per database"] },
      { text: "Filters, sorts, groups and calculations for each view.", rows: ["Filters (and/or groups)", "Sorts (multi-key)", "Group by / hide empty groups", "Column calculations", "Property visibility and order per view"] },
      { text: "Properties: text, numbers, select, status, dates, people, files, formulas, relations, rollups and more.", rows: ["Property: title / text / number", "Property: select / multi-select", "Property: status", "Property: date (range / time)", "Property: checkbox", "Property: url / email / phone", "Property: person", "Property: files & media", "Property: created / edited time and by", "Property: unique ID", "Property: formula (Formula 2.0)", "Property: relation", "Property: rollup", "Property: button", "Property: place / verification", "Place property (name / address / coordinates)", "Number formats", "Change property type with value conversion"] },
      { text: "Every row is a page. Open it on the side, in the center or full size, and step through rows with ⌃⇧↑ and ⌃⇧↓.", rows: ["Row opens as page (side peek / center / full)", "Peek navigation (prev/next row)"] },
      { text: "Templates for new rows, and actions on many rows at once.", rows: ["Database templates", "Database row multi-select & bulk actions"] },
      { text: "Large databases stay fast, even with 100,000 rows.", rows: ["Large database performance (50k rows)"] },
    ],
  },
  {
    title: "Search and navigation",
    lines: [
      { text: "⌘K finds pages by title and text, shows recent pages and runs commands.", rows: ["Quick Find search (titles + content)", "Recent pages in search", "Search filters (created by / date / in page)"] },
      { text: "Sidebar with favorites. Drag pages to sort or nest them, or select several to act on them together.", rows: ["Favorites", "Sidebar page tree with expand/collapse", "Drag and drop pages in sidebar", "Sidebar: hover chevron / ••• / +; drag to reorder or nest; resize; ⌘\\ collapse + hover peek", "Sidebar multi-select & bulk actions"] },
      { text: "Tabs with ⌘T and ⌘W, and pages in their own window.", rows: ["Tabs (Mac)", "Open page in new window (Mac)", "Notion-style window chrome (tabs in title bar)"] },
      { text: "Go back and forward with ⌘[ and ⌘], the mouse buttons or a swipe.", rows: ["Back / forward history", "Back/forward with mouse buttons & swipe", "Breadcrumbs", "Page top bar: breadcrumb / Edited / Share / AI / favorite / •••"] },
      { text: "⌘N for a new page, database or import. Hold ⌘ to see the shortcuts.", rows: ["Command palette (⌘N new…)", "Keyboard shortcuts: ⌘N ⌘P ⌘\\ ⌘[ ⌘] ⇧⌘L"] },
      { text: "Choose which page Home opens.", rows: ["Choose Home page"] },
    ],
  },
  {
    title: "Import and export",
    lines: [
      { text: "Import from Notion: pick a Notion export, or connect Notion directly to bring views, formulas and files too. Importing again updates pages in place.", rows: ["Import Notion export (Markdown & CSV)", "Import from Notion API (live)", "Notion import keeps views (filters, sorts, group by, layout)", "Notion formulas imported live", "Copy Notion-hosted files on import", "Re-import from Notion updates in place", "Import diagnostic report"] },
      { text: "Import Markdown, HTML, CSV, Obsidian, Logseq, Bear, Evernote, Word, OPML and JSON.", rows: ["Import Markdown files", "Import HTML export", "Import Obsidian vault", "Import Logseq graph", "Import Bear export (TextBundle / Markdown)", "Import Evernote (.enex)", "OPML import and export", "Import Word (.docx)", "Import JSON / JSON Lines", "Import CSV from Excel (semicolon, Windows-1252)"] },
      { text: "Export a page or the whole workspace as Markdown, HTML, PDF, Word or OPML.", rows: ["Export page as Markdown", "Export as HTML / PDF", "Export page as Word (.docx)", "Export all workspace content", "Export Markdown with front matter and page JSON"] },
      { text: "A Based archive keeps everything and imports back exactly as it was.", rows: ["Lossless workspace archive export/import"] },
    ],
  },
  {
    title: "Your data",
    lines: [
      { text: "No account. Everything works offline and is saved as you type. If something can’t be saved, the sidebar says so.", rows: ["First start without account (welcome)", "Offline editing", "Visible save errors (no silent in-memory fallback)"] },
      { text: "Page history: see and restore earlier versions of a page.", rows: ["Page history / versions"] },
      { text: "Trash: deleted pages wait there until you restore them or delete them for good.", rows: ["Trash with restore and delete forever"] },
      { text: "Backups every hour with the local server (Settings → Sync & server), and a full copy before every update.", rows: ["Automatic local backups + one-click restore"] },
    ],
  },
  {
    title: "Meeting notes",
    feature: "meetings",
    lines: [
      { text: "Type /meet to record a meeting, take notes with timestamps and get a transcript made on this Mac.", rows: ["Meeting notes (/meet): recording and on-device transcript"] },
    ],
  },
  {
    title: "The app",
    lines: [
      { text: "Light, dark or the same as your Mac. ⇧⌘L switches.", rows: ["Dark mode (system + toggle)"] },
      { text: "Settings with ⌘, for appearance, Home, writing, sync, import, export and updates.", rows: ["Settings", "Notion-style settings (account/workspace)"] },
      { text: "Updates install when you say so and keep your data.", rows: ["Schema version + migrations for based.sqlite"] },
      { text: "Something wrong? ⇧⌘B sends us a report with diagnostics, without your page text.", rows: ["Diagnostics: logs, hang watchdog, crash report, layout audit", "Copy logs (diagnostic report to clipboard)", "Hang stack sampling (where the main thread is stuck)"] },
    ],
  },
];

/** Beta-Zeilen in features.csv, die keine Funktion für Tester sind (nicht auf der Seite). */
export const EVERYTHING_INTERNAL: readonly string[] = ["CI build on every push"];

/** Was auf beta noch fehlt (nur auf beta; ohne AI, BSD-551/552). */
const NOT_YET: readonly string[] = [
  "The iPhone and iPad app.",
  "Sharing pages with other people.",
  "Sync for everyone through a Based server. Between your own Macs, an iCloud Drive folder works now.",
];

/** BSD-552: die Seite „Everything in Based“ für einen Kanal. */
export function everythingGuide(channel: Channel = CHANNEL): WelcomeGuide {
  const lines: Line[] = [["text", "Everything this version of Based can do, in one list."]];
  for (const g of EVERYTHING) {
    if (g.feature && !featureVisible(g.feature, channel)) continue;
    lines.push(["heading2", g.title]);
    for (const l of g.lines) lines.push(["bulletedList", l.text]);
  }
  if (channel === "beta") {
    lines.push(["heading2", "Not in this beta yet"]);
    for (const t of NOT_YET) lines.push(["bulletedList", t]);
  }
  return { title: "Everything in Based", lines };
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

export const WELCOME_GUIDES: readonly WelcomeGuide[] = welcomeGuides();

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
