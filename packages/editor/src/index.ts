// @based/editor – Block-Editor (ADR 0016) + Yjs (ein Y.Text je Textblock). BlockNote ist ganz entfernt (BSD-407 Teil 4,
// zuletzt 4c: kopfloser Konverter, BlockNote-Abbildung und DocSession für die alten `page:`-Dokumente).
export { BlockEditor, dropTarget, sectionColor } from "./blocks/BlockEditor.js";
export { EditorController } from "./blocks/controller.js";
export { SLASH_ITEMS, filterSlash, slashItemsFor } from "./blocks/slash.js";
export type { MeetingHost, MeetingHostState, MeetingPlayback } from "./ui/meetingHost.js";
export type { PageEditorProps } from "./ui/props.js";
export type { DatabaseRenderProps, EquationRenderProps, PageDirectory, PageRef, Person } from "./ui/env.js";
export { isEmojiIcon, storePageDirectory } from "./ui/env.js";
export { EmojiPicker } from "./ui/EmojiPicker.js";
export { IconView, isDrawableIcon, loadPhosphor, PhosphorGlyph } from "./ui/phosphor.js";
export type { EmojiPickerProps } from "./ui/EmojiPicker.js";
export type { DatabaseRef, DatabaseSource } from "./ui/MovePicker.js";
export { SELECTION_ACTIONS } from "./ui/ai.js";
export type { EditorAI } from "./ui/ai.js";
export { isOutlineHidden, PageOutline, scrollToHeading, setOutlineHidden } from "./ui/Outline.js";

// Präfixe in Props und Zwischenablage
export { ASSET_URL_PREFIX, SYNC_CLIPBOARD_PREFIX, syncSourceFromClipboard } from "./blocks/prefixes.js";

// Yjs
export { LOAD_ORIGIN, MemoryYDocStore } from "./yjs/ydoc-store.js";
export type { YDocStore } from "./yjs/ydoc-store.js";
export { COLLAB_META_MAP, COLLAB_META_ORIGIN, CollabBinder, fromServer } from "./yjs/collab.js";
export type { CollabBinderOptions, CollabConnection, CollabHandle, CollabSource, PresenceChannel } from "./yjs/collab.js";
export { richTextOf, TEXT_STORE_ORIGIN, TEXTS, textBlocksOf, textDocName, TextSession, writeRuns } from "./yjs/text-session.js";
export type { TextSessionOptions } from "./yjs/text-session.js";
// BSD-319: Diagnose-Sonde
export { setBlockEditorProbe } from "./ui/probe.js";
export type { BlockEditorProbe, BlockEditorProbeTarget, BlockProbeSelection } from "./ui/probe.js";
