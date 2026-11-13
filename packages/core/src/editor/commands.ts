// ADR 0016 (Block-Editor, E1): Befehle auf den Block-Records einer Seite. Jeder Befehl ist eine Store-Transaktion und
// damit ein Undo-Schritt (Tippen wird pro Block zusammengefasst). Der Editor ruft nur diese Befehle auf und bekommt
// zurück, wohin Cursor bzw. Blockauswahl danach gehören. Rein, ohne DOM – getestet in test/block-editor.test.ts.
import type { Block, RichText } from "../model/records.js";
import { keysBetween } from "../sortkeys.js";
import { graphemes } from "../graphemes.js";
import { keyOf, type Tx, type WorkspaceStore } from "../store/store.js";
import { sortKeys } from "../store/pages.js";
import { richConcat, richInsertText, richLength, richPlain, richReplace, richSlice, richToggleMark, richSetMark, normalizeRich, type MarkKey, type Marks } from "./rich.js";

/** Cursor bzw. Textauswahl in einem Block (UTF-16-Offsets). */
export interface Caret {
  id: string;
  from: number;
  to: number;
}

/** Was nach einem Befehl gilt: Cursor in einem Block oder eine Blockauswahl. */
export interface EditResult {
  caret?: Caret;
  select?: string[];
}

/** Blöcke mit eigenem Textfeld. */
export const TEXT_BLOCKS: ReadonlySet<string> = new Set([
  "text", "heading1", "heading2", "heading3", "heading4", "bulletedList", "numberedList", "todo", "toggle", "quote", "callout", "code",
]);
/** Enter setzt diesen Typ im neuen Block fort. */
const CONTINUES: ReadonlySet<string> = new Set(["bulletedList", "numberedList", "todo", "toggle"]);
/** Diese Blöcke können eingerückte Kinder haben (Überschriften nur als Toggle). */
const NESTABLE: ReadonlySet<string> = new Set(["text", "bulletedList", "numberedList", "todo", "toggle", "quote", "callout", "column", "syncedBlock"]);
/** Grenzen: aus ihnen wird nicht ausgerückt, Pfeile/Löschen gehen nicht darüber hinaus. */
const CONTAINERS: ReadonlySet<string> = new Set(["page", "databasePage", "column", "columnList"]);

const newID = () => crypto.randomUUID().toUpperCase();
const at = (c: Caret, pos: number): Caret => ({ id: c.id, from: pos, to: pos });

export const isTextBlock = (b: Block | undefined): boolean => b !== undefined && TEXT_BLOCKS.has(b.type);
export function canHaveChildren(b: Block | undefined): boolean {
  if (!b) return false;
  if (NESTABLE.has(b.type)) return true;
  return /^heading[1-4]$/.test(b.type) && b.props?.toggleable === true;
}

const blockOf = (store: WorkspaceStore, id: string) => store.blocks.get(id);
const parentID = (b: Block) => (b.parent.startsWith("b:") ? b.parent.slice(2) : undefined);
const kids = (store: WorkspaceStore, id: string) => store.children("b:" + id).filter((k) => store.blocks.get(k)?.trashedAt === undefined);

/** Sind die Kinder sichtbar (geschlossener Toggle versteckt sie, Seiten/Datenbanken zeigen ihre nicht inline)? */
export function childrenVisible(b: Block): boolean {
  if (b.type === "page" || b.type === "databasePage" || b.type === "databaseInline" || b.type === "linkToPage") return false;
  if (b.type === "toggle" || (/^heading/.test(b.type) && b.props?.toggleable)) return b.props?.isOpen === true;
  return true;
}

/** Sichtbare Blöcke einer Seite in Dokument-Reihenfolge (Spalten von links nach rechts). */
export function visibleOrder(store: WorkspaceStore, pageID: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    for (const k of kids(store, id)) {
      const b = store.blocks.get(k)!;
      if (b.type !== "columnList" && b.type !== "column") out.push(k);
      if (b.type === "columnList" || b.type === "column" || childrenVisible(b)) walk(k);
    }
  };
  walk(pageID);
  return out;
}

/** Nächster/vorheriger sichtbarer Block mit Textfeld (für Pfeile, Löschen am Anfang). */
export function neighbourText(store: WorkspaceStore, pageID: string, id: string, dir: -1 | 1): string | undefined {
  const order = visibleOrder(store, pageID);
  let i = order.indexOf(id) + dir;
  while (i >= 0 && i < order.length) {
    if (isTextBlock(store.blocks.get(order[i]!))) return order[i];
    i += dir;
  }
  return undefined;
}

const neighbour = (store: WorkspaceStore, pageID: string, id: string, dir: -1 | 1): string | undefined => {
  const order = visibleOrder(store, pageID);
  return order[order.indexOf(id) + dir];
};

function setText(tx: Tx, id: string, text: RichText) {
  tx.update(id, (x) => {
    const t = normalizeRich(typeof text === "string" ? (text ? [{ t: text }] : []) : text);
    if (t === "" || (Array.isArray(t) && t.length === 0)) delete x.text;
    else x.text = t;
  });
}

function makeBlock(store: WorkspaceStore, tx: Tx, parent: string, sk: string, type: string, text?: RichText, props?: Block["props"]): string {
  const id = newID();
  const now = store.now();
  const b: Block = { id, type, parent, sk, createdAt: now, updatedAt: now };
  if (text !== undefined && richLength(text) > 0) b.text = text;
  if (props && Object.keys(props).length) b.props = props;
  if (store.userID != null) b.createdBy = store.userID;
  tx.put({ kind: "block", data: b });
  return id;
}

function moveTo(store: WorkspaceStore, tx: Tx, ids: readonly string[], parent: string, position: { kind: "end" } | { kind: "before" | "after"; id: string }) {
  const moving = new Set(ids);
  const keys = sortKeys(store, parent, position, ids.length, moving);
  ids.forEach((id, i) => tx.update(id, (x) => { x.parent = parent; x.sk = keys[i]!; }));
}

/** Leere Spalten entfernen, Spaltenlisten mit einer Spalte auflösen (nach Verschieben/Löschen). */
function cleanupColumns(store: WorkspaceStore, tx: Tx, listIDs: Iterable<string>) {
  for (const listID of new Set(listIDs)) {
    const list = store.blocks.get(listID);
    if (!list || list.type !== "columnList") continue;
    for (const col of kids(store, listID)) if (kids(store, col).length === 0) tx.remove(keyOf("block", col));
    const cols = kids(store, listID);
    if (cols.length === 0) tx.remove(keyOf("block", listID));
    else if (cols.length === 1) {
      const inner = kids(store, cols[0]!);
      moveTo(store, tx, inner, list.parent, { kind: "before", id: listID });
      tx.remove(keyOf("block", cols[0]!));
      tx.remove(keyOf("block", listID));
    }
  }
}

/** Spaltenliste, in der ein Block (direkt in einer Spalte) steht. */
function columnListOf(store: WorkspaceStore, id: string): string | undefined {
  const b = store.blocks.get(id);
  const p = b && parentID(b);
  const col = p ? store.blocks.get(p) : undefined;
  if (col?.type !== "column") return undefined;
  return parentID(col);
}

// MARK: Text

/** Text tippen/einfügen (ersetzt die Auswahl). Pro Block zu einem Undo-Schritt zusammengefasst. */
export function insertText(store: WorkspaceStore, c: Caret, text: string, marks?: Marks | null): EditResult {
  const b = blockOf(store, c.id);
  if (!b) return {};
  const next = richInsertText(b.text, c.from, c.to, text, marks);
  store.transact("Typing", (tx) => setText(tx, c.id, next), { coalesce: "text:" + c.id });
  return { caret: at(c, c.from + text.length) };
}

/** Bereich ersetzen durch fertigen RichText (Einfügen mit Formatierung). */
export function replaceRich(store: WorkspaceStore, c: Caret, rich: RichText): EditResult {
  const b = blockOf(store, c.id);
  if (!b) return {};
  store.transact("Paste", (tx) => setText(tx, c.id, richReplace(b.text, c.from, c.to, rich)));
  return { caret: at(c, c.from + richLength(rich)) };
}

/** Mark umschalten (⌘B, ⌘I …) bzw. setzen, wenn `value` angegeben ist. */
export function toggleMark(store: WorkspaceStore, c: Caret, key: MarkKey, value?: unknown): EditResult {
  const b = blockOf(store, c.id);
  if (!b || c.from >= c.to) return { caret: c };
  const next = value === undefined ? richToggleMark(b.text, c.from, c.to, key) : richSetMark(b.text, c.from, c.to, key, value);
  store.transact("Format", (tx) => setText(tx, c.id, next));
  return { caret: c };
}

function previousGrapheme(text: string, pos: number): number {
  const window = text.slice(Math.max(0, pos - 32), pos);
  const g = graphemes(window);
  const last = g[g.length - 1];
  return pos - (last ? last.length : 1);
}
function nextGrapheme(text: string, pos: number): number {
  const g = graphemes(text.slice(pos, pos + 32));
  return pos + (g[0] ? g[0].length : 1);
}

/** ⌫ */
export function deleteBackward(store: WorkspaceStore, pageID: string, c: Caret): EditResult {
  const b = blockOf(store, c.id);
  if (!b) return {};
  if (c.from !== c.to) {
    store.transact("Delete", (tx) => setText(tx, c.id, richReplace(b.text, c.from, c.to, "")), { coalesce: "text:" + c.id });
    return { caret: at(c, c.from) };
  }
  if (c.from > 0) {
    const from = previousGrapheme(richPlain(b.text), c.from);
    store.transact("Delete", (tx) => setText(tx, c.id, richReplace(b.text, from, c.from, "")), { coalesce: "text:" + c.id });
    return { caret: at(c, from) };
  }
  // Am Anfang: erst Typ zu Text, dann ausrücken, dann mit dem vorigen Block zusammenführen (wie Notion)
  if (b.type !== "text" && isTextBlock(b)) {
    store.transact("Turn into text", (tx) => tx.update(c.id, (x) => { x.type = "text"; if (x.props) { delete x.props.checked; delete x.props.toggleable; } }));
    return { caret: c };
  }
  const p = parentID(b);
  const parent = p ? store.blocks.get(p) : undefined;
  if (parent && !CONTAINERS.has(parent.type) && p !== pageID) {
    outdent(store, [c.id]);
    return { caret: c };
  }
  const prevID = neighbour(store, pageID, c.id, -1);
  if (!prevID) return { caret: c };
  const prev = store.blocks.get(prevID)!;
  if (!isTextBlock(prev)) {
    if (richLength(b.text) === 0 && kids(store, c.id).length === 0) {
      store.transact("Delete", (tx) => {
        const list = columnListOf(store, c.id);
        tx.remove(keyOf("block", c.id));
        if (list) cleanupColumns(store, tx, [list]);
      });
    }
    return { select: [prevID] };
  }
  const prevLen = richLength(prev.text);
  store.transact("Merge blocks", (tx) => {
    const list = columnListOf(store, c.id);
    setText(tx, prevID, richConcat(prev.text, b.text));
    const children = kids(store, c.id);
    if (children.length) moveTo(store, tx, children, b.parent, { kind: "before", id: c.id });
    tx.remove(keyOf("block", c.id));
    if (list) cleanupColumns(store, tx, [list]);
  });
  return { caret: { id: prevID, from: prevLen, to: prevLen } };
}

/** ⌦ */
export function deleteForward(store: WorkspaceStore, pageID: string, c: Caret): EditResult {
  const b = blockOf(store, c.id);
  if (!b) return {};
  const len = richLength(b.text);
  if (c.from !== c.to) return deleteBackward(store, pageID, c);
  if (c.from < len) {
    const to = nextGrapheme(richPlain(b.text), c.from);
    store.transact("Delete", (tx) => setText(tx, c.id, richReplace(b.text, c.from, to, "")), { coalesce: "text:" + c.id });
    return { caret: c };
  }
  const nextID = neighbour(store, pageID, c.id, 1);
  const next = nextID ? store.blocks.get(nextID) : undefined;
  if (!next || !nextID) return { caret: c };
  if (!isTextBlock(next)) return { select: [nextID] };
  store.transact("Merge blocks", (tx) => {
    const list = columnListOf(store, nextID);
    setText(tx, c.id, richConcat(b.text, next.text));
    const children = kids(store, nextID);
    if (children.length) moveTo(store, tx, children, next.parent, { kind: "before", id: nextID });
    tx.remove(keyOf("block", nextID));
    if (list) cleanupColumns(store, tx, [list]);
  });
  return { caret: c };
}

/** Enter: Block an der Cursorposition teilen. */
export function splitBlock(store: WorkspaceStore, pageID: string, c: Caret): EditResult {
  const b = blockOf(store, c.id);
  if (!b) return {};
  if (b.type === "code") return insertText(store, c, "\n");
  const len = richLength(b.text);
  // Leerer Listenpunkt: erst ausrücken, dann zu Text (wie Notion)
  if (len === 0 && (CONTINUES.has(b.type) || b.type === "quote")) {
    const p = parentID(b);
    const parent = p ? store.blocks.get(p) : undefined;
    if (parent && !CONTAINERS.has(parent.type) && p !== pageID) return { caret: outdent(store, [c.id]).caret ?? c };
    store.transact("Turn into text", (tx) => tx.update(c.id, (x) => { x.type = "text"; if (x.props) delete x.props.checked; }));
    return { caret: c };
  }
  const type = CONTINUES.has(b.type) ? b.type : "text";
  const props: Block["props"] = b.type === "toggle" ? { isOpen: false } : {};
  // Cursor am Anfang eines nicht leeren Blocks: leeren Block davor einfügen, Inhalt bleibt im selben Block
  if (c.from === 0 && c.to === 0 && len > 0) {
    store.transact("New block", (tx) => {
      makeBlock(store, tx, b.parent, sortKeys(store, b.parent, { kind: "before", id: c.id }, 1)[0]!, type, undefined, props);
    });
    return { caret: { id: c.id, from: 0, to: 0 } };
  }
  const left = richSlice(b.text, 0, c.from);
  const right = richSlice(b.text, c.to);
  let newID = "";
  store.transact("Split block", (tx) => {
    setText(tx, c.id, normalizeRich(left));
    const children = kids(store, c.id);
    const intoChildren = children.length > 0 && childrenVisible(b) && canHaveChildren(b);
    if (intoChildren) {
      const parent = "b:" + c.id;
      newID = makeBlock(store, tx, parent, sortKeys(store, parent, { kind: "before", id: children[0]! }, 1)[0]!, type, normalizeRich(right), props);
    } else {
      newID = makeBlock(store, tx, b.parent, sortKeys(store, b.parent, { kind: "after", id: c.id }, 1)[0]!, type, normalizeRich(right), props);
    }
  });
  return { caret: { id: newID, from: 0, to: 0 } };
}

// MARK: Struktur

/** Nur die obersten der Blöcke (Kinder bereits gewählter fallen weg), in Dokument-Reihenfolge. */
export function topLevel(store: WorkspaceStore, pageID: string, ids: readonly string[]): string[] {
  const set = new Set(ids);
  const isInside = (id: string) => {
    let p = store.blocks.get(id);
    while (p) {
      const pid = parentID(p);
      if (!pid || pid === pageID) return false;
      if (set.has(pid)) return true;
      p = store.blocks.get(pid);
    }
    return false;
  };
  const order = visibleOrder(store, pageID);
  const rank = (id: string) => { const i = order.indexOf(id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  return ids.filter((id) => !isInside(id)).sort((a, b) => rank(a) - rank(b));
}

/** Tab: unter den vorigen Geschwisterblock einrücken. */
export function indent(store: WorkspaceStore, ids: readonly string[], pageID?: string): EditResult {
  const list = pageID ? topLevel(store, pageID, ids) : [...ids];
  if (list.length === 0) return {};
  const first = store.blocks.get(list[0]!);
  if (!first) return {};
  const before = store.children(first.parent).slice(0, store.children(first.parent).indexOf(list[0]!)).filter((k) => !list.includes(k));
  const prevID = before[before.length - 1];
  const prev = prevID ? store.blocks.get(prevID) : undefined;
  if (!prev || !canHaveChildren(prev) || !list.every((id) => store.blocks.get(id)?.parent === first.parent)) return {};
  store.transact("Indent", (tx) => {
    if (prev.type === "toggle" && prev.props?.isOpen !== true) tx.update(prev.id, (x) => { x.props = { ...(x.props ?? {}), isOpen: true }; });
    moveTo(store, tx, list, "b:" + prev.id, { kind: "end" });
  });
  return { select: list };
}

/** ⇧Tab: hinter den Elternblock ausrücken. */
export function outdent(store: WorkspaceStore, ids: readonly string[]): EditResult {
  const first = ids[0] ? store.blocks.get(ids[0]) : undefined;
  const pid = first && parentID(first);
  const parent = pid ? store.blocks.get(pid) : undefined;
  if (!first || !parent || CONTAINERS.has(parent.type) || !ids.every((id) => store.blocks.get(id)?.parent === first.parent)) return {};
  store.transact("Outdent", (tx) => moveTo(store, tx, ids, parent.parent, { kind: "after", id: parent.id }));
  return { caret: { id: ids[0]!, from: 0, to: 0 }, select: [...ids] };
}

/** Turn into: Typ ändern, Text bleibt. */
export function turnInto(store: WorkspaceStore, ids: readonly string[], type: string, props: Block["props"] = {}): EditResult {
  store.transact("Turn into", (tx) => {
    for (const id of ids) {
      tx.update(id, (x) => {
        x.type = type;
        const p = { ...(x.props ?? {}) };
        if (type !== "todo") delete p.checked;
        if (type === "code") {
          // Code hat keine Formatierung
          x.text = richPlain(x.text).replace(/￼/g, "");
          if (!x.text) delete x.text;
        }
        Object.assign(p, props);
        if (Object.keys(p).length) x.props = p;
        else delete x.props;
      });
    }
  });
  return { select: [...ids] };
}

/** Props setzen (Häkchen, Toggle auf/zu, Farbe, Sprache …). */
export function setProps(store: WorkspaceStore, ids: readonly string[], patch: Partial<NonNullable<Block["props"]>>, name = "Change block"): void {
  store.transact(name, (tx) => {
    for (const id of ids) tx.update(id, (x) => {
      const p: Record<string, unknown> = { ...(x.props ?? {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete p[k];
        else p[k] = v;
      }
      if (Object.keys(p).length) x.props = p as Block["props"];
      else delete x.props;
    });
  });
}

/** Neuen Block einfügen: nach `after` (Geschwister) oder am Ende von `parent`. */
export function insertBlock(store: WorkspaceStore, opts: { after?: string; parent?: string; type: string; text?: RichText; props?: Block["props"] }): string {
  let id = "";
  store.transact("New block", (tx) => {
    if (opts.after) {
      const a = store.blocks.get(opts.after)!;
      id = makeBlock(store, tx, a.parent, sortKeys(store, a.parent, { kind: "after", id: a.id }, 1)[0]!, opts.type, opts.text, opts.props);
    } else {
      const parent = "b:" + opts.parent;
      id = makeBlock(store, tx, parent, sortKeys(store, parent, { kind: "end" }, 1)[0]!, opts.type, opts.text, opts.props);
    }
  });
  return id;
}

/** Blöcke löschen (Seiten/Datenbanken in den Papierkorb), leere Spalten aufräumen. */
export function deleteBlocks(store: WorkspaceStore, ids: readonly string[]): void {
  const lists = ids.map((id) => columnListOf(store, id)).filter((x): x is string => x !== undefined);
  store.deleteBlocks([...ids]);
  if (lists.length) store.transact("Delete", (tx) => cleanupColumns(store, tx, lists), { coalesce: "delete-cleanup" });
}

/** Blöcke mit Inhalt kopieren und direkt dahinter einfügen (Seiten und Datenbanken werden nicht mitkopiert). */
export function duplicateBlocks(store: WorkspaceStore, ids: readonly string[]): string[] {
  const out: string[] = [];
  store.transact("Duplicate", (tx) => {
    const last = ids[ids.length - 1]!;
    const lastBlock = store.blocks.get(last)!;
    const keys = sortKeys(store, lastBlock.parent, { kind: "after", id: last }, ids.length);
    const copy = (id: string, parent: string, sk: string): string | undefined => {
      const b = store.blocks.get(id);
      if (!b || store.isTrashable(b)) return undefined;
      const nid = makeBlock(store, tx, parent, sk, b.type, b.text, b.props ? structuredClone(b.props) : undefined);
      const children = kids(store, id);
      const ck = keysBetween(children.length, undefined, undefined);
      children.forEach((k, i) => copy(k, "b:" + nid, ck[i]!));
      return nid;
    };
    ids.forEach((id, i) => { const n = copy(id, lastBlock.parent, keys[i]!); if (n) out.push(n); });
  });
  return out;
}

export type DropSide = "before" | "after" | "inside" | "left" | "right";

/** Ist `id` gleich `ancestor` oder liegt darin? */
function within(store: WorkspaceStore, id: string, ancestor: string): boolean {
  let cur: Block | undefined = store.blocks.get(id);
  while (cur) {
    if (cur.id === ancestor) return true;
    const p = parentID(cur);
    cur = p ? store.blocks.get(p) : undefined;
  }
  return false;
}

/** Blöcke verschieben (Ziehen, ⌘⇧↑/↓, „Move to“ auf derselben Seite). `left`/`right` legen Spalten an. */
export function moveBlocks(store: WorkspaceStore, ids: readonly string[], targetID: string, side: DropSide): boolean {
  const target = store.blocks.get(targetID);
  if (!target || ids.length === 0 || ids.some((id) => within(store, targetID, id))) return false;
  if (side === "inside" && !canHaveChildren(target)) side = "after";
  const sourceLists = ids.map((id) => columnListOf(store, id)).filter((x): x is string => x !== undefined);
  store.transact("Move blocks", (tx) => {
    if (side === "before" || side === "after") moveTo(store, tx, ids, target.parent, { kind: side, id: targetID });
    else if (side === "inside") {
      if (target.type === "toggle" && target.props?.isOpen !== true) tx.update(targetID, (x) => { x.props = { ...(x.props ?? {}), isOpen: true }; });
      moveTo(store, tx, ids, "b:" + targetID, { kind: "end" });
    } else {
      const tp = parentID(target);
      const col = tp ? store.blocks.get(tp) : undefined;
      if (col?.type === "column") {
        // Ziel steht in einer Spalte: neue Spalte daneben in derselben Liste
        const colID = makeBlock(store, tx, col.parent, sortKeys(store, col.parent, { kind: side === "left" ? "before" : "after", id: col.id }, 1)[0]!, "column");
        moveTo(store, tx, ids, "b:" + colID, { kind: "end" });
        // Breiten zurücksetzen, damit alle Spalten gleich breit sind
        for (const c of kids(store, col.parent.slice(2))) tx.update(c, (x) => { if (x.props) { delete x.props.ratio; if (!Object.keys(x.props).length) delete x.props; } });
      } else {
        // Ziel an seiner Stelle durch eine Spaltenliste mit zwei Spalten ersetzen
        const listID = makeBlock(store, tx, target.parent, sortKeys(store, target.parent, { kind: "before", id: targetID }, 1)[0]!, "columnList");
        const [k1, k2] = keysBetween(2, undefined, undefined);
        const moved = makeBlock(store, tx, "b:" + listID, side === "left" ? k1! : k2!, "column");
        const kept = makeBlock(store, tx, "b:" + listID, side === "left" ? k2! : k1!, "column");
        moveTo(store, tx, [targetID], "b:" + kept, { kind: "end" });
        moveTo(store, tx, ids, "b:" + moved, { kind: "end" });
      }
    }
    cleanupColumns(store, tx, sourceLists);
  });
  return true;
}

/** ⌘⇧↑ / ⌘⇧↓: Blöcke um eine Stelle unter ihren Geschwistern verschieben. */
export function nudgeBlocks(store: WorkspaceStore, ids: readonly string[], dir: -1 | 1): boolean {
  const first = store.blocks.get(ids[0]!);
  if (!first) return false;
  const sib = store.children(first.parent);
  const idx = sib.indexOf(dir < 0 ? ids[0]! : ids[ids.length - 1]!);
  const other = sib[idx + dir];
  if (!other) return false;
  return moveBlocks(store, ids, other, dir < 0 ? "before" : "after");
}

// MARK: Markdown-Kürzel

/**
 * Inline-Markdown nach dem Tippen des schließenden Zeichens: **fett**, *kursiv* bzw. _kursiv_, `Code`, ~~durch~~.
 * Die Zeichen werden entfernt, der Text bekommt die Mark; der Cursor steht dahinter (ohne Mark weiterschreiben).
 */
export function applyInlineMarkdown(store: WorkspaceStore, c: Caret): EditResult | undefined {
  const b = blockOf(store, c.id);
  if (!b || b.type === "code" || c.from !== c.to) return undefined;
  const head = richPlain(b.text).slice(0, c.from);
  const rules: { re: RegExp; open: number; close: number; mark: MarkKey }[] = [
    { re: /\*\*([^*\uFFFC]+)\*\*$/, open: 2, close: 2, mark: "b" },
    { re: /~~([^~\uFFFC]+)~~$/, open: 2, close: 2, mark: "s" },
    { re: /`([^`\uFFFC]+)`$/, open: 1, close: 1, mark: "c" },
    { re: /(?:^|[^*\w])\*([^*\s\uFFFC][^*\uFFFC]*)\*$/, open: 1, close: 1, mark: "i" },
    { re: /(?:^|[^_\w])_([^_\s\uFFFC][^_\uFFFC]*)_$/, open: 1, close: 1, mark: "i" },
  ];
  for (const r of rules) {
    const m = r.re.exec(head);
    if (!m) continue;
    const inner = m[1]!;
    const end = c.from;
    const start = end - r.close - inner.length - r.open;
    let t: RichText = richReplace(b.text, end - r.close, end, "");
    t = richReplace(t, start, start + r.open, "");
    t = richSetMark(t, start, start + inner.length, r.mark, true);
    store.transact("Format", (tx) => setText(tx, c.id, t));
    const pos = start + inner.length;
    return { caret: { id: c.id, from: pos, to: pos } };
  }
  return undefined;
}

const SHORTCUTS: readonly { prefix: string; type: string; props?: Block["props"] }[] = [
  { prefix: "# ", type: "heading1" }, { prefix: "## ", type: "heading2" }, { prefix: "### ", type: "heading3" },
  { prefix: "- ", type: "bulletedList" }, { prefix: "* ", type: "bulletedList" }, { prefix: "+ ", type: "bulletedList" },
  { prefix: "1. ", type: "numberedList" }, { prefix: "a. ", type: "numberedList" }, { prefix: "i. ", type: "numberedList" },
  { prefix: "[] ", type: "todo" }, { prefix: "[ ] ", type: "todo" }, { prefix: "[x] ", type: "todo", props: { checked: true } },
  { prefix: "> ", type: "toggle" }, { prefix: "\" ", type: "quote" }, { prefix: "| ", type: "quote" },
];

/**
 * Nach dem Tippen eines Leerzeichens: passt der Anfang eines Textblocks zu einem Kürzel, wird der Block umgewandelt
 * und das Kürzel entfernt. `---` wird ein Trenner, ``` ein Codeblock. Liefert undefined, wenn nichts passt.
 */
export function applyMarkdownShortcut(store: WorkspaceStore, c: Caret): EditResult | undefined {
  const b = blockOf(store, c.id);
  if (!b || !isTextBlock(b) || b.type === "code" || c.from !== c.to) return undefined;
  const plain = richPlain(b.text);
  const head = plain.slice(0, c.from);
  if ((head === "---" || head === "```") && b.type === "text") {
    const type = head === "---" ? "divider" : "code";
    store.transact("Turn into", (tx) => {
      if (type === "divider") {
        tx.update(c.id, (x) => { x.type = "divider"; delete x.text; });
        makeBlock(store, tx, b.parent, sortKeys(store, b.parent, { kind: "after", id: c.id }, 1)[0]!, "text");
      } else tx.update(c.id, (x) => { x.type = "code"; const rest = plain.slice(c.from); if (rest) x.text = rest; else delete x.text; });
    });
    if (type === "divider") {
      const next = store.children(b.parent)[store.children(b.parent).indexOf(c.id) + 1];
      return next ? { caret: { id: next, from: 0, to: 0 } } : { caret: c };
    }
    return { caret: { id: c.id, from: 0, to: 0 } };
  }
  const hit = SHORTCUTS.find((s) => s.prefix === head);
  if (!hit) return undefined;
  store.transact("Turn into", (tx) => tx.update(c.id, (x) => {
    x.type = hit.type;
    const rest = richSlice(x.text, hit.prefix.length);
    const t = normalizeRich(rest);
    if (richLength(t) > 0) x.text = t;
    else delete x.text;
    if (hit.props) x.props = { ...(x.props ?? {}), ...hit.props };
  }));
  return { caret: { id: c.id, from: 0, to: 0 } };
}
