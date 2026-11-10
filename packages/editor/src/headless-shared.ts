// Gemeinsamer Teil von headless.ts (Laufzeit) und headless-api.ts (Typen): alles hier kompiliert auch streng.
export { DocSession, FRAGMENT, LOAD_ORIGIN, MemoryYDocStore, STORE_ORIGIN } from "./yjs/session.js";
export type { BlockConverter, DocSessionOptions, YDocStore } from "./yjs/session.js";
export type { BNBlock } from "./mapping/bn.js";
