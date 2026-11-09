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
export { SearchCorpus, contentText, fold, rowText, snippet } from "./search/search.js";
export type { SearchFilters, SearchHit, SearchSort } from "./search/search.js";
export { HTMLNode, decodeEntities, parseHTML, pageIDFromLink, sanitizeURL, urlScheme } from "./interop/html.js";
export { ClipboardHTMLImporter, importedJSON, notionColor } from "./interop/clipboard.js";
export type { ImportedBlock } from "./interop/clipboard.js";
export { HTMLExporter, escapeAttribute, escapeText } from "./interop/export.js";
export type { HTMLExporterOptions } from "./interop/export.js";
export { relationLimitViolations, setRelation } from "./store/relations.js";
// BSD-155: Datenbank-Operationen, Diagramme, Anzeige-Helfer und gefilterte Beobachtung für @based/database-ui.
export * as dbops from "./store/database-ops.js";
export {
  addDashboardWidget, addOption, addProperty, addRow, addTemplate, addView, changePropertyType, createDatabase, createLinkedView,
  dashboardInsert, dashboardMove, dashboardRemove, dashboardSetWidth, dashboardWidgetIDs, defaultViewName, deleteOption, deleteProperty,
  deleteRows, deleteView, duplicateProperty, duplicateRow, duplicateView, evenWidths, filledCellCount, filterRemovingOption,
  filterRemovingProperty, forgetOption, forgetProperty, formulaPropertyReferences, linkMirrors, makeRelationTwoWay, makeWidgetView,
  movePropertyInView, moveDashboardWidget, moveRow, moveRowToGroup, moveView, propertyNamed, propertyOf, pv, removeDashboardWidget,
  renameProperty, renameView, renamingFormulaReferences, renamingRelatedReferences, setAllPropertiesVisible, setCalculation,
  setColumnWidth, setDashboardRowHeight, setDashboardWidgetWidth, setDatabaseLocked, setDatabaseTitle, setFilter, setGroupBy,
  setGroupHidden, setPropertyVisible, setRelationLimitOne, setRelationTarget, setRollup, setRowTitle, setSorts, setValue, setViewType,
  uniquePropertyName, updateChart, updateOption, updateProperty, updateView, valueCase, valueForGroup, viewsForBlock, visiblePropertyIDs,
  wouldCreateRollupCycle, DASHBOARD_COLUMNS, DASHBOARD_MAX_WIDGETS_PER_ROW, WIDGET_TYPES,
} from "./store/database-ops.js";
export type { AddRowOptions, CreatedDatabase, InsertPosition } from "./store/database-ops.js";
export { chartDateBucket, chartNumber, chartPoints } from "./query/chart.js";
export type { ChartPoint } from "./query/chart.js";
export {
  ADDABLE_PROPERTY_TYPES, CALCULATION_LABELS, FILTER_OP_LABELS, NUMBER_FORMAT_LABELS, NUMBER_FORMATS, PROPERTY_TYPE_LABELS,
  READ_ONLY_TYPES, RELATIVE_DATE_LABELS, calculationOptions, calculationText, formatDateCell, formatNumber, formatValue,
} from "./query/display.js";
export { changeAffects, databaseDependencies, watchDatabase } from "./query/dependencies.js";
