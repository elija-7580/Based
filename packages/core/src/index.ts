// @based/core – plattformfreier Kern (Datenmodell, Abfragen, Formeln, HLC …). Siehe ADR 0011.
export const CORE_VERSION = "0.0.0";

export * from "./json.js";
export * as schema from "./model/schema.js";
export { ENUMS, KNOWN_KEYS } from "./model/schema.js";
export * from "./model/records.js";
