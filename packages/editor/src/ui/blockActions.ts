// BSD-207: Blockaktionen wie in Notion – Duplicate (⌘D) und Turn into. Reine Funktionen über die BlockNote-API,
// damit sie ohne Oberfläche testbar sind; das Blockmenü (PageEditor.tsx) ruft nur diese auf.
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
}

/**
 * Blöcke, die auf eigene Records zeigen (Unterseite, Datenbank, Synced Block, Meeting): eine flache Kopie würde
 * einen zweiten Verweis bzw. eine leere Hülle erzeugen. Die werden (noch) nicht dupliziert.
 */
const NOT_DUPLICABLE: ReadonlySet<string> = new Set([CUSTOM.page, CUSTOM.database, CUSTOM.syncedBlock, CUSTOM.meeting]);

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

export interface DuplicateResult { inserted: string[]; skipped: number }

/** Dupliziert die Blöcke direkt hinter den letzten; die Schreibmarke landet in der ersten Kopie. */
export function duplicateBlocks(editor: ActionEditor, blocks: readonly BlockLike[]): DuplicateResult {
  const ok = blocks.filter(isDuplicable);
  const last = blocks[blocks.length - 1];
  if (!ok.length || !last) return { inserted: [], skipped: blocks.length };
  const inserted = editor.insertBlocks(ok.map(withoutIDs), last.id, "after").map((b) => b.id);
  const first = inserted[0];
  if (first && editor.getBlock(first)?.content !== undefined) editor.setTextCursorPosition(first, "end");
  return { inserted, skipped: blocks.length - ok.length };
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
