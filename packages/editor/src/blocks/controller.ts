// ADR 0016 (E2/E3): Zustand eines Block-Editors außerhalb von React – Fokus-Manager (Cursor = Block + Offsets),
// Blockauswahl (Menge von Block-IDs) und die Ausführung von Befehlen. Die Ansicht meldet ihre Textfelder an; nach
// jedem Rendern setzt der Controller den ausstehenden Cursor ins DOM.
import { blockCommands as cmd, type EditorFocus, type WorkspaceStore } from "@based/core";
import { offsetAtPoint, selectionIn, setSelectionIn, textLength } from "./dom.js";

type Listener = () => void;

/** Cursor bzw. Textauswahl in einem Block (UTF-16-Offsets wie der Kern; eine Erwähnung zählt ihre Textlänge). */
export interface Caret {
  id: string;
  from: number;
  to: number;
}

export class EditorController {
  caret: Caret | undefined;
  private pending = false;
  /** Wunsch-x beim Wechsel mit ↑/↓ und die Kante, an der der Cursor landen soll. */
  private pendingPoint: { x: number; edge: "first" | "last" } | undefined;
  selected: readonly string[] = [];
  /** Anker der Blockauswahl (für ⇧↑/⇧↓). */
  anchor: string | undefined;
  /**
   * Marks für das nächste getippte Zeichen an genau dieser Stelle (⌘B ohne Auswahl, nach **fett**): `null` = ohne
   * Formatierung. Gilt nur, solange der Cursor dort steht.
   */
  stored: { id: string; at: number; marks: Record<string, unknown> | null } | undefined;
  /** Block mit laufender IME-Komposition (dessen DOM wird nicht neu geschrieben). */
  composing: string | undefined;
  private readonly editables = new Map<string, HTMLElement>();
  private readonly listeners = new Set<Listener>();
  private version = 0;
  root: HTMLElement | null = null;

  constructor(readonly store: WorkspaceStore, readonly pageID: string) {}

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  private changed() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  register(id: string, el: HTMLElement | null) {
    if (el) this.editables.set(id, el);
    else this.editables.delete(id);
  }
  editable(id: string): HTMLElement | undefined {
    return this.editables.get(id);
  }

  /** Cursor setzen; wird angewandt, sobald das Feld gerendert ist (sofort, wenn es schon steht). */
  setCaret(c: Caret | undefined, point?: { x: number; edge: "first" | "last" }) {
    this.caret = c;
    this.pending = c !== undefined;
    this.pendingPoint = point;
    if (c && this.selected.length) {
      this.selected = [];
      this.changed();
    }
    // Fallback, falls kein Rendern folgt (reine Navigation)
    requestAnimationFrame(() => this.applyPending());
    this.applyPending();
  }

  /** Aus der Ansicht nach jedem Rendern eines Felds. */
  applyPending(id?: string) {
    if (!this.pending || !this.caret || (id !== undefined && id !== this.caret.id)) return;
    const el = this.editables.get(this.caret.id);
    if (!el || !el.isConnected) return;
    if (this.pendingPoint) {
      const off = offsetAtPoint(el, this.pendingPoint.x, this.pendingPoint.edge);
      this.caret = { id: this.caret.id, from: off, to: off };
      this.pendingPoint = undefined;
    }
    const len = textLength(el);
    const from = Math.min(this.caret.from, len), to = Math.min(this.caret.to, len);
    if (el.ownerDocument.activeElement !== el) el.focus({ preventScroll: true });
    setSelectionIn(el, from, to);
    this.pending = false;
    scrollIntoViewIfNeeded(el);
  }

  /**
   * Nach dem Neuschreiben eines Felds (Modell → DOM) oder nach einem Neu-Einhängen (Block hat den Elternteil
   * gewechselt): den Cursor wieder setzen, wenn er in diesem Block steht und der Fokus nicht woanders ist.
   */
  restore(id: string) {
    if (!this.caret || this.caret.id !== id) return;
    const el = this.editables.get(id);
    if (!el || !el.isConnected) return;
    const active = el.ownerDocument.activeElement;
    const free = active === el || active === null || active === el.ownerDocument.body || active === this.root;
    if (!this.pending && !free) return;
    this.pending = true;
    this.applyPending(id);
  }

  /**
   * ADR 0016 (E7): Ein anderer hat den Text eines Blocks geändert (Delta wie Y.Text). Steht die eigene Schreibmarke
   * darin, wird sie mitverschoben und nach dem Neuzeichnen wieder gesetzt.
   */
  shiftCaret(id: string, delta: readonly { insert?: unknown; delete?: number | undefined; retain?: number | undefined }[]) {
    const el = this.editables.get(id);
    const focused = el && el.ownerDocument.activeElement === el;
    const c = focused ? this.readCaret(id) : this.caret?.id === id ? this.caret : undefined;
    if (!c) return;
    const map = (pos: number) => {
      let at = 0, out = pos;
      for (const op of delta) {
        if (op.retain !== undefined) at += op.retain;
        else if (typeof op.insert === "string") {
          if (at <= pos) out += op.insert.length;
          at += op.insert.length;
        } else if (op.delete !== undefined) {
          if (at < pos) out -= Math.min(op.delete, pos - at);
        }
        if (at > out) break;
      }
      return Math.max(0, out);
    };
    this.caret = { id, from: map(c.from), to: map(c.to) };
    if (focused) this.pending = true;
  }

  /** Cursor aus der DOM-Auswahl lesen (vor jedem Befehl). */
  readCaret(id: string): Caret | undefined {
    const el = this.editables.get(id);
    if (!el) return undefined;
    const s = selectionIn(el);
    if (!s) return this.caret?.id === id ? this.caret : { id, from: 0, to: 0 };
    this.caret = { id, from: s.from, to: s.to };
    return this.caret;
  }

  /** Fokus nach einem Befehl übernehmen (Schreibmarke, Textauswahl oder ausgewählter Block). */
  apply(f: EditorFocus | undefined) {
    if (!f) return;
    if ("selected" in f) this.select([f.blockId]);
    else if ("range" in f) this.setCaret({ id: f.blockId, from: f.range.from, to: f.range.to });
    else this.setCaret({ id: f.blockId, from: f.offset, to: f.offset });
  }

  /** Sichtbare Blöcke der Seite in Lesereihenfolge, ohne die Spalten-Hüllen (die sind keine eigenen Zeilen). */
  order(): string[] {
    return cmd.visibleOrder(this.store, this.pageID).filter((id) => {
      const t = this.store.blocks.get(id)?.type;
      return t !== "columnList" && t !== "column";
    });
  }

  /** Nächster/vorheriger sichtbarer Block mit Textfeld (Pfeiltasten, auch über Spalten hinweg). */
  neighbourText(id: string, dir: -1 | 1): string | undefined {
    const order = this.order();
    // BSD-407 Teil 5: Blöcke in einem eigenen Bereich (Notizen/Zusammenfassung eines Meetings) stehen nicht in der
    // Seitenreihenfolge – dort bleiben die Pfeile im Bereich (nextVisible/previousVisible halten an der Grenze).
    if (!order.includes(id)) {
      let cur: string | undefined = id;
      for (let n = 0; n < 10_000; n++) {
        cur = dir > 0 ? cmd.nextVisible(this.store, cur) : cmd.previousVisible(this.store, cur);
        if (!cur || cmd.isTextBlock(this.store.blocks.get(cur))) return cur;
      }
      return undefined;
    }
    for (let i = order.indexOf(id) + dir; i >= 0 && i < order.length; i += dir) {
      if (cmd.isTextBlock(this.store.blocks.get(order[i]!))) return order[i];
    }
    return undefined;
  }

  select(ids: readonly string[], anchor?: string) {
    this.selected = cmd.topLevel(this.store, ids);
    this.anchor = anchor ?? this.selected[0];
    if (this.selected.length) {
      this.caret = undefined;
      this.pending = false;
      const active = this.root?.ownerDocument.activeElement as HTMLElement | null;
      if (active && active.isContentEditable) active.blur();
      this.root?.ownerDocument.getSelection()?.removeAllRanges();
      this.root?.focus({ preventScroll: true });
    }
    this.changed();
  }
  clearSelection() {
    if (!this.selected.length) return;
    this.selected = [];
    this.changed();
  }
  isSelected(id: string) {
    return this.selected.includes(id);
  }

  /** Blockauswahl von `anchor` bis `head` (sichtbare Reihenfolge). */
  selectRange(anchor: string, head: string) {
    const order = this.order();
    const a = order.indexOf(anchor), b = order.indexOf(head);
    if (a < 0 || b < 0) return;
    this.select(order.slice(Math.min(a, b), Math.max(a, b) + 1), anchor);
  }
}

function scrollIntoViewIfNeeded(el: HTMLElement) {
  const sel = el.ownerDocument.getSelection();
  const rect = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : el.getBoundingClientRect();
  const box = rect.height === 0 && rect.width === 0 ? el.getBoundingClientRect() : rect;
  const scroller = scrollParent(el);
  if (!scroller) return;
  const s = scroller.getBoundingClientRect();
  const margin = 48;
  if (box.bottom > s.bottom - margin) scroller.scrollTop += box.bottom - (s.bottom - margin);
  else if (box.top < s.top + margin) scroller.scrollTop -= s.top + margin - box.top;
}

export function scrollParent(el: HTMLElement): HTMLElement | null {
  let p = el.parentElement;
  while (p) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
    p = p.parentElement;
  }
  return null;
}
