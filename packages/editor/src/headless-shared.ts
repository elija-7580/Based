// Gemeinsamer Teil von headless.ts (Laufzeit) und headless-api.ts (Typen): alles hier kompiliert auch streng.
export { DocSession, FRAGMENT, LOAD_ORIGIN, MemoryYDocStore, STORE_ORIGIN } from "./yjs/session.js";
export type { BlockConverter, DocSessionOptions, YDocStore } from "./yjs/session.js";
export type { BNBlock } from "./mapping/bn.js";
// BSD-220 Teil 3: Geräte-Seite von /collab (Regeln ohne DOM, testbar in Node)
export { COLLAB_META_MAP, COLLAB_META_ORIGIN, CollabBinder, collabDocName, fromServer } from "./yjs/collab.js";
export type { CollabBinderOptions, CollabConnection, CollabHandle, CollabSource, PresenceChannel } from "./yjs/collab.js";
// ADR 0016 (E7): Echtzeit-Text des neuen Block-Editors (ein Y.Text je Block)
export { richTextOf, TEXT_STORE_ORIGIN, TEXTS, textBlocksOf, textDocName, TextSession, writeRuns } from "./yjs/text-session.js";
export type { TextSessionOptions } from "./yjs/text-session.js";
