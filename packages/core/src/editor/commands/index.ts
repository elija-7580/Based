// BSD-382 (ADR 0016, E1): Befehle des neuen Block-Editors. Die Ansicht ruft nur diese Befehle auf und ändert nie
// selbst Records; jeder Befehl ist eine Transaktion (ein Undo-Schritt) und gibt den neuen Fokus zurück.
export {
  applyMarkdownShortcut, deleteBlocks, dissolveColumns, duplicateBlocks, formatText, indentBlocks, markdownShortcut, mergeBackward, mergeForward,
  moveBlocks, moveBlocksBy, newBlockID, outdentBlocks, replaceText, setBlockText, setChecked, splitBlock, turnInto,
} from "./blocks.js";
export type { DropZone, Focus, ReplaceTextOptions, TextRange } from "./blocks.js";
export { BASED_CLIPBOARD_MIME, copyBlocks, insertContent, isBasedClipboard, parsePaste } from "./paste.js";
export type { BasedClipboard, PasteContent, PasteOptions } from "./paste.js";
export {
  canNestUnder, isCollapsed, isTextBlock, isToggle, nextVisible, previousVisible, sortByDocument, TEXT_TYPES, topLevel, visibleChildren, visibleOrder,
} from "./tree.js";
export { hasMark, marksAt, replaceRuns, setMark, splitRuns, toggleMark, type MarkKey } from "./text.js";
