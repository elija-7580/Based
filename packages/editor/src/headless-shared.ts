// Gemeinsamer Teil von headless.ts (Laufzeit) und headless-api.ts (Typen): alles hier kompiliert auch streng.
export { LOAD_ORIGIN, MemoryYDocStore } from "./yjs/ydoc-store.js";
export type { YDocStore } from "./yjs/ydoc-store.js";
// BSD-220 Teil 3: Geräte-Seite von /collab (Regeln ohne DOM, testbar in Node)
export { COLLAB_META_MAP, COLLAB_META_ORIGIN, CollabBinder, fromServer } from "./yjs/collab.js";
export type { CollabBinderOptions, CollabConnection, CollabHandle, CollabSource, PresenceChannel } from "./yjs/collab.js";
// ADR 0016 (E7): Echtzeit-Text des neuen Block-Editors (ein Y.Text je Block)
export { richTextOf, TEXT_STORE_ORIGIN, TEXTS, textBlocksOf, textDocName, TextSession, writeRuns } from "./yjs/text-session.js";
export type { TextSessionOptions } from "./yjs/text-session.js";
