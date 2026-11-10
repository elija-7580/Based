// Gemeinsamer Teil von headless.ts (Laufzeit) und headless-api.ts (Typen): alles hier kompiliert auch streng.
export { DocSession, FRAGMENT, LOAD_ORIGIN, MemoryYDocStore, STORE_ORIGIN } from "./yjs/session.js";
export type { BlockConverter, DocSessionOptions, YDocStore } from "./yjs/session.js";
export type { BNBlock } from "./mapping/bn.js";
// BSD-220 Teil 3: Geräte-Seite von /collab (Regeln ohne DOM, testbar in Node)
export { COLLAB_META_MAP, COLLAB_META_ORIGIN, CollabBinder, collabDocName, fromServer } from "./yjs/collab.js";
export type { CollabBinderOptions, CollabConnection, CollabHandle, CollabSource } from "./yjs/collab.js";
