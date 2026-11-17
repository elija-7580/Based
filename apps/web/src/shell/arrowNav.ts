// Tastatur überall: Pfeiltasten bewegen den Fokus zwischen Bedienelementen (Knöpfe, Reiter, Listen, Einstellungen,
// Dialoge) – zum nächstgelegenen in Pfeilrichtung (packages/ui/src/spatial.ts). Die Seitenleiste ist eine einzige
// Liste von oben nach unten (Search, Home … Seitenbaum … Fußzeile); im Baum klappen ←/→ auf und zu bzw. springen zur
// Eltern-/ersten Unterseite. ⇧F10 öffnet das Kontextmenü des fokussierten Elements (WebKit kennt die Taste nicht).
//
// Greift nur, wenn sonst niemand die Taste genommen hat: Textfelder, der Editor, Tabellen (role=grid), Menüs und
// Karten behalten ihre eigenen Pfeiltasten. Abschalten für einen Bereich: `data-arrow-nav="off"`.
import { nextInDirection, type Direction } from "@based/ui";
import { focusRegion } from "./regions.js";

const DIRS: Record<string, Direction> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

/** Bereiche mit eigener Pfeilsteuerung – von dort aus bewegen wir den Fokus nicht. */
// `[data-row-id]`: Karten und Zeilen der Datenbank-Ansichten (Board, Liste, Galerie, Kalender, Zeitleiste) wandern
// mit packages/database-ui/src/cardKeys.ts untereinander und bleiben am Rand stehen.
const OWN_KEYS = "[role=grid], [role=application], [role=slider], [role=menu], [role=listbox], [data-row-id], [data-testid=block-editor], [data-arrow-nav=off], canvas";
/** Innerhalb dieser Flächen bleibt der Fokus (kein Sprung aus dem Dialog in die Seite dahinter). */
const SCOPES = "[role=dialog], [role=menu], [role=listbox], .dbui-popover, [popover], nav.sidebar, .topbar, .tabbar, .panel";
const TABBABLE = "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex='-1']), [contenteditable=true], [contenteditable=plaintext-only]";

function isText(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !["checkbox", "button", "submit", "reset", "file", "color"].includes(el.type);
  return (el as HTMLElement).isContentEditable;
}

function visible(el: HTMLElement): boolean {
  if (!el.getClientRects().length) return false;
  const cs = el.ownerDocument.defaultView!.getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.pointerEvents !== "none";
}

function focusTo(el: HTMLElement) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Nächstgelegenes Bedienelement in Pfeilrichtung, innerhalb derselben Fläche. */
function spatialTarget(active: HTMLElement, dir: Direction): HTMLElement | undefined {
  const doc = active.ownerDocument;
  const scope = active.closest<HTMLElement>(SCOPES) ?? doc.body;
  // In der Seitenleiste zählt jede Zeile des Seitenbaums (auch die, die Tab überspringt): von der Fußzeile nach oben
  // landet man auf der letzten Seite, nicht irgendwo weiter oben.
  const rows = scope.matches("nav.sidebar") ? [...scope.querySelectorAll<HTMLElement>("[role=tree] [role=treeitem]")].map(rowTarget).filter((t): t is HTMLElement => !!t) : [];
  const list = [...new Set([...scope.querySelectorAll<HTMLElement>(TABBABLE), ...rows])].filter((el) => el !== active && !active.contains(el) && visible(el));
  const i = nextInDirection(active.getBoundingClientRect(), list.map((el) => el.getBoundingClientRect()), dir);
  return i < 0 ? undefined : list[i];
}

// MARK: Seitenbaum

function rowOf(el: Element) { return el.closest<HTMLElement>("[role=treeitem]"); }
/** Wohin der Fokus in einer Zeile geht: die Zeile selbst (Seite, Teamspace) oder ihr Knopf (Abschnittskopf). */
function rowTarget(row: HTMLElement) { return row.hasAttribute("tabindex") ? row : row.querySelector<HTMLElement>("button:not([tabindex='-1'])"); }
/** Ebene für „zur Elternseite“: Abschnittsköpfe 0, sonst aria-level. */
const levelOf = (row: HTMLElement) => (row.classList.contains("tree-header") ? 0 : Number(row.getAttribute("aria-level") ?? 1));

function treeStep(tree: HTMLElement, row: HTMLElement, delta: 1 | -1, retry = true): boolean {
  const rows = [...tree.querySelectorAll<HTMLElement>("[role=treeitem]")];
  for (let i = rows.indexOf(row) + delta; i >= 0 && i < rows.length; i += delta) {
    const t = rowTarget(rows[i]!);
    if (t) { focusTo(t); return true; }
  }
  // Die Liste zeichnet nur die sichtbaren Zeilen: weiterrollen und noch einmal versuchen.
  const more = delta > 0 ? tree.scrollTop + tree.clientHeight < tree.scrollHeight - 1 : tree.scrollTop > 0;
  if (!more || !retry) return false;
  tree.scrollTop += delta * row.offsetHeight * 4;
  tree.ownerDocument.defaultView!.requestAnimationFrame(() => { if (row.isConnected) treeStep(tree, row, delta, false); });
  return true;
}

function treeEnd(tree: HTMLElement, end: "first" | "last") {
  tree.scrollTop = end === "first" ? 0 : tree.scrollHeight;
  tree.ownerDocument.defaultView!.requestAnimationFrame(() => {
    const rows = [...tree.querySelectorAll<HTMLElement>("[role=treeitem]")].map(rowTarget).filter((t): t is HTMLElement => !!t);
    const t = end === "first" ? rows[0] : rows[rows.length - 1];
    if (t) focusTo(t);
  });
}

interface Snapshot { el: Element | null; expanded: string | null }

/** Tasten im Seitenbaum. `before` ist der Zustand vor der Taste (die Zeile klappt bei ←/→ selbst auf und zu). */
function treeKey(e: KeyboardEvent, active: HTMLElement, tree: HTMLElement, before: Snapshot): boolean {
  const row = rowOf(active);
  if (!row) return false;
  const rows = [...tree.querySelectorAll<HTMLElement>("[role=treeitem]")];
  const isPage = row.hasAttribute("data-row");
  switch (e.key) {
    case "ArrowDown": return treeStep(tree, row, 1);
    case "ArrowUp": return treeStep(tree, row, -1);
    case "Home": treeEnd(tree, "first"); return true;
    case "End": treeEnd(tree, "last"); return true;
    case "ArrowRight": {
      if (before.expanded === "false") { if (!isPage) (row.querySelector<HTMLElement>(".tree-header-label") ?? row).click(); return true; }
      if (before.expanded === "true") {
        const next = rows[rows.indexOf(row) + 1];
        const t = next && levelOf(next) > levelOf(row) ? rowTarget(next) : undefined;
        if (t) focusTo(t);
      }
      return true;
    }
    case "ArrowLeft": {
      if (before.expanded === "true") { if (!isPage) (row.querySelector<HTMLElement>(".tree-header-label") ?? row).click(); return true; }
      for (let i = rows.indexOf(row) - 1; i >= 0; i--) {
        if (levelOf(rows[i]!) < levelOf(row)) { const t = rowTarget(rows[i]!); if (t) focusTo(t); break; }
      }
      return true;
    }
    case "Enter": case " ":
      // Teamspace-Zeile (kein Knopf): wie ein Klick
      if (active === row && !isPage && !e.shiftKey) { row.click(); return true; }
      return false;
    default: return false;
  }
}

/** ⇧F10: Kontextmenü am fokussierten Element (linke Hälfte, damit es an Zeilen neben dem Text aufgeht). */
function openContextMenu(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + Math.min(r.width / 2, 120)), y = Math.round(r.top + r.height / 2);
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
}

export function installArrowNav(win: Window = window): () => void {
  const doc = win.document;
  let before: Snapshot = { el: null, expanded: null };
  // Fokus nie verlieren: schließt ein Menü oder verschwindet das fokussierte Element, fällt der Fokus auf die Seite
  // selbst – die nächste Pfeil- oder Tab-Taste holt ihn dorthin zurück, wo er zuletzt war. Ein Mausklick ins Leere
  // gilt als Absicht und löscht das Gedächtnis.
  let trail: HTMLElement[] = [];
  const onFocus = (e: FocusEvent) => {
    const t = e.target;
    if (t instanceof HTMLElement && t !== doc.body) trail = [t, ...trail.filter((x) => x !== t)].slice(0, 6);
  };
  const onPointer = () => { trail = []; };
  const capture = (e: KeyboardEvent) => {
    if ((doc.activeElement === doc.body || !doc.activeElement) && (DIRS[e.key] || e.key === "Tab") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const back = trail.find((el) => el.isConnected && visible(el));
      if (back) {
        back.focus({ preventScroll: true });
        // Pfeil: erst zeigen, wo man ist. Tab: geht von dort normal weiter.
        if (DIRS[e.key]) { e.preventDefault(); before = { el: null, expanded: null }; return; }
      }
    }
    const a = doc.activeElement;
    before = { el: a, expanded: a ? (rowOf(a)?.getAttribute("aria-expanded") ?? null) : null };
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const active = doc.activeElement;
    if (!(active instanceof HTMLElement) || active === doc.body) return;
    // jemand anderes hat den Fokus mit dieser Taste schon bewegt
    if (active !== before.el) return;
    if (e.key === "F10" && e.shiftKey) { e.preventDefault(); openContextMenu(active); return; }
    if (isText(active) || active.closest("[data-arrow-nav=off]")) return;
    const sidebar = active.closest<HTMLElement>("nav.sidebar");
    if (sidebar && e.key === "Escape") { if (focusRegion(doc, "page")) e.preventDefault(); return; }
    const tree = active.closest<HTMLElement>("[role=tree]");
    if (sidebar && tree && treeKey(e, active, tree, before)) { e.preventDefault(); return; }
    const dir = DIRS[e.key];
    if (!dir || e.shiftKey) return;
    if (!sidebar && active.closest(OWN_KEYS)) return;
    // Im Baum sind ←/→ schon vergeben (oben); ↑/↓ am Rand des Baums gehen weiter zu Search/Home bzw. zur Fußzeile.
    const t = spatialTarget(active, dir);
    if (!t) return;
    e.preventDefault();
    focusTo(t);
  };
  win.addEventListener("keydown", capture, true);
  win.addEventListener("keydown", onKey);
  win.addEventListener("focusin", onFocus, true);
  win.addEventListener("pointerdown", onPointer, true);
  return () => {
    win.removeEventListener("keydown", capture, true);
    win.removeEventListener("keydown", onKey);
    win.removeEventListener("focusin", onFocus, true);
    win.removeEventListener("pointerdown", onPointer, true);
  };
}
