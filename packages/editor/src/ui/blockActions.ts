// BSD-207: Blockaktionen wie in Notion – Duplicate (⌘D), Turn into (auch „Page“), Move to und alle Toggles auf/zu.
// Reine Funktionen über die BlockNote-API (und den Store der Sitzung), damit sie ohne Oberfläche testbar sind; das
// Blockmenü (PageEditor.tsx) ruft nur diese auf.
import { isDescendant, keysBetween, plainText, type WorkspaceStore } from "@based/core";
import { CUSTOM } from "../mapping/bn.js";

/** Minimal, was hier von BlockNote gebraucht wird (BasedEditor erfüllt das). */
export interface BlockLike {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children: BlockLike[];
}
export interface ActionEditor {
  getBlock(id: string): BlockLike | undefined;
  insertBlocks(blocks: unknown[], ref: string, placement: "before" | "after"): BlockLike[];
  updateBlock(id: string, update: unknown): unknown;
  getSelection(): { blocks: BlockLike[] } | undefined;
  setTextCursorPosition(id: string, placement: "start" | "end"): void;
  removeBlocks(ids: string[]): unknown;
  replaceBlocks(remove: string[], insert: unknown[]): unknown;
}

/** Was Move to / Turn into page von der Dokument-Sitzung brauchen (DocSession erfüllt das). */
export interface ActionSession {
  readonly store: WorkspaceStore;
  readonly rootID: string;
  flush(): unknown;
  quietly<T>(fn: () => T): T;
}

/**
 * Blöcke, die auf eigene Records zeigen (Unterseite, Datenbank, Synced Block, Meeting): eine flache Kopie würde
 * einen zweiten Verweis bzw. eine leere Hülle erzeugen. Unterseiten und Datenbanken kopiert der Store tief
 * (`RECORD_COPIES`, über die Shell: duplicatePages), Synced Blocks und Meetings werden nicht dupliziert.
 */
const NOT_DUPLICABLE: ReadonlySet<string> = new Set([CUSTOM.page, CUSTOM.database, CUSTOM.syncedBlock, CUSTOM.meeting]);
/** Diese Blöcke werden als Records tief kopiert (mit Inhalt, Zeilen, Ansichten). */
const RECORD_COPIES: ReadonlySet<string> = new Set([CUSTOM.page, CUSTOM.database]);

export function isDuplicable(b: BlockLike): boolean {
  return !NOT_DUPLICABLE.has(b.type) && b.children.every(isDuplicable);
}

/** Kopie ohne IDs (BlockNote vergibt neue), Kinder rekursiv. */
export function withoutIDs(b: BlockLike): Record<string, unknown> {
  const out: Record<string, unknown> = { type: b.type, children: b.children.map(withoutIDs) };
  if (b.props) out.props = structuredClone(b.props);
  if (b.content !== undefined) out.content = structuredClone(b.content);
  return out;
}

/** Blöcke, auf die eine Aktion wirkt: die Auswahl, wenn der Block darin liegt, sonst nur der Block. */
export function targetBlocks(editor: ActionEditor, blockID: string): BlockLike[] {
  const sel = editor.getSelection()?.blocks;
  if (sel && sel.some((b) => b.id === blockID)) return sel;
  const b = editor.getBlock(blockID);
  return b ? [b] : [];
}

/**
 * `inserted`: Kopien im Dokument; `records`: Unterseiten/Datenbanken, die der Store tief kopieren soll (die Shell
 * legt die Kopie direkt hinter das Original); `skipped`: nicht kopierbar (Synced Block, Meeting, oder darin).
 */
export interface DuplicateResult { inserted: string[]; records: string[]; skipped: number }

/** Dupliziert die Blöcke direkt hinter den letzten; die Schreibmarke landet in der ersten Kopie. */
export function duplicateBlocks(editor: ActionEditor, blocks: readonly BlockLike[]): DuplicateResult {
  const ok = blocks.filter(isDuplicable);
  const records = blocks.filter((b) => RECORD_COPIES.has(b.type)).map((b) => b.id);
  const skipped = blocks.length - ok.length - records.length;
  const last = blocks[blocks.length - 1];
  if (!ok.length || !last) return { inserted: [], records, skipped };
  const inserted = editor.insertBlocks(ok.map(withoutIDs), last.id, "after").map((b) => b.id);
  const first = inserted[0];
  if (first && editor.getBlock(first)?.content !== undefined) editor.setTextCursorPosition(first, "end");
  return { inserted, records, skipped };
}

export interface TurnIntoOption { key: string; label: string; type: string; props?: Record<string, unknown> }

/** Ziele für „Turn into“: alle Blöcke mit Text (Inhalt bleibt erhalten). */
export const TURN_INTO: readonly TurnIntoOption[] = [
  { key: "paragraph", label: "Text", type: "paragraph" },
  { key: "h1", label: "Heading 1", type: "heading", props: { level: 1, isToggleable: false } },
  { key: "h2", label: "Heading 2", type: "heading", props: { level: 2, isToggleable: false } },
  { key: "h3", label: "Heading 3", type: "heading", props: { level: 3, isToggleable: false } },
  { key: "bullet", label: "Bulleted list", type: "bulletListItem" },
  { key: "numbered", label: "Numbered list", type: "numberedListItem" },
  { key: "todo", label: "To-do list", type: "checkListItem" },
  { key: "toggle", label: "Toggle list", type: "toggleListItem" },
  { key: "quote", label: "Quote", type: "quote" },
  { key: "code", label: "Code", type: "codeBlock" },
  { key: "callout", label: "Callout", type: CUSTOM.callout },
];

const TEXT_TYPES: ReadonlySet<string> = new Set(TURN_INTO.map((o) => o.type));

/** Kann der Block umgewandelt werden (hat Text)? */
export function canTurnInto(b: BlockLike): boolean {
  return TEXT_TYPES.has(b.type) && Array.isArray(b.content);
}

/** „Turn into → Page“: kein Blocktyp, sondern eine Unterseite mit dem Text als Titel (eigene Aktion, siehe turnIntoPage). */
export const TURN_INTO_PAGE: TurnIntoOption = { key: "page", label: "Page", type: CUSTOM.page };

/** Ist `b` schon genau dieses Ziel? (Für das Häkchen im Menü.) */
export function isCurrent(b: BlockLike, o: TurnIntoOption): boolean {
  if (b.type !== o.type) return false;
  return o.type !== "heading" || b.props?.level === o.props?.level;
}

/** Wandelt alle Blöcke mit Text um; andere bleiben. Gibt die Zahl der umgewandelten Blöcke zurück. */
export function turnInto(editor: ActionEditor, blocks: readonly BlockLike[], o: TurnIntoOption): number {
  let n = 0;
  for (const b of blocks) {
    if (!canTurnInto(b) || isCurrent(b, o)) continue;
    editor.updateBlock(b.id, o.props ? { type: o.type, props: o.props } : { type: o.type });
    n++;
  }
  return n;
}

const newID = () => globalThis.crypto.randomUUID().toUpperCase();

/**
 * „Turn into → Page“ (wie Notion): der Block wird zu einer Unterseite an derselben Stelle; sein Text wird der Titel,
 * seine Kinder werden der Inhalt der Seite. Die Records entstehen still im Store, der Austausch im Dokument ist ein
 * Undo-Schritt im Editor (wie „Copy and sync“). Gibt die ID der neuen Seite zurück.
 */
export function turnIntoPage(editor: ActionEditor, session: ActionSession, blockID: string): string | undefined {
  const bn = editor.getBlock(blockID);
  if (!bn || !canTurnInto(bn)) return undefined;
  session.flush();
  const { store } = session;
  const rec = store.blocks.get(blockID);
  if (!rec) return undefined;
  const pageID = newID();
  const kids = store.children("b:" + blockID);
  session.quietly(() => store.transact("Turn into page", (tx) => {
    const now = store.now();
    const title = plainText(rec.text);
    tx.put({ kind: "block", data: { id: pageID, type: "page", parent: rec.parent, sk: rec.sk, createdAt: now, updatedAt: now, ...(title ? { text: title } : {}), ...(store.userID != null ? { createdBy: store.userID } : {}) } });
    for (const k of kids) tx.update(k, (b) => { b.parent = "b:" + pageID; });
  }, { undoable: false }));
  editor.replaceBlocks([blockID], [{ id: pageID, type: CUSTOM.page }]);
  return pageID;
}

/** Ziele für „Move to“: Seiten und Zeilen (keine Datenbanken), nicht die eigene Seite und nichts, was bewegt wird. */
export function moveTargetAllowed(kind: string | undefined, id: string, selfID: string, moving: readonly string[]): boolean {
  return kind !== "database" && id !== selfID && !moving.includes(id);
}

/**
 * „Move to“: Blöcke mit allem darin ans Ende einer anderen Seite. `lastKey` ist der Sortierschlüssel des letzten
 * Kinds der Zielseite (die Seiten-Replik kennt die Zielseite meist nicht); ohne: was der Store kennt.
 * Records still umhängen, dann die Blöcke aus dem Dokument nehmen – ein Undo-Schritt im Editor (Undo holt sie zurück).
 * Gibt die Zahl der bewegten Blöcke zurück.
 */
export function moveBlocksToPage(editor: ActionEditor, session: ActionSession, blockIDs: readonly string[], targetID: string, lastKey?: string): number {
  if (targetID === session.rootID) return 0;
  session.flush();
  const { store } = session;
  const set = new Set(blockIDs);
  const moving = blockIDs.filter((id) => store.blocks.has(id) && editor.getBlock(id) !== undefined && id !== targetID
    && !isDescendant(store, targetID, id) && !blockIDs.some((o) => o !== id && set.has(o) && isDescendant(store, id, o)));
  if (moving.length === 0) return 0;
  const parent = "b:" + targetID;
  const known = store.children(parent).filter((id) => !set.has(id)).map((id) => store.blocks.get(id)?.sk).filter((k): k is string => k !== undefined);
  let after = lastKey;
  for (const k of known) if (after === undefined || k > after) after = k;
  const keys = keysBetween(moving.length, after, undefined);
  session.quietly(() => store.transact(moving.length === 1 ? "Move block" : `Move ${moving.length} blocks`, (tx) => {
    moving.forEach((id, i) => tx.update(id, (b) => {
      b.parent = parent;
      b.sk = keys[i]!;
    }));
  }, { undoable: false }));
  editor.removeBlocks(moving);
  return moving.length;
}

/**
 * ⌘⌥T: alle Toggles im Bereich auf- oder zuklappen (wie Notion: ist einer zu, gehen alle auf, sonst alle zu).
 * BlockNote hält den Zustand in seiner Toggle-Ansicht (Knopf mit aria-expanded) – deshalb über die Knöpfe.
 * Gibt zurück, was passiert ist.
 */
export function toggleAll(root: ParentNode): "opened" | "closed" | "none" {
  const buttons = [...root.querySelectorAll<HTMLButtonElement>(".bn-toggle-button")];
  if (buttons.length === 0) return "none";
  const open = buttons.some((b) => b.getAttribute("aria-expanded") !== "true");
  for (const b of buttons) if ((b.getAttribute("aria-expanded") === "true") !== open) b.click();
  return open ? "opened" : "closed";
}

// MARK: Blockauswahl (Esc)

/** Was die Blockauswahl vom Editor braucht. */
export interface SelectionEditor {
  readonly document: BlockLike[];
  getParentBlock(id: string): BlockLike | undefined;
}

/** Ausgewählte Blöcke als Spanne unter Geschwistern: `anchor` bleibt, `head` wandert mit ⇧↑/⇧↓. */
export interface BlockRange { anchor: string; head: string }

const siblingsOf = (editor: SelectionEditor, id: string): BlockLike[] => editor.getParentBlock(id)?.children ?? editor.document;

/** Die IDs der Spanne in Dokument-Reihenfolge (leer, wenn der Anker nicht mehr existiert). */
export function rangeIDs(editor: SelectionEditor, r: BlockRange): string[] {
  const sib = siblingsOf(editor, r.anchor);
  const a = sib.findIndex((b) => b.id === r.anchor);
  if (a < 0) return [];
  const h = sib.findIndex((b) => b.id === r.head);
  if (h < 0) return [r.anchor];
  return sib.slice(Math.min(a, h), Math.max(a, h) + 1).map((b) => b.id);
}

function flatIDs(blocks: readonly BlockLike[], out: string[] = []): string[] {
  for (const b of blocks) {
    out.push(b.id);
    flatIDs(b.children, out);
  }
  return out;
}

/**
 * ↑/↓ in der Blockauswahl: ohne ⇧ zum vorigen/nächsten Block in Lese-Reihenfolge (auch in Kinder hinein), mit ⇧
 * die Spanne unter den Geschwistern des Ankers erweitern bzw. verkleinern. Am Rand bleibt die Auswahl.
 */
export function stepRange(editor: SelectionEditor, r: BlockRange, dir: -1 | 1, extend: boolean): BlockRange {
  if (extend) {
    const sib = siblingsOf(editor, r.anchor);
    const h = sib.findIndex((b) => b.id === r.head);
    const next = sib[h + dir];
    return h >= 0 && next ? { anchor: r.anchor, head: next.id } : r;
  }
  const flat = flatIDs(editor.document);
  const i = flat.indexOf(r.head);
  const next = i >= 0 ? flat[i + dir] : undefined;
  return next ? { anchor: next, head: next } : { anchor: r.head, head: r.head };
}
