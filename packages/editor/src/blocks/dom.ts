// ADR 0016 (E2): RichText ↔ DOM eines Textfelds. Das DOM eines Blocks wird nur aus dem Modell geschrieben
// (renderRich), nie per React-Kinder; Offsets (UTF-16) und DOM-Positionen werden hier ineinander umgerechnet.
// Atomare Läufe (Erwähnung, Gleichung) sind `contenteditable=false`-Elemente mit `data-atom`; sie zählen so viele
// Zeichen wie ihr Text im Modell (`data-len`), auch wenn sie etwas anderes anzeigen (aktueller Seitentitel).
import { blockCommands as cmd, plainText, type RichText } from "@based/core";

type Run = cmd.Run;

export interface AtomRenderer {
  /** Text einer Seiten-Erwähnung (Titel); ohne: „Untitled“. */
  pageTitle?: (id: string) => string | undefined;
  /** BSD-407: Inline-Gleichung als HTML (KaTeX der Hülle); ohne oder solange nicht geladen: der TeX-Text. */
  equationHTML?: (tex: string) => string | undefined;
}

const MARK_CLASSES: Record<string, string> = { b: "bx2-b", i: "bx2-i", u: "bx2-u", s: "bx2-s", c: "bx2-c" };

/** Wert einer Erwähnung (Swift-Enum `{ page: { _0: … } }`). */
function mentionValue(m: Record<string, unknown>, kind: string): unknown {
  const v = m[kind] as { _0?: unknown } | string | undefined;
  return typeof v === "object" && v !== null ? v._0 : v;
}

function runElement(doc: Document, r: Run, atoms: AtomRenderer): Node {
  if (r.mention !== undefined || r.eq !== undefined) {
    const el = doc.createElement("span");
    el.contentEditable = "false";
    el.dataset.atom = "";
    el.dataset.len = String(r.t.length);
    if (r.eq !== undefined) {
      el.className = "bx2-eq";
      el.dataset.tex = r.eq;
      const html = atoms.equationHTML?.(r.eq);
      if (html) el.innerHTML = html;
      else el.textContent = r.eq;
    } else {
      const m = r.mention as Record<string, unknown>;
      el.className = "bx2-mention";
      const page = mentionValue(m, "page");
      if (typeof page === "string") {
        el.dataset.page = page;
        el.textContent = atoms.pageTitle?.(page) || r.t || "Untitled";
      } else el.textContent = r.t || "•";
    }
    return el;
  }
  const t = r.t;
  const m = r.m as Record<string, unknown>;
  const classes = Object.keys(MARK_CLASSES).filter((k) => m[k]).map((k) => MARK_CLASSES[k]!);
  if (typeof m.color === "string" && m.color !== "default") classes.push("bx2-color-" + m.color);
  if (classes.length === 0 && typeof m.link !== "string") return doc.createTextNode(t);
  const el = typeof m.link === "string" ? doc.createElement("a") : doc.createElement("span");
  if (el instanceof HTMLAnchorElement) {
    el.href = m.link as string;
    el.rel = "noopener noreferrer";
  }
  if (classes.length) el.className = classes.join(" ");
  el.textContent = t;
  return el;
}

/** Inhalt eines Textfelds aus dem Modell setzen. Leerer Text bekommt ein <br>, damit die Zeile Höhe hat. */
export function renderRich(el: HTMLElement, text: RichText | undefined, atoms: AtomRenderer = {}): void {
  const doc = el.ownerDocument;
  const frag = doc.createDocumentFragment();
  const runs = cmd.runsOf(text);
  for (const r of runs) frag.append(runElement(doc, r, atoms));
  // Ein abschließender Zeilenumbruch braucht ein <br>, sonst ist die letzte (leere) Zeile nicht sichtbar
  const plain = plainText(text);
  if (plain === "" || plain.endsWith("\n")) frag.append(doc.createElement("br"));
  el.replaceChildren(frag);
}

const isAtomEl = (n: Node): n is HTMLElement => n.nodeType === 1 && (n as HTMLElement).dataset.atom !== undefined;
const atomLen = (n: HTMLElement): number => Number(n.dataset.len ?? 1) || 1;

/** UTF-16-Offset einer DOM-Position innerhalb von `root`. */
export function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  if (!root.contains(node)) return node.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING ? 0 : textLength(root);
  let count = 0;
  let done = false;
  const visit = (n: Node): void => {
    if (done) return;
    if (n === node) {
      if (n.nodeType === 3) count += offset;
      else for (let i = 0; i < offset && i < n.childNodes.length; i++) count += nodeLength(n.childNodes[i]!);
      done = true;
      return;
    }
    if (isAtomEl(n)) {
      if (n.contains(node)) {
        // Position in einer Erwähnung: davor oder dahinter
        count += offset > 0 ? atomLen(n) : 0;
        done = true;
        return;
      }
      count += atomLen(n);
      return;
    }
    if (n.nodeType === 3) {
      count += (n.nodeValue ?? "").length;
      return;
    }
    for (const c of Array.from(n.childNodes)) {
      visit(c);
      if (done) return;
    }
  };
  for (const c of Array.from(root.childNodes)) {
    visit(c);
    if (done) break;
  }
  return count;
}

function nodeLength(n: Node): number {
  if (isAtomEl(n)) return atomLen(n);
  if (n.nodeType === 3) return (n.nodeValue ?? "").length;
  let len = 0;
  for (const c of Array.from(n.childNodes)) len += nodeLength(c);
  return len;
}

export const textLength = (root: HTMLElement): number => nodeLength(root);

/** DOM-Position zu einem Offset (für das Setzen des Cursors). */
export function pointAt(root: HTMLElement, offset: number): { node: Node; offset: number } {
  let remaining = Math.max(0, offset);
  const walk = (parent: Node): { node: Node; offset: number } | undefined => {
    const children = Array.from(parent.childNodes);
    for (let i = 0; i < children.length; i++) {
      const n = children[i]!;
      if (isAtomEl(n)) {
        if (remaining === 0) return { node: parent, offset: i };
        // Mitten in einer Erwähnung gibt es keine Stelle: dahinter (wie der Kern, snapOffset)
        remaining = Math.max(0, remaining - atomLen(n));
        if (remaining === 0) return { node: parent, offset: i + 1 };
        continue;
      }
      if (n.nodeType === 3) {
        const len = (n.nodeValue ?? "").length;
        if (remaining <= len) return { node: n, offset: remaining };
        remaining -= len;
        continue;
      }
      if (n.nodeName === "BR") continue;
      const inner = walk(n);
      if (inner) return inner;
    }
    return undefined;
  };
  return walk(root) ?? { node: root, offset: root.childNodes.length - (root.lastChild?.nodeName === "BR" ? 1 : 0) };
}

/** Aktuelle Auswahl als Offsets in `root` (oder undefined, wenn sie nicht darin liegt). */
export function selectionIn(root: HTMLElement): { from: number; to: number; backward: boolean } | undefined {
  const sel = root.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0) return undefined;
  const a = sel.anchorNode, f = sel.focusNode;
  if (!a || !f || !root.contains(a) || !root.contains(f)) return undefined;
  const anchor = offsetOf(root, a, sel.anchorOffset);
  const focus = offsetOf(root, f, sel.focusOffset);
  return { from: Math.min(anchor, focus), to: Math.max(anchor, focus), backward: focus < anchor };
}

/** Cursor/Auswahl in `root` setzen. */
export function setSelectionIn(root: HTMLElement, from: number, to: number = from): void {
  const sel = root.ownerDocument.getSelection();
  if (!sel) return;
  const a = pointAt(root, from);
  const b = from === to ? a : pointAt(root, to);
  const range = root.ownerDocument.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Liegt der Cursor in der ersten bzw. letzten Zeile des Felds? (für ↑/↓ zwischen Blöcken) */
export function caretOnEdgeLine(root: HTMLElement, edge: "first" | "last"): boolean {
  const sel = root.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0) return true;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(edge === "first");
  const rects = range.getClientRects();
  const caret = rects[0] ?? (range.startContainer.nodeType === 1 ? (range.startContainer as Element).getBoundingClientRect() : undefined);
  const box = root.getBoundingClientRect();
  if (!caret || (caret.width === 0 && caret.height === 0)) return true;
  const line = parseFloat(getComputedStyle(root).lineHeight) || caret.height || 20;
  return edge === "first" ? caret.top - box.top < line * 0.8 : box.bottom - caret.bottom < line * 0.8;
}

/** x-Position des Cursors (für ↑/↓: im Nachbarblock an derselben Stelle weiterschreiben). */
export function caretX(root: HTMLElement): number | undefined {
  const sel = root.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0) return undefined;
  const r = sel.getRangeAt(0).getClientRects()[0];
  return r?.left;
}

/** Offset im Feld an einer Bildschirmposition (x in der ersten/letzten Zeile). */
export function offsetAtPoint(root: HTMLElement, x: number, edge: "first" | "last"): number {
  const box = root.getBoundingClientRect();
  const y = edge === "first" ? box.top + 4 : box.bottom - 4;
  const doc = root.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const clampedX = Math.min(Math.max(x, box.left + 1), box.right - 1);
  const pos = doc.caretPositionFromPoint?.(clampedX, y);
  if (pos && root.contains(pos.offsetNode)) return offsetOf(root, pos.offsetNode, pos.offset);
  const range = doc.caretRangeFromPoint?.(clampedX, y);
  if (range && root.contains(range.startContainer)) return offsetOf(root, range.startContainer, range.startOffset);
  return edge === "first" ? 0 : textLength(root);
}
