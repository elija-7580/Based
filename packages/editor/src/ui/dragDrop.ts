// BSD-249: Blöcke ziehen wie in Notion – nach rechts zum Verschachteln, nach links zum Ausrücken, an den linken oder
// rechten Rand eines Blocks für Spalten. Ohne @blocknote/xl-multi-column (GPL, ADR 0011): BlockNote bewegt Blöcke
// beim Ablegen selbst nur davor/dahinter; diese Datei entscheidet die übrigen Fälle (reine Funktion `dropZone`) und
// führt sie mit der Block-API aus (`applyDrop`). Der Rest (obere Hälfte, normale Zeile) bleibt BlockNote.
import { CUSTOM } from "../mapping/bn.js";

export interface Rect { left: number; right: number; top: number; bottom: number }

/** Der Block unter dem Zeiger und seine (Text-)Vorfahren, innen nach außen; Spalten zählen nicht als Ebene. */
export interface DropTarget {
  id: string;
  rect: Rect;
  /** Linke Kante des Inhalts je Ebene: [Ziel, Elternblock, …]. */
  levels: { id: string; left: number; isLast: boolean }[];
  /** Ziel steht direkt in einer Spalte (neue Spalte dann in derselben Spaltenliste). */
  inColumn: boolean;
  /** Ziel kann keine Kinder haben (Spaltenliste, Spalte, Tabelle). */
  noChildren: boolean;
}

export type DropZone =
  | { kind: "column"; side: "left" | "right"; id: string }
  | { kind: "nest"; id: string }
  | { kind: "after"; id: string }
  | { kind: "before"; id: string };

/** Breite der Spalten-Zonen: rechts innen am Rand, links im Rand neben dem Inhalt. */
export const COLUMN_EDGE = 64;
export const COLUMN_GUTTER = 48;
/** Streifen links neben dem Inhalt, in dem der Griff ⋮⋮ sitzt: dort wird umsortiert, nicht gespalten. */
export const HANDLE_GUTTER = 36;
/** So weit neben einem Block (links und rechts) zählt der Zeiger noch zu ihm. */
export const COLUMN_REACH = 120;

/** Einrückung einer Ebene (BlockNote: 24 px bei 16 px Schrift). */
export const NEST_INDENT = 24;

/**
 * Wohin ein gezogener Block fällt (immer ein Ziel, solange der Zeiger über einem Block steht).
 * - Rechter Rand (letzte 12 %, höchstens 64 px, und der Rand rechts daneben): neue Spalte – über die ganze Höhe des
 *   Blocks, wie in Notion. Vorher ging das nur in einem Streifen in der Mitte (bei einer Zeile rund 13 px hoch).
 * - Links: neue Spalte erst links vom Griff (mehr als 36 px neben dem Inhalt), ebenfalls über die ganze Höhe. Der
 *   Streifen direkt neben dem Inhalt gehört dem Griff ⋮⋮: Wer dort gerade nach oben oder unten zieht, sortiert um.
 *   Vorher sprang die Anzeige dort bei jeder Zeile zwischen „davor“, „Spalte“ und „dahinter“.
 * - In einer Spalte ist links kaum Platz: dort bleibt die Spalten-Zone direkt neben dem Inhalt, in der Mitte der Höhe.
 * - Sonst obere Hälfte: davor; untere Hälfte: dahinter auf gleicher Ebene.
 * - Untere Hälfte, Zeiger eine Einrückung weiter rechts als der Block: als erstes Kind hinein.
 * - Untere Hälfte, Zeiger links vom Block: hinter den Vorfahren, an dessen Kante er steht (nur vom letzten Kind aus).
 */
export function dropZone(x: number, y: number, t: DropTarget): DropZone {
  const { rect } = t;
  const h = rect.bottom - rect.top;
  const w = rect.right - rect.left;
  const edge = Math.min(COLUMN_EDGE, w * 0.12);
  const flat = t.levels.length <= 1; // Spalten nur oben im Dokument oder direkt in einer Spalte
  if (flat && x >= rect.right - edge) return { kind: "column", side: "right", id: t.id };
  if (flat && t.inColumn) {
    const band = Math.min(h / 4, 12);
    if (y >= rect.top + band && y <= rect.bottom - band && x < rect.left && x >= rect.left - COLUMN_GUTTER) return { kind: "column", side: "left", id: t.id };
  } else if (flat && x < rect.left - HANDLE_GUTTER && x >= rect.left - COLUMN_REACH) {
    return { kind: "column", side: "left", id: t.id };
  }
  if (y < rect.top + h / 2) return { kind: "before", id: t.id };
  const own = t.levels[0]?.left ?? rect.left;
  if (x >= own + NEST_INDENT && !t.noChildren) return { kind: "nest", id: t.id };
  if (x >= own - 4) return { kind: "after", id: t.id };
  // Ausrücken: so weit hinauf, wie der Zeiger links steht – aber nur über letzte Kinder.
  let chosen = t.levels[0]!;
  for (let i = 1; i < t.levels.length; i++) {
    if (!t.levels[i - 1]!.isLast) break;
    chosen = t.levels[i]!;
    if (chosen.left <= x + 4) break;
  }
  return { kind: "after", id: chosen.id };
}

/** Was applyDrop vom Editor braucht (Teil der BlockNote-API). */
export interface DropEditor {
  getBlock(id: string): DropBlock | undefined;
  getParentBlock(id: string): DropBlock | undefined;
  removeBlocks(ids: string[]): unknown;
  insertBlocks(blocks: unknown[], ref: string, placement: "before" | "after"): unknown;
  replaceBlocks(remove: string[], insert: unknown[]): unknown;
  updateBlock(id: string, update: { children: unknown[] }): unknown;
  transact<T>(f: () => T): T;
}
export interface DropBlock { id: string; type: string; props?: Record<string, unknown>; children: DropBlock[] }

/** Höchstzahl Spalten (wie das Slash-Menü). */
export const MAX_COLUMNS = 5;

/** Darf `dragged` nach `zone`? Nicht in sich selbst, nicht mehr als fünf Spalten. */
export function canDrop(editor: DropEditor, dragged: readonly string[], zone: DropZone): boolean {
  if (dragged.length === 0 || dragged.includes(zone.id)) return false;
  for (let p = editor.getParentBlock(zone.id); p; p = editor.getParentBlock(p.id)) if (dragged.includes(p.id)) return false;
  if (zone.kind === "column") {
    const parent = editor.getParentBlock(zone.id);
    if (parent?.type === CUSTOM.column) {
      const list = editor.getParentBlock(parent.id);
      if (list && list.children.length >= MAX_COLUMNS && !list.children.some((c) => c.children.every((k) => dragged.includes(k.id)))) return false;
    }
  }
  return true;
}

/** Leere Spalten (nach dem Wegziehen) räumen; eine Spaltenliste mit nur einer Spalte löst sich auf. */
function tidyColumns(editor: DropEditor, listID: string | undefined) {
  if (!listID) return;
  const list = editor.getBlock(listID);
  if (!list || list.type !== CUSTOM.columnList) return;
  const empty = list.children.filter((c) => c.children.length === 0).map((c) => c.id);
  if (empty.length) editor.removeBlocks(empty);
  const now = editor.getBlock(listID);
  if (!now) return;
  if (now.children.length === 0) editor.removeBlocks([listID]);
  else if (now.children.length === 1) editor.replaceBlocks([listID], now.children[0]!.children);
}

/** Führt das Ablegen aus (ein Schritt im Undo). Liefert false, wenn nichts passiert ist. */
export function applyDrop(editor: DropEditor, dragged: readonly string[], zone: DropZone): boolean {
  if (!canDrop(editor, dragged, zone)) return false;
  const blocks = dragged.map((id) => editor.getBlock(id)).filter((b): b is DropBlock => b !== undefined);
  if (blocks.length === 0) return false;
  return editor.transact(() => {
    // Spaltenlisten, aus denen gezogen wird, danach aufräumen.
    const sourceLists = new Set<string>();
    for (const b of blocks) {
      const col = editor.getParentBlock(b.id);
      if (col?.type === CUSTOM.column) {
        const list = editor.getParentBlock(col.id);
        if (list) sourceLists.add(list.id);
      }
    }
    editor.removeBlocks(blocks.map((b) => b.id));
    const target = editor.getBlock(zone.id);
    if (!target) return false;
    if (zone.kind === "after" || zone.kind === "before") {
      editor.insertBlocks(blocks, zone.id, zone.kind);
    } else if (zone.kind === "nest") {
      editor.updateBlock(zone.id, { children: [...blocks, ...target.children] });
    } else {
      const col = editor.getParentBlock(zone.id);
      const fresh = { type: CUSTOM.column, props: { width: 0 }, children: blocks };
      if (col?.type === CUSTOM.column) {
        editor.insertBlocks([fresh], col.id, zone.side === "left" ? "before" : "after");
        // Neue Spalte: alle wieder gleich breit (wie Notion).
        const list = editor.getParentBlock(col.id);
        if (list) for (const c of list.children) editor.updateBlock(c.id, { props: { width: 0 } } as never);
      } else {
        const self = { type: CUSTOM.column, props: { width: 0 }, children: [target] };
        editor.replaceBlocks([zone.id], [{ type: CUSTOM.columnList, children: zone.side === "left" ? [fresh, self] : [self, fresh] }]);
      }
    }
    for (const l of sourceLists) tidyColumns(editor, l);
    return true;
  });
}

const LAYOUT = new Set<string>([CUSTOM.column, CUSTOM.columnList]);
const NO_CHILDREN = new Set<string>([CUSTOM.column, CUSTOM.columnList, "table"]);

const contentOf = (outer: Element): Element | null => outer.querySelector(":scope > .bn-block > .bn-block-content, :scope > .bn-block > .react-renderer > .bn-block-content");
const typeOf = (outer: Element) => contentOf(outer)?.getAttribute("data-content-type") ?? "";

/** Ziel aus dem DOM: der Block unter dem Zeiger in genau diesem Editor (nicht in eingebetteten). */
export function targetAt(root: HTMLElement, el: Element | null, ignore: ReadonlySet<string> = new Set(), at?: { x: number; y: number }): DropTarget | undefined {
  let outer = el?.closest(".bn-block-outer[data-id]") ?? null;
  // Layoutblöcke (Spaltenlücke, Griff) und Ränder: der nächste Block auf dieser Höhe, links höchstens 48 px entfernt.
  if (outer && (LAYOUT.has(typeOf(outer)) || outer.closest(".bn-editor") !== root)) outer = null;
  if (!outer && at) outer = nearestBlock(root, at.x, at.y, ignore);
  if (!outer || outer.closest(".bn-editor") !== root) return undefined;
  const content = contentOf(outer);
  if (!content) return undefined;
  const r = content.getBoundingClientRect();
  const levels: DropTarget["levels"] = [];
  let inColumn = false;
  for (let cur: Element | null = outer; cur;) {
    const t = typeOf(cur);
    if (!LAYOUT.has(t)) {
      const c = contentOf(cur);
      const sib = cur.parentElement ? [...cur.parentElement.children].filter((e) => e.classList.contains("bn-block-outer") && !ignore.has(e.getAttribute("data-id") ?? "")) : [];
      levels.push({ id: cur.getAttribute("data-id")!, left: c ? c.getBoundingClientRect().left : r.left, isLast: sib[sib.length - 1] === cur });
    } else if (t === CUSTOM.column) {
      inColumn = true;
      break; // Spalten begrenzen Verschachteln und Ausrücken
    }
    cur = cur.parentElement?.closest(".bn-block-outer[data-id]") ?? null;
    if (cur && cur.closest(".bn-editor") !== root) break;
  }
  return { id: outer.getAttribute("data-id")!, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, levels, inColumn, noChildren: NO_CHILDREN.has(typeOf(outer)) };
}

function nearestBlock(root: HTMLElement, x: number, y: number, ignore: ReadonlySet<string>): Element | null {
  let best = null as Element | null;
  let bestDist = Infinity;
  for (const o of root.querySelectorAll(".bn-block-outer[data-id]")) {
    if (LAYOUT.has(typeOf(o)) || ignore.has(o.getAttribute("data-id") ?? "") || o.closest(".bn-editor") !== root) continue;
    const c = contentOf(o);
    if (!c) continue;
    const r = c.getBoundingClientRect();
    if (y < r.top || y > r.bottom || x < r.left - COLUMN_REACH || x > r.right + COLUMN_REACH) continue;
    const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    if (d < bestDist || (d === bestDist && best?.contains(o))) { best = o; bestDist = d; }
  }
  if (best) return best;
  // Unter dem letzten Block der Seite: dahinter ablegen (sonst gab es dort kein Ziel).
  const top = [...root.querySelectorAll(":scope > .bn-block-group > .bn-block-outer[data-id]")].filter((o) => !ignore.has(o.getAttribute("data-id") ?? ""));
  const last = top[top.length - 1];
  const lr = last ? (contentOf(last) ?? last).getBoundingClientRect() : undefined;
  if (last && lr && y > lr.bottom && x >= lr.left - COLUMN_REACH && x <= lr.right + COLUMN_REACH && !LAYOUT.has(typeOf(last))) return last;
  return null;
}

/** Wo der Hinweis-Strich hinkommt (Bildschirmkoordinaten). */
export function indicatorFor(zone: DropZone, t: DropTarget, x: number): Rect {
  const { rect } = t;
  if (zone.kind === "column") {
    const at = zone.side === "right" ? rect.right : rect.left - 8;
    return { left: at, right: at + 3, top: rect.top, bottom: rect.bottom };
  }
  if (zone.kind === "before") return { left: rect.left, right: rect.right, top: rect.top - 3, bottom: rect.top };
  const left = zone.kind === "nest" ? (t.levels[0]?.left ?? rect.left) + NEST_INDENT : (t.levels.find((l) => l.id === zone.id)?.left ?? Math.min(x, rect.left));
  return { left, right: Math.max(left + 24, rect.right), top: rect.bottom, bottom: rect.bottom + 3 };
}

/** BSD-249 Teil 2: Auto-Scroll beim Ziehen – Abstand zum Rand, ab dem gescrollt wird, und Schritt je dragover (px). */
export const EDGE_ZONE = 56;
const EDGE_MAX_STEP = 28;

/** Schritt für den Zeiger bei `y` in einem Bereich [top, bottom]: negativ nach oben, positiv nach unten, 0 in der Mitte. */
export function edgeScrollStep(y: number, top: number, bottom: number): number {
  const into = y < top + EDGE_ZONE ? top + EDGE_ZONE - y : y > bottom - EDGE_ZONE ? -(y - (bottom - EDGE_ZONE)) : 0;
  if (into === 0) return 0;
  const step = Math.min(EDGE_MAX_STEP, 4 + Math.abs(into) / 2);
  return into > 0 ? -Math.round(step) : Math.round(step);
}

/** Nächster scrollbare Vorfahre (sonst das Dokument). */
function scrollParent(el: HTMLElement): HTMLElement | undefined {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = globalThis.getComputedStyle?.(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return (globalThis.document?.scrollingElement as HTMLElement | null) ?? undefined;
}

interface PMNode { attrs: Record<string, unknown>; type: { name: string } }
interface DragView { dragging: unknown; dom: HTMLElement; state: { selection: { node?: PMNode; nodes?: PMNode[] } } }
export interface BlockDropHost extends DropEditor {
  prosemirrorView: DragView | undefined;
  getSelection(): { blocks: { id: string }[] } | undefined;
  getTextCursorPosition(): { block: { id: string } };
  focus?(): void;
}

/**
 * Hängt das Ziehen an den Editor: beim Überfahren Zone + Hinweis, beim Ablegen ausführen (BlockNotes eigenes Ablegen
 * fällt dann aus). Gibt das Abmelden zurück.
 */
export function attachBlockDrop(
  host: BlockDropHost, container: HTMLElement, show: (r: Rect | undefined) => void, handleBlock: () => string | undefined = () => undefined,
  /** BSD-249 Teil 2: Blockauswahl (Esc, Rechteck, ⇧-Klick); liegt der gefasste Block darin, wandert die ganze Auswahl. */
  blockSelection: () => readonly string[] = () => [],
): () => void {
  // Die ProseMirror-Ansicht entsteht erst nach dem Einhängen (bei Kollaboration auch später): erst beim Ereignis holen.
  const viewOf = () => host.prosemirrorView;
  let current: DropZone | undefined;
  // BlockNote wählt beim Fassen am Griff die gezogenen Blöcke als (Mehrfach-)Knotenauswahl aus.
  const dragged = (view: DragView): string[] => {
    const sel = view.state.selection;
    const nodes = sel.nodes ?? (sel.node ? [sel.node] : []);
    const ids = nodes.map((n) => n.attrs.id).filter((id): id is string => typeof id === "string" && id !== "");
    // Gefasst wurde der Block am Griff; eine Mehrfachauswahl zählt nur, wenn er darin liegt.
    const grabbed = handleBlock();
    const picked = blockSelection();
    if (grabbed && picked.length > 1 && picked.includes(grabbed)) return [...picked];
    if (grabbed && !ids.includes(grabbed)) return [grabbed];
    return ids.length ? ids : [host.getTextCursorPosition().block.id];
  };
  const reset = () => {
    current = undefined;
    show(undefined);
    globalThis.document?.documentElement.removeAttribute("data-bx-dropzone");
  };
  const autoScroll = (e: DragEvent) => {
    const el = scrollParent(container);
    if (!el) return;
    const isDoc = el === globalThis.document?.scrollingElement;
    const r = isDoc ? { top: 0, bottom: globalThis.innerHeight } : el.getBoundingClientRect();
    const step = edgeScrollStep(e.clientY, r.top, r.bottom);
    if (step) el.scrollTop += step;
  };
  const over = (e: DragEvent) => {
    const view = viewOf();
    // Andere Editoren auf der Seite hören mit: nur aufräumen, wenn dieser hier gerade etwas anzeigt.
    if (!view?.dragging) { if (current) reset(); return; }
    // BlockNote schickt für Zeiger neben dem Editor ein zweites, künstliches dragover mit Koordinaten im Editor
    // (SideMenu, `synthetic`). Das würde die Zone im Rand (Spalte links/rechts) sofort mit „dahinter“ überschreiben.
    if ((e as DragEvent & { synthetic?: boolean }).synthetic) {
      if (current) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    autoScroll(e);
    const root = view.dom;
    const ids = dragged(view);
    const t = targetAt(root, globalThis.document?.elementFromPoint(e.clientX, e.clientY) ?? null, new Set(ids), { x: e.clientX, y: e.clientY });
    const zone = t ? dropZone(e.clientX, e.clientY, t) : undefined;
    if (!t || !zone || !canDrop(host, ids, zone)) return reset();
    current = zone;
    e.preventDefault();
    show(indicatorFor(zone, t, e.clientX));
    globalThis.document?.documentElement.setAttribute("data-bx-dropzone", zone.kind);
  };
  const drop = (e: DragEvent) => {
    const zone = current;
    reset();
    const view = viewOf();
    if (!zone || !view?.dragging) return;
    e.preventDefault();
    e.stopPropagation();
    const ids = dragged(view);
    view.dragging = null;
    if (applyDrop(host, ids, zone)) host.focus?.();
  };
  const end = () => reset();
  // Am Dokument, nicht am Editor: die Spalten-Zonen liegen auch im Rand links und rechts neben dem Editor.
  const doc = container.ownerDocument;
  doc.addEventListener("dragover", over, true);
  doc.addEventListener("drop", drop, true);
  globalThis.document?.addEventListener("dragend", end);
  return () => {
    doc.removeEventListener("dragover", over, true);
    doc.removeEventListener("drop", drop, true);
    globalThis.document?.removeEventListener("dragend", end);
    reset();
  };
}
