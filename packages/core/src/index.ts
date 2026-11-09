// @based/core – plattformfreier Kern (Datenmodell, Abfragen, Formeln, HLC …). Siehe ADR 0011.
export const CORE_VERSION = "0.0.0";

export * from "./json.js";
export * as schema from "./model/schema.js";
export { ENUMS, KNOWN_KEYS } from "./model/schema.js";
export * from "./model/records.js";
export { StampClock, ZERO_STAMP, parseStamp, stampToString } from "./hlc.js";
export { FIRST_KEY, isValidKey, keyBetween, keysBetween } from "./sortkeys.js";
export { plainText } from "./richtext.js";
export { MemoryPersistence, StoreReadOnlyError, Tx, WorkspaceStore, keyOf, parseKey, recordKey, WORKSPACE_ID } from "./store/store.js";
export type { ChangeOrigin, Persistence, RecordKeyString, RemoteMergeResult, StoreChange, StoreOptions, UndoOutcome, WriteFailure } from "./store/store.js";
export { Formula, FormulaError, FUNCTION_NAMES, referencedProperties } from "./query/formula.js";
export type { FormulaEnvironment, FormulaExpr } from "./query/formula.js";
export * as values from "./query/value.js";
export type { DateValue, FormulaRun, Value } from "./query/value.js";
export { QueryEngine, TITLE_PROPERTY_ID, filterOps, cellText, databaseOfRow, durationText, isTrashed, liveRelationTargets, rowsOf, titleOf, titleProperty } from "./query/engine.js";
export type { QueryEngineOptions, QueryResult, RowGroup } from "./query/engine.js";
export { conversionLoss, formatDateValue, plainString, propertyConversion } from "./store/conversion.js";
export type { ConversionPlan } from "./store/conversion.js";
export { SearchCorpus, SearchIndex, attachSearchIndex, contentText, fold, handleSearchMessage, observeSearchDeltas, rowText, searchDeltaFrom, searchSnapshot, searchTitle, snippet } from "./search/search.js";
export type { SearchDelta, SearchFilters, SearchHit, SearchOptions, SearchRequest, SearchResponse, SearchSort, SearchSource } from "./search/search.js";
export { HTMLNode, decodeEntities, parseHTML, pageIDFromLink, sanitizeURL, urlScheme } from "./interop/html.js";
export { ClipboardHTMLImporter, importedJSON, notionColor } from "./interop/clipboard.js";
export type { ImportedBlock } from "./interop/clipboard.js";
export { HTMLExporter, escapeAttribute, escapeText } from "./interop/export.js";
export type { HTMLExporterOptions } from "./interop/export.js";
export { relationLimitViolations, setRelation } from "./store/relations.js";
// BSD-156: Import und Export (Notion-HTML, Markdown/CSV, Workspace-Archiv, ZIP)
export { ImportIDs, changedSinceImport, contentFingerprint, derivedID, importFingerprint, IMPORT_FINGERPRINT_KEY, notionIDInName, notionUUID, versionHash } from "./interop/importids.js";
export { ImportFiles, basename, dirname, extname, joinPath, normalizePath, stripExtension } from "./interop/files.js";
export { DEFAULT_ZIP_LIMITS, ImportCancelled, ZipError, crc32, extractZip, isZip, readZipEntries, sanitizedZipPath, writeZip, zipEntryData } from "./interop/zip.js";
export type { ExtractOptions, ExtractResult, ZipEntry, ZipErrorKind, ZipLimits, ZipWriteEntry } from "./interop/zip.js";
export { ImportBuilder, MemoryAssetSink, cleanBlock, commitImport, emptyReport, makeBlock, makeRecordID, mimeFor } from "./interop/builder.js";
export type { AssetRef, AssetSink, ImportBuilderOptions, ImportReport, NewBlock } from "./interop/builder.js";
