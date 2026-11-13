// BSD-382 (ADR 0016, E1): Befehle des neuen Block-Editors – Text setzen und formatieren, teilen (Enter),
// zusammenführen (⌫ am Anfang, Entf am Ende), ein-/ausrücken, Turn into (+ Markdown-Kürzel), verschieben (vor/nach/
// hinein/Spalte), Spalten auflösen, löschen, duplizieren. Clean-Room nach ADR 0016 und der öffentlichen Notion-Hilfe.
//
// Regeln für alle Befehle:
//  - Ein Befehl = eine `store.transact` = ein Undo-Schritt (Tippen in einem Block wird wie bisher zusammengefasst).
//  - Rückgabe = der neue Fokus `{ blockId, offset }` / `{ blockId, range }` / `{ blockId, selected }`, oder
//    `undefined`, wenn der Befehl hier nichts tut (dann gibt es auch keine Transaktion).
//  - Nur bestehende Records, RichText und Sortierschlüssel; kein neues Datenformat.
import type { Block, BlockProps, RichText } from "../../model/records.js";
import { keyBetween } from "../../sortkeys.js";
import { makeBlock } from "../../interop/builder.js";
import { copyTree, isPageLike, sortKeys } from "../../store/pages.js";
import type { Tx, WorkspaceStore } from "../../store/store.js";
import {
  blockText, clampRange, concatRuns, hasMark, plainRuns, replaceRuns, runsLength, runsOf, setMark, splitRuns, type MarkKey, type Marks, type Run,
} from "./text.js";
import {
  canNestUnder, CONTINUING_TYPES, isCollapsed, isHeading, isInside, isTextBlock, isToggle, liveChildren, nextVisible, parentBlockID,
  previousVisible, siblings, topLevel, TEXT_TYPES,
} from "./tree.js";

// MARK: Fokus

export type Focus =
  | { blockId: string; offset: number }
  | { blockId: string; range: { from: number; to: number } }
  /** Ein Block ohne Textfeld (Bild, Trenner, Datenbank) ist als Ganzes ausgewählt. */
  | { blockId: string; selected: true };

const at = (blockId: string, offset: number): Focus => ({ blockId, offset });

/** Ein Textbereich in einem Block. */
export interface TextRange {
  blockId: string;
  from: number;
  to: number;
}

export const newBlockID = () => globalThis.crypto.randomUUID().toUpperCase();

// MARK: Hilfen in der Transaktion

function textOf(b: Block | undefined): Run[] {
  return runsOf(b?.text);
}

function writeText(tx: Tx, id: string, runs: readonly Run[]) {
  tx.update(id, (x) => {
    const t = blockText(x.type === "code" ? plainRuns(runs) : runs);
    if (t === undefined) delete x.text;
    else x.text = t;
  });
}

/** Props, die beim Typwechsel nicht mitgehen (nur für den alten Typ sinnvoll). */
function propsFor(type: string, props: BlockProps | undefined, keep: BlockProps = {}): BlockProps | undefined {
  const p: BlockProps = { ...(props ?? {}) };
  if (type !== "todo") delete p.checked;
  if (type !== "code") { delete p.language; delete p.wrap; }
  if (!isHeading(type)) delete p.toggleable;
  if (type !== "callout") delete p.icon;
  if (!isToggle({ type, props: { ...p, ...keep } } as Block)) delete p.isOpen;
  Object.assign(p, keep);
  for (const k of Object.keys(p)) if ((p as Record<string, unknown>)[k] === undefined) delete (p as Record<string, unknown>)[k];
  return Object.keys(p).length ? p : undefined;
}

function create(store: WorkspaceStore, tx: Tx, type: string, parent: string, sk: string, runs: readonly Run[] = [], props?: BlockProps): string {
  const id = newBlockID();
  tx.put({ kind: "block", data: makeBlock({ id, type, parent, sk, text: blockText(type === "code" ? plainRuns(runs) : runs), props, createdBy: store.userID }, store.now()) });
  return id;
}

/** Blöcke in Reihenfolge unter `parent` an `position` hängen (ein Schlüssel je Block, die bewegten zählen nicht). */
function place(store: WorkspaceStore, tx: Tx, ids: readonly string[], parent: string, position: { kind: "end" } | { kind: "before" | "after"; id: string } | { kind: "start" }) {
  if (ids.length === 0) return;
  const moving = new Set(ids);
  let keys: string[];
  if (position.kind === "start") {
    const first = store.children(parent).find((c) => !moving.has(c));
    keys = first ? sortKeys(store, parent, { kind: "before", id: first }, ids.length, moving) : sortKeys(store, parent, { kind: "end" }, ids.length, moving);
  } else keys = sortKeys(store, parent, position, ids.length, moving);
  ids.forEach((id, i) => tx.update(id, (b) => {
    b.parent = parent;
    b.sk = keys[i]!;
    // Eine Inline-Datenbank oben im Workspace wäre eine Seite; in einem Block bleibt sie inline (wie Swift).
  }));
}

/** Nach dem Verschieben/Löschen: leere Spalten weg, eine Spaltenliste mit nur noch einer Spalte auflösen. */
function tidyColumns(store: WorkspaceStore, tx: Tx, columnListIDs: Iterable<string>) {
  for (const listID of new Set(columnListIDs)) {
    const list = store.blocks.get(listID);
    if (!list || list.type !== "columnList") continue;
    const empty = liveChildren(store, listID).filter((col) => store.blocks.get(col)?.type === "column" && store.children("b:" + col).length === 0);
    if (empty.length > 0) store.deleteBlocksIn(tx, empty);
    const cols = liveChildren(store, listID);
    if (cols.length <= 1) dissolveIn(store, tx, listID);
    else if (empty.length > 0) for (const c of cols) clearRatio(tx, c);
  }
}

/** Gespeicherte Breite einer Spalte weg (dann teilen sich die Spalten die Breite gleichmäßig). */
function clearRatio(tx: Tx, id: string) {
  tx.update(id, (x) => {
    if (!x.props || x.props.ratio === undefined) return;
    delete x.props.ratio;
    if (Object.keys(x.props).length === 0) delete x.props;
  });
}

/** Spaltenliste auflösen: Inhalt aller Spalten in Lesereihenfolge an ihre Stelle, Spalten und Liste weg. */
function dissolveIn(store: WorkspaceStore, tx: Tx, listID: string) {
  const list = store.blocks.get(listID);
  if (!list) return;
  const content = store.children("b:" + listID).flatMap((col) => store.children("b:" + col));
  place(store, tx, content, list.parent, { kind: "before", id: listID });
  store.deleteBlocksIn(tx, [listID]);
}

function columnListOf(store: WorkspaceStore, id: string): string | undefined {
  const b = store.blocks.get(id);
  const colID = b ? parentBlockID(b) : undefined;
  const col = colID ? store.blocks.get(colID) : undefined;
  if (col?.type !== "column") return undefined;
  const listID = parentBlockID(col);
  return listID && store.blocks.get(listID)?.type === "columnList" ? listID : undefined;
}

// MARK: Text

export interface ReplaceTextOptions {
  /** Marks für eingefügten Text; sonst die an der Einfügestelle. */
  marks?: Marks;
  /** Undo-Zusammenfassung; Standard: Tippen pro Block (`text:<id>`). `null` = eigener Schritt. */
  coalesce?: string | null;
}

/** Text in einem Block ersetzen (Tippen, Löschen im Block, IME-Ergebnis). Fokus hinter dem eingefügten Text. */
export function replaceText(store: WorkspaceStore, range: TextRange, insert: string | readonly Run[], opts: ReplaceTextOptions = {}): Focus | undefined {
  const b = store.blocks.get(range.blockId);
  if (!b || !isTextBlock(b)) return undefined;
  const runs = textOf(b);
  const [from, to] = clampRange(runsLength(runs), range.from, range.to);
  const next = replaceRuns(runs, from, to, insert, opts.marks);
  const added = typeof insert === "string" ? insert.length : runsLength([...insert]);
  const coalesce = opts.coalesce === null ? undefined : opts.coalesce ?? "text:" + b.id;
  store.transact("Typing", (tx) => writeText(tx, b.id, next), coalesce === undefined ? {} : { coalesce });
  return at(b.id, from + added);
}

/** Ganzen Text eines Blocks setzen (z. B. nach IME-Komposition oder Rechtschreibkorrektur). */
export function setBlockText(store: WorkspaceStore, blockId: string, text: RichText | undefined, caret?: number): Focus | undefined {
  const b = store.blocks.get(blockId);
  if (!b || !isTextBlock(b)) return undefined;
  const runs = runsOf(text);
  store.transact("Typing", (tx) => writeText(tx, blockId, runs), { coalesce: "text:" + blockId });
  return at(blockId, caret ?? runsLength(runs));
}

/**
 * Formatieren über einen oder mehrere Bereiche (Textauswahl über Blöcke, E3). `value` weggelassen = umschalten wie
 * ⌘B (überall gesetzt → weg, sonst an); `false` = entfernen; Farbe/Link mit Wert setzen.
 */
export function formatText(store: WorkspaceStore, ranges: readonly TextRange[], key: MarkKey, value?: string | boolean): Focus | undefined {
  const live = ranges.filter((r) => isTextBlock(store.blocks.get(r.blockId)) && store.blocks.get(r.blockId)!.type !== "code" && r.from !== r.to);
  if (live.length === 0) return undefined;
  const v = value ?? (live.every((r) => hasMark(textOf(store.blocks.get(r.blockId)), Math.min(r.from, r.to), Math.max(r.from, r.to), key)) ? undefined : true);
  store.transact("Format", (tx) => {
    for (const r of live) writeText(tx, r.blockId, setMark(textOf(store.blocks.get(r.blockId)), r.from, r.to, key, v));
  });
  const last = live[live.length - 1]!;
  return { blockId: last.blockId, range: { from: Math.min(last.from, last.to), to: Math.max(last.from, last.to) } };
}

// MARK: Teilen (Enter)

/**
 * Enter. Text ab `from` (bis `to` wird vorher gelöscht) geht in einen neuen Block darunter. Regeln (Notion-Hilfe):
 *  - Listen, To-dos und Toggles setzen sich fort (To-do neu unabgehakt); am Ende einer Überschrift/eines Zitats
 *    kommt ein Textblock; mitten im Block behält der zweite Teil den Typ.
 *  - Leerer Listen-/To-do-/Toggle-Block: eingerückt → ausrücken, sonst wird er Text.
 *  - Am Anfang eines nicht leeren Blocks: leerer Block davor, der Inhalt (und seine ID) bleibt.
 *  - Hat der Block sichtbare Kinder (offenes Toggle, Liste mit Unterpunkten, Callout), wird der neue Block ihr erstes Kind.
 *  - Code-Block: Zeilenumbruch im Block.
 */
export function splitBlock(store: WorkspaceStore, blockId: string, from: number, to: number = from): Focus | undefined {
  const b = store.blocks.get(blockId);
  if (!b || !isTextBlock(b)) return undefined;
  if (b.type === "code") return replaceText(store, { blockId, from, to }, "\n", { coalesce: null });
  const runs = textOf(b);
  const [a, z] = clampRange(runsLength(runs), from, to);
  const cut = replaceRuns(runs, a, z, "");
  const [left, right] = splitRuns(cut, a);
  const empty = runsLength(cut) === 0;

  if (empty && CONTINUING_TYPES.has(b.type) && liveChildren(store, b.id).length === 0) {
    const parent = parentBlockID(b);
    if (parent && canNestUnder(store.blocks.get(parent)) && CONTINUING_TYPES.has(store.blocks.get(parent)!.type)) {
      return outdentBlocks(store, [b.id], 0);
    }
    return turnInto(store, [b.id], "text");
  }

  return store.transact("Split block", (tx) => {
    // Am Anfang: leerer Block davor, Inhalt bleibt im bestehenden Block.
    if (a === 0 && runsLength(left) === 0 && !empty) {
      if (z > a) writeText(tx, b.id, cut);
      const type = CONTINUING_TYPES.has(b.type) ? b.type : "text";
      const sk = sortKeys(store, b.parent, { kind: "before", id: b.id }, 1)[0]!;
      create(store, tx, type, b.parent, sk, [], propsFor(type, b.props, type === "todo" ? { checked: undefined } : {}));
      return at(b.id, 0);
    }
    writeText(tx, b.id, left);
    const atEnd = runsLength(right) === 0;
    let type = b.type;
    if (b.type === "callout") type = "text";
    else if (atEnd && !CONTINUING_TYPES.has(b.type)) type = "text";
    const props = type === b.type ? propsFor(type, b.props, { checked: undefined, isOpen: undefined }) : undefined;
    const kids = liveChildren(store, b.id);
    const intoChildren = b.type === "callout" || (kids.length > 0 && !isCollapsed(b));
    let id: string;
    if (intoChildren) {
      const sk = sortKeys(store, "b:" + b.id, kids.length ? { kind: "before", id: kids[0]! } : { kind: "end" }, 1)[0]!;
      id = create(store, tx, type, "b:" + b.id, sk, right, props);
    } else {
      const sk = sortKeys(store, b.parent, { kind: "after", id: b.id }, 1)[0]!;
      id = create(store, tx, type, b.parent, sk, right, props);
    }
    return at(id, 0);
  });
}

// MARK: Zusammenführen (⌫ am Anfang, Entf am Ende)

/**
 * ⌫ am Anfang eines Blocks (Notion): ein Nicht-Textblock (Liste, Überschrift, Zitat …) wird zuerst Text. Ein Textblock
 * wandert mit seinem Text ans Ende des Blocks darüber; seine Kinder gehen mit (unter den Block darüber, wenn der Kinder
 * haben kann, sonst an die Stelle des gelöschten Blocks). Steht darüber ein Block ohne Text (Bild, Trenner …), wird ein
 * leerer Block gelöscht und der Block darüber ausgewählt; ein voller bleibt und der Block darüber wird ausgewählt.
 */
export function mergeBackward(store: WorkspaceStore, blockId: string): Focus | undefined {
  const b = store.blocks.get(blockId);
  if (!b || !isTextBlock(b)) return undefined;
  if (b.type !== "text") return turnInto(store, [b.id], "text");
  const prevID = previousVisible(store, b.id);
  if (!prevID) return undefined;
  const prev = store.blocks.get(prevID)!;
  const runs = textOf(b);
  if (!isTextBlock(prev)) {
    if (runsLength(runs) > 0 || liveChildren(store, b.id).length > 0) return { blockId: prevID, selected: true };
    return store.transact("Delete", (tx) => {
      store.deleteBlocksIn(tx, [b.id]);
      tidyColumns(store, tx, [columnListOf(store, prevID)].filter((x): x is string => !!x));
      return { blockId: prevID, selected: true } as Focus;
    });
  }
  return store.transact("Merge blocks", (tx) => mergeInto(store, tx, prev, b));
}

/** Entf am Ende: der Block darunter wird an diesen angehängt (ohne Typwechsel). */
export function mergeForward(store: WorkspaceStore, blockId: string): Focus | undefined {
  const b = store.blocks.get(blockId);
  if (!b || !isTextBlock(b)) return undefined;
  const nextID = nextVisible(store, b.id);
  const next = nextID ? store.blocks.get(nextID) : undefined;
  if (!next) return undefined;
  if (!isTextBlock(next)) return { blockId: next.id, selected: true };
  // Ein Kind zieht man nicht in sein eigenes Elternteil hoch, wenn es selbst Kinder hat: die gingen sonst eine Ebene hoch.
  return store.transact("Merge blocks", (tx) => mergeInto(store, tx, b, next));
}

function mergeInto(store: WorkspaceStore, tx: Tx, target: Block, source: Block): Focus {
  const targetRuns = textOf(target);
  const caret = runsLength(targetRuns);
  writeText(tx, target.id, concatRuns(targetRuns, textOf(source)));
  const kids = liveChildren(store, source.id);
  if (kids.length > 0) {
    if (canNestUnder(store.blocks.get(target.id)) && !isInside(store, target.id, source.id)) {
      // Unter den Ziel-Block, hinter dessen Kinder (ist das Ziel das Elternteil, an die Stelle des Quell-Blocks).
      if (source.parent === "b:" + target.id) place(store, tx, kids, "b:" + target.id, { kind: "after", id: source.id });
      else place(store, tx, kids, "b:" + target.id, { kind: "end" });
      if (isCollapsed(store.blocks.get(target.id)!)) tx.update(target.id, (x) => { x.props = { ...(x.props ?? {}), isOpen: true }; });
    } else place(store, tx, kids, source.parent, { kind: "after", id: source.id });
  }
  const list = columnListOf(store, source.id);
  store.deleteBlocksIn(tx, [source.id]);
  if (list) tidyColumns(store, tx, [list]);
  return at(target.id, caret);
}

// MARK: Einrücken / Ausrücken (Tab, ⇧Tab)

/**
 * Tab: jeder Block wird letztes Kind des Blocks über ihm auf derselben Ebene (der muss Kinder haben können; ein
 * zugeklapptes Toggle wird dabei aufgeklappt). Mehrere ausgewählte Blöcke rücken gemeinsam ein.
 */
export function indentBlocks(store: WorkspaceStore, ids: readonly string[], offset = 0): Focus | undefined {
  const roots = topLevel(store, ids);
  if (roots.length === 0) return undefined;
  // Pro Folge benachbarter Geschwister ein Ziel: der Block vor der Folge.
  const groups: { target: string; ids: string[] }[] = [];
  for (const id of roots) {
    const b = store.blocks.get(id)!;
    const sibs = siblings(store, b);
    const i = sibs.indexOf(id);
    const last = groups[groups.length - 1];
    if (last && i > 0 && last.ids[last.ids.length - 1] === sibs[i - 1]) { last.ids.push(id); continue; }
    if (i <= 0 || !canNestUnder(store.blocks.get(sibs[i - 1]!))) continue;
    groups.push({ target: sibs[i - 1]!, ids: [id] });
  }
  if (groups.length === 0) return undefined;
  store.transact("Indent", (tx) => {
    for (const g of groups) {
      place(store, tx, g.ids, "b:" + g.target, { kind: "end" });
      const t = store.blocks.get(g.target)!;
      if (isCollapsed(t)) tx.update(t.id, (x) => { x.props = { ...(x.props ?? {}), isOpen: true }; });
    }
  });
  return at(roots[0]!, offset);
}

/**
 * ⇧Tab: der Block kommt eine Ebene höher direkt hinter sein Elternteil; die Geschwister unter ihm werden seine Kinder
 * (die Lesereihenfolge bleibt, wie in einer Gliederung). Oben in Seite oder Spalte passiert nichts.
 */
export function outdentBlocks(store: WorkspaceStore, ids: readonly string[], offset = 0): Focus | undefined {
  const roots = topLevel(store, ids).filter((id) => {
    const b = store.blocks.get(id)!;
    const p = parentBlockID(b);
    return p !== undefined && canNestUnder(store.blocks.get(p));
  });
  if (roots.length === 0) return undefined;
  store.transact("Outdent", (tx) => {
    // Von hinten nach vorn: so bleiben die Positionen der übrigen gültig.
    for (const id of [...roots].reverse()) {
      const b = store.blocks.get(id)!;
      const parent = store.blocks.get(parentBlockID(b)!)!;
      const sibs = siblings(store, b);
      const after = sibs.slice(sibs.indexOf(id) + 1).filter((s) => !roots.includes(s));
      if (after.length > 0 && canNestUnder(b)) place(store, tx, after, "b:" + id, { kind: "end" });
      // Kann der Block keine Kinder haben (z. B. Überschrift), bleiben die Geschwister unter dem alten Elternteil.
      place(store, tx, [id], parent.parent, { kind: "after", id: parent.id });
    }
  });
  return at(roots[0]!, offset);
}

// MARK: Turn into

/**
 * Typ ändern (Turn into, Markdown-Kürzel). Text und Kinder bleiben; Props des alten Typs fallen weg. Code verliert
 * die Formatierung. Typen ohne Kinder (Code, Überschrift ohne Toggle) geben ihre Kinder als Geschwister dahinter ab.
 */
export function turnInto(store: WorkspaceStore, ids: readonly string[], type: string, props: BlockProps = {}): Focus | undefined {
  if (!TEXT_TYPES.has(type)) return undefined;
  const targets = ids.filter((id) => isTextBlock(store.blocks.get(id)));
  if (targets.length === 0) return undefined;
  store.transact("Turn into", (tx) => {
    for (const id of targets) {
      const b = store.blocks.get(id)!;
      const runs = textOf(b);
      tx.update(id, (x) => {
        x.type = type as Block["type"];
        const p = propsFor(type, x.props, props);
        if (p) x.props = p;
        else delete x.props;
      });
      if (type === "code") writeText(tx, id, runs);
      const nb = store.blocks.get(id)!;
      const kids = liveChildren(store, id);
      if (kids.length > 0 && !canNestUnder(nb)) place(store, tx, kids, nb.parent, { kind: "after", id });
    }
  });
  const first = store.blocks.get(targets[0]!)!;
  return at(first.id, runsLength(textOf(first)));
}

/** Markdown-Kürzel am Blockanfang (Notion-Hilfe „Markdown & shortcuts“). Ergebnis: Typ, Props und die Länge des Kürzels. */
export function markdownShortcut(prefix: string): { type: string; props?: BlockProps } | undefined {
  switch (prefix) {
    case "# ": return { type: "heading1" };
    case "## ": return { type: "heading2" };
    case "### ": return { type: "heading3" };
    case "#### ": return { type: "heading4" };
    case "- ": case "* ": case "+ ": return { type: "bulletedList" };
    case "[] ": case "[ ] ": return { type: "todo" };
    case "[x] ": case "[X] ": return { type: "todo", props: { checked: true } };
    case "> ": return { type: "toggle" };
    case "\" ": case "| ": return { type: "quote" };
    case "```": return { type: "code" };
    case "---": return { type: "divider" };
  }
  if (/^(\d{1,3}|[a-z]|[ivx]{1,4})\. $/i.test(prefix)) return { type: "numberedList" };
  return undefined;
}

/**
 * Nach einer Eingabe am Blockanfang: ist der Text vor der Schreibmarke (`offset`) ein Kürzel, wird der Block
 * umgewandelt und das Kürzel entfernt (ein Undo-Schritt; ⌘Z danach stellt Text und Typ wieder her). `---` macht aus
 * einem sonst leeren Block einen Trenner und darunter einen neuen Textblock.
 */
export function applyMarkdownShortcut(store: WorkspaceStore, blockId: string, offset: number): Focus | undefined {
  const b = store.blocks.get(blockId);
  if (!b || !isTextBlock(b) || b.type === "code") return undefined;
  const runs = textOf(b);
  const plain = runs.map((r) => r.t).join("");
  if (offset <= 0 || offset > plain.length) return undefined;
  const hit = markdownShortcut(plain.slice(0, offset));
  if (!hit) return undefined;
  if (hit.type === b.type && hit.props === undefined) return undefined;
  const rest = replaceRuns(runs, 0, offset, "");
  if (hit.type === "divider") {
    if (runsLength(rest) > 0 || liveChildren(store, b.id).length > 0) return undefined;
    return store.transact("Turn into", (tx) => {
      tx.update(b.id, (x) => { x.type = "divider"; delete x.text; delete x.props; });
      const sk = sortKeys(store, b.parent, { kind: "after", id: b.id }, 1)[0]!;
      return at(create(store, tx, "text", b.parent, sk), 0);
    });
  }
  if (hit.type === "code" && b.type !== "text") return undefined;
  store.transact("Turn into", (tx) => {
    tx.update(b.id, (x) => {
      x.type = hit.type as Block["type"];
      const p = propsFor(hit.type, x.props, hit.props ?? {});
      if (p) x.props = p;
      else delete x.props;
    });
    writeText(tx, b.id, rest);
    const nb = store.blocks.get(b.id)!;
    const kids = liveChildren(store, b.id);
    if (kids.length > 0 && !canNestUnder(nb)) place(store, tx, kids, nb.parent, { kind: "after", id: b.id });
  });
  return at(b.id, 0);
}

// MARK: Verschieben (Ziehen, ⌘⇧↑/↓)

/** Wohin: davor, dahinter, als erstes Kind („eingerückt“), oder als Spalte links/rechts neben dem Ziel. */
export type DropZone = "before" | "after" | "inside" | "left" | "right";

/**
 * Blöcke an ein Ziel bewegen. Kinder gehen mit; ausgewählte Kinder ausgewählter Blöcke zählen nicht doppelt. Ein
 * Block kann nicht in sich selbst. Spalte: liegt das Ziel schon in einer Spalte, kommt eine neue Spalte daneben in
 * dieselbe Liste, sonst entsteht an der Stelle des Ziels eine Spaltenliste [Ziel | Blöcke]. Leer gewordene Spalten
 * verschwinden, eine Liste mit nur noch einer Spalte wird aufgelöst.
 */
export function moveBlocks(store: WorkspaceStore, ids: readonly string[], targetId: string, zone: DropZone): Focus | undefined {
  const target = store.blocks.get(targetId);
  if (!target) return undefined;
  const roots = topLevel(store, ids).filter((id) => !isInside(store, targetId, id));
  if (roots.length === 0 || (roots.length === 1 && roots[0] === targetId)) return undefined;
  if (zone === "inside" && !canNestUnder(target) && target.type !== "column") return undefined;
  if ((zone === "left" || zone === "right") && (target.type === "column" || target.type === "columnList")) return undefined;
  const sourceLists = roots.map((id) => columnListOf(store, id)).filter((x): x is string => !!x);
  store.transact(roots.length === 1 ? "Move block" : `Move ${roots.length} blocks`, (tx) => {
    switch (zone) {
      case "before": place(store, tx, roots, target.parent, { kind: "before", id: targetId }); break;
      case "after": place(store, tx, roots, target.parent, { kind: "after", id: targetId }); break;
      case "inside":
        place(store, tx, roots, "b:" + targetId, { kind: "start" });
        if (isCollapsed(target)) tx.update(targetId, (x) => { x.props = { ...(x.props ?? {}), isOpen: true }; });
        break;
      case "left": case "right": {
        const list = columnListOf(store, targetId);
        if (list) {
          const col = parentBlockID(target)!;
          const sk = sortKeys(store, "b:" + list, { kind: zone === "left" ? "before" : "after", id: col }, 1)[0]!;
          const newCol = create(store, tx, "column", "b:" + list, sk);
          place(store, tx, roots, "b:" + newCol, { kind: "end" });
          for (const c of store.children("b:" + list)) clearRatio(tx, c);
        } else {
          const sk = sortKeys(store, target.parent, { kind: "before", id: targetId }, 1)[0]!;
          const listID = create(store, tx, "columnList", target.parent, sk);
          const k1 = keyBetween(undefined, undefined);
          const c1 = create(store, tx, "column", "b:" + listID, k1);
          const c2 = create(store, tx, "column", "b:" + listID, keyBetween(k1, undefined));
          const [left, right] = zone === "left" ? [c1, c2] : [c2, c1];
          place(store, tx, roots, "b:" + left, { kind: "end" });
          place(store, tx, [targetId], "b:" + right, { kind: "end" });
        }
        break;
      }
    }
    tidyColumns(store, tx, sourceLists);
  });
  const first = store.blocks.get(roots[0]!)!;
  return isTextBlock(first) ? at(first.id, runsLength(textOf(first))) : { blockId: first.id, selected: true };
}

/** ⌘⇧↑ / ⌘⇧↓: Blöcke um eine Stelle unter ihren Geschwistern verschieben (an den Rändern: nichts). */
export function moveBlocksBy(store: WorkspaceStore, ids: readonly string[], direction: "up" | "down"): Focus | undefined {
  const roots = topLevel(store, ids);
  if (roots.length === 0) return undefined;
  const first = store.blocks.get(roots[0]!)!;
  if (roots.some((id) => store.blocks.get(id)!.parent !== first.parent)) return undefined;
  const sibs = siblings(store, first);
  const idx = roots.map((id) => sibs.indexOf(id)).sort((a, b) => a - b);
  if (direction === "up" ? idx[0]! === 0 : idx[idx.length - 1]! === sibs.length - 1) return undefined;
  const anchor = direction === "up" ? sibs[idx[0]! - 1]! : sibs[idx[idx.length - 1]! + 1]!;
  return moveBlocks(store, roots, anchor, direction === "up" ? "before" : "after");
}

/** Spaltenliste auflösen: Spalten nacheinander an ihre Stelle (Blockmenü „Unwrap columns“). */
export function dissolveColumns(store: WorkspaceStore, columnListId: string): Focus | undefined {
  const list = store.blocks.get(columnListId);
  if (list?.type !== "columnList") return undefined;
  const first = store.children("b:" + columnListId).flatMap((c) => store.children("b:" + c))[0];
  store.transact("Unwrap columns", (tx) => dissolveIn(store, tx, columnListId));
  if (!first) return undefined;
  const b = store.blocks.get(first)!;
  return isTextBlock(b) ? at(b.id, 0) : { blockId: b.id, selected: true };
}

// MARK: Löschen, Duplizieren

/**
 * Blöcke löschen (Blockauswahl + ⌫). Unterseiten und eigene Datenbanken kommen in den Papierkorb, darin liegende Seiten
 * werden gerettet (wie `WorkspaceStore.deleteBlocks`). Fokus: Ende des Blocks darüber, sonst Anfang des Blocks darunter,
 * sonst der Seitentitel (`blockId` = Seite, Offset 0).
 */
export function deleteBlocks(store: WorkspaceStore, ids: readonly string[]): Focus | undefined {
  const roots = topLevel(store, ids);
  if (roots.length === 0) return undefined;
  const set = new Set(roots);
  let prev = previousVisible(store, roots[0]!);
  while (prev && [...set].some((r) => isInside(store, prev!, r))) prev = previousVisible(store, prev);
  let next = nextVisible(store, roots[roots.length - 1]!);
  while (next && [...set].some((r) => isInside(store, next!, r))) next = nextVisible(store, next);
  const lists = roots.map((id) => columnListOf(store, id)).filter((x): x is string => !!x);
  const page = store.containingPage(roots[0]!);
  store.transact(roots.length === 1 ? "Delete block" : `Delete ${roots.length} blocks`, (tx) => {
    store.deleteBlocksIn(tx, roots);
    tidyColumns(store, tx, lists);
  });
  for (const cand of [prev, next]) {
    const b = cand ? store.blocks.get(cand) : undefined;
    if (!b || b.trashedAt !== undefined) continue;
    if (isTextBlock(b)) return at(b.id, cand === prev ? runsLength(textOf(b)) : 0);
    return { blockId: b.id, selected: true };
  }
  return page ? at(page, 0) : undefined;
}

/** Blöcke duplizieren (⌘D): die Kopien kommen als Gruppe hinter den letzten Block, mit allem darin (neue IDs). */
export function duplicateBlocks(store: WorkspaceStore, ids: readonly string[]): Focus | undefined {
  const roots = topLevel(store, ids);
  if (roots.length === 0) return undefined;
  const last = store.blocks.get(roots[roots.length - 1]!)!;
  const copies = store.transact(roots.length === 1 ? "Duplicate block" : `Duplicate ${roots.length} blocks`, (tx) => {
    const keys = sortKeys(store, last.parent, { kind: "after", id: last.id }, roots.length);
    return roots.map((id, i) => {
      const src = store.blocks.get(id)!;
      return copyTree(store, tx, src, last.parent, keys[i]!, isPageLike(src) ? " (1)" : undefined);
    });
  });
  const first = store.blocks.get(copies[0]!)!;
  return isTextBlock(first) ? at(first.id, runsLength(textOf(first))) : { blockId: first.id, selected: true };
}

/** Haken eines To-dos setzen (Klick auf das Kästchen, ⌘Enter). */
export function setChecked(store: WorkspaceStore, blockId: string, checked: boolean): Focus | undefined {
  const b = store.blocks.get(blockId);
  if (b?.type !== "todo" || (b.props?.checked === true) === checked) return undefined;
  store.transact(checked ? "Check" : "Uncheck", (tx) => tx.update(blockId, (x) => {
    const p = { ...(x.props ?? {}) };
    if (checked) p.checked = true;
    else delete p.checked;
    if (Object.keys(p).length) x.props = p;
    else delete x.props;
  }));
  return { blockId, selected: true };
}
