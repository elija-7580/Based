// @based/editor – Seiten-Editor auf BlockNote-Kern (MPL-2.0) + Yjs (BSD-154). Keine @blocknote/xl-* (ADR 0011).
export { PageEditor, copyAndSync, insertInlineEquation, insertMeeting, insertLinkedView, insertSyncedCopy, lastCopiedSync } from "./ui/PageEditor.js";
export type { MeetingHost, MeetingHostState, MeetingPlayback } from "./ui/meetingHost.js";
export type { PageEditorProps } from "./ui/PageEditor.js";
export type { DatabaseRenderProps, EquationRenderProps, PageDirectory, PageRef, Person } from "./ui/env.js";
export { isEmojiIcon, storePageDirectory } from "./ui/env.js";
export { EmojiPicker } from "./ui/EmojiPicker.js";
export type { EmojiPickerProps } from "./ui/EmojiPicker.js";
export type { DatabaseRef, DatabaseSource } from "./ui/MovePicker.js";
export { AIBox, applyAIResult, SELECTION_ACTIONS } from "./ui/AIBox.js";
export type { AIRequest, EditorAI } from "./ui/AIBox.js";
export { isOutlineHidden, PageOutline, scrollToHeading, setOutlineHidden } from "./ui/Outline.js";
export { mentionItems } from "./ui/mentions.js";
export { handlePaste, htmlToBlocks, insertMarkdown, insertParsed } from "./ui/paste.js";
export { importedToBlocks, markdownToBlocks, singleParagraph } from "./mapping/imported.js";

// Reine Abbildung Records ⇄ BlockNote
export { ASSET_URL_PREFIX, CUSTOM, INLINE, SYNC_CLIPBOARD_PREFIX, syncSourceFromClipboard } from "./mapping/bn.js";
export type { BNBlock, BNInline } from "./mapping/bn.js";
export { BOUNDARY_TYPES, docBlockIDs, extractOwned, projectBlock, projectDoc } from "./mapping/blocks.js";
export type { BlockSource, Owned } from "./mapping/blocks.js";
export { applyDocChanges, isEmptyChange, isTrashable, materializeDoc } from "./mapping/materialize.js";
export type { DocChanges, MaterializeOptions, RecordSource } from "./mapping/materialize.js";
export { canonicalRichText, colorFromBN, colorToBN, inlineToRichText, richTextToInline } from "./mapping/richtext.js";
export { assignSortKeys } from "./mapping/sortkeys.js";

// Yjs
export { DocSession, FRAGMENT, LOAD_ORIGIN, MemoryYDocStore, STORE_ORIGIN, acquireSession, releaseSession } from "./yjs/session.js";
export type { BlockConverter, DocSessionOptions, YDocStore } from "./yjs/session.js";
export { syncChildren } from "./yjs/xmldiff.js";
export { basedSchema, createConverter, sharedConverter } from "./schema/schema.js";
export type { BasedEditor, BasedSchema } from "./schema/schema.js";
