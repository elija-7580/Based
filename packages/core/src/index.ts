// @based/core – plattformfreier Kern (Datenmodell, Abfragen, Formeln, HLC …). Siehe ADR 0011.
export const CORE_VERSION = "0.0.0";

export * from "./json.js";
export * as schema from "./model/schema.js";
export { ENUMS, KNOWN_KEYS } from "./model/schema.js";
export * from "./model/records.js";
export { StampClock, ZERO_STAMP, parseStamp, stampToString } from "./hlc.js";
export { FIRST_KEY, isValidKey, keyBetween, keysBetween } from "./sortkeys.js";
export { plainText } from "./richtext.js";
export { MemoryPersistence, Tx, WorkspaceStore, keyOf, parseKey, recordKey, WORKSPACE_ID } from "./store/store.js";
export type { ChangeOrigin, Persistence, RecordKeyString, RemoteMergeResult, StoreOptions, UndoOutcome } from "./store/store.js";
export { Formula, FormulaError, FUNCTION_NAMES, referencedProperties } from "./query/formula.js";
export type { FormulaEnvironment, FormulaExpr } from "./query/formula.js";
export * as values from "./query/value.js";
export type { DateValue, Value } from "./query/value.js";
