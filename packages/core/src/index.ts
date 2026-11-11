// @based/core – plattformfreier Kern (Datenmodell, Abfragen, Formeln, HLC …). Siehe ADR 0011.
export const CORE_VERSION = "0.0.0";

export * from "./json.js";
export * as schema from "./model/schema.js";
export { ENUMS, KNOWN_KEYS } from "./model/schema.js";
export * from "./model/records.js";
export * as propertyRecords from "./model/property-records.js";
export type { DatabaseCore, MigrationReport, PropertyDiff, SchemaIssue } from "./model/property-records.js";
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
export { PRIVATE, topmost, createPage, createTeamspace, deleteForever, deleteTeamspace, duplicatePages, renameTeamspace, setTeamspaceIcon, dropPages, emptyTrash, insertPage, isDescendant, isPageLike, movePages, renamePage, restorePages, sameSection, sectionOf, setFavorite, sortKeys, subtree, trashPages, trashedPages } from "./store/pages.js";
export { renameWorkspace, setWorkspaceIcon } from "./store/pages.js";
export { linkUnlinkedMention, unlinkedMentions, type UnlinkedMention } from "./store/unlinked.js";
export type { CreatePageOptions, DropZone, InsertPosition, PageDestination, SectionID } from "./store/pages.js";
// Library, Seitengraph (Shell-Parität)
export { LIBRARY_KINDS, duplicateTitleKeys, filterLibrary, libraryItems, titleKey } from "./store/library.js";
export type { LibraryItem, LibraryKind, LibraryQuery, LibrarySort } from "./store/library.js";
export { GRAPH_EDGE_KINDS, buildPageGraph, filterGraph, graphAdjacency } from "./graph/page-graph.js";
export type { GraphEdge, GraphEdgeKind, GraphFilter, GraphNode, GraphNodeKind, PageGraph } from "./graph/page-graph.js";
export { ForceLayout, hashID, layoutBounds, nodeAtPoint } from "./graph/layout.js";
export type { LayoutOptions, Point } from "./graph/layout.js";
export { PRIVATE_SECTION, SHARED_SECTION, buildOutline, iconText, pageAncestors, pageTitles, sectionKey, structureSignature } from "./store/outline.js";
export type { Outline, OutlineNode, OutlineSection, TrashEntry } from "./store/outline.js";
// BSD-156: Import und Export (Notion-HTML, Markdown/CSV, Workspace-Archiv, ZIP)
export { ImportIDs, changedSinceImport, contentFingerprint, derivedID, importFingerprint, IMPORT_FINGERPRINT_KEY, notionIDInName, notionUUID, versionHash } from "./interop/importids.js";
export { ImportFiles, basename, bytesSource, dirname, extname, joinPath, normalizePath, stripExtension, subSource } from "./interop/files.js";
export type { ByteSource, LazyFile } from "./interop/files.js";
export { DEFAULT_ZIP_LIMITS, ImportCancelled, ZIP_EAGER_BYTES, ZipError, crc32, extractZip, isZip, readZipEntries, sanitizedZipPath, writeZip, zipEntryData, zipEntryStart } from "./interop/zip.js";
export type { ExtractOptions, ExtractResult, ZipEntry, ZipErrorKind, ZipLimits, ZipWriteEntry } from "./interop/zip.js";
export { AssetRejected, DEFAULT_MAX_ASSET_BYTES, ImportBuilder, LimitedAssetSink, MemoryAssetSink, formatBytes, importAssetFrom, looksLikeLocalFile, cleanBlock, commitImport, emptyReport, makeBlock, makeRecordID, mimeFor } from "./interop/builder.js";
export type { AssetRef, AssetSink, ImportBuilderOptions, LazyAsset, ImportBuilderWire, ImportReport, NewBlock } from "./interop/builder.js";
export { cleanTitle, columnRatio, importedEmoji, NotionHTMLImporter, parseNotionNumber, rowType, svgType, trimRuns } from "./interop/notion-html.js";
export type { NotionHTMLOptions } from "./interop/notion-html.js";
export { decodeCSV, decodeInlineMarkdown, encodeCSV, guardCSVFormula, encodeInlineMarkdown, escapeMarkdown, formatDateValue as formatDateMention, MarkdownImporter, tableCells } from "./interop/markdown.js";
export type { MarkdownBlock, MarkdownImporterOptions } from "./interop/markdown.js";
export { commitPreparedImport, importNotionItems, inferCSVType, leadingEmoji, parseCSVValue, preparedImportFromWire, preparedImportToWire, prepareImport } from "./interop/notion-import.js";
export type { ImportSource, NotionImportOptions, PreparedImport, PreparedImportWire } from "./interop/notion-import.js";
export { findObsidianVault, ObsidianImporter, parseWikiTarget, splitFrontmatter, yamlList, type ObsidianImportOptions } from "./interop/obsidian-import.js";
export { EnexImporter, enexDate, enmlToHTML, parseEnex, type EnexNote, type EnexResource } from "./interop/enex-import.js";
export { md5Hex } from "./interop/md5.js";
export { exportOPML, importOPML, parseOPML, type OutlineNode as OPMLOutline } from "./interop/opml.js";
export { DocxImporter, parseXML, type XNode } from "./interop/docx-import.js";
export { exportDocx, imageSize, type DocxExportOptions } from "./interop/docx-export.js";
export { parseJSONFile, planJSONImport, type JSONImportPlan } from "./interop/json-import.js";
export { exportPageJSON } from "./interop/json-export.js";
export { encodeURLPath, MarkdownExporter, markdownFileName, visiblePropertyIDs as exportVisiblePropertyIDs } from "./interop/markdown-export.js";
export type { MarkdownExporterOptions, PageLink } from "./interop/markdown-export.js";
export { toRichText, runsOf, replaceInRichText } from "./interop/runs.js";
export { EXPORT_CSS, PRINT_CSS, exportHTMLPage } from "./interop/html-document.js";
export type { HTMLDocumentOptions } from "./interop/html-document.js";
export { base64Encode, embeddableImageType, exportAssetRefs, exportPageHTML, exportWorkspaceHTML, printPageHTML } from "./interop/html-export.js";
export type { HTMLExportOptions, HTMLExportResult } from "./interop/html-export.js";
export { ASSETS_FOLDER, defaultHTMLPageLink, encodeExportPath, exportSummary, planWorkspaceExport, relativeExportPath, subpages, topLevelPages, uniqueExportName, writeExportZip } from "./interop/workspace-export.js";
export type { ExportFormat, ExportPlan, ExportPlanOptions, ExportReport } from "./interop/workspace-export.js";
export { ARCHIVE_FORMAT, ARCHIVE_PLAIN_VERSION, ARCHIVE_VERSION, ArchiveError, PACKAGE_EXTENSION, PACKAGE_RECORDS, applyImported, archiveAssetRefs, archiveEntryPath,
  assetRefForEntry, encodeArchive, importArchive, importArchiveRecords, isArchive, loadArchive, mergeWorkspace, readArchive, writeArchive, writeArchivePackage } from "./interop/archive.js";
export type { ArchiveHeader, ArchiveImportResult, ArchiveReadResult, LoadedArchive } from "./interop/archive.js";
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
  databasesNeedingIDCheck, repairUniqueIDs, uniqueIDRepair, valuesMatchingSchema,
} from "./store/database-ops.js";
export type { AddRowOptions, CreatedDatabase, InsertPosition as RowInsertPosition } from "./store/database-ops.js";
export { chartDateBucket, chartNumber, chartPoints } from "./query/chart.js";
export type { ChartPoint } from "./query/chart.js";
export {
  ADDABLE_PROPERTY_TYPES, CALCULATION_LABELS, FILTER_OP_LABELS, NUMBER_FORMAT_LABELS, NUMBER_FORMATS, PROPERTY_TYPE_LABELS,
  READ_ONLY_TYPES, RELATIVE_DATE_LABELS, calculationOptions, calculationText, formatDateCell, formatNumber, formatValue,
} from "./query/display.js";
export { changeAffects, databaseDependencies, watchDatabase } from "./query/dependencies.js";
// BSD-8: Kalender und Timeline – Datumslogik (Tagesraster, Zeiträume, Spuren, Zeitachse) und Schreib-Operationen.
export {
  CALENDAR_PROPERTY_TYPES, SpanIndex, TIMELINE_SCALES, addMonths, calendarDateProperty, calendarEndProperty, dateOfDay, dayFromYMD, dayOf,
  dayStart, daysInMonth, formatDay, layoutLanes, monthGrid, nextUnit, resizeSpan, rowSpan, rowSpans, shiftSpan, spanLabel, startOfMonth,
  startOfQuarter, startOfWeek, startOfYear, timelineRange, timelineTicks, today, unitStart, weekStartForLocale, weekdayOf, ymdOf,
} from "./query/calendar.js";
export type { LaneLayout, LanePlacement, RowSpan, TimelineScale, TimelineTick } from "./query/calendar.js";
export { addRowOnDay, canWriteSpan, databaseIDOfRow, moveRowSpan, resizeRowSpan, setRowSpan, storedDate, storedSpanDays } from "./store/calendar-ops.js";
export type { SpanProperties } from "./store/calendar-ops.js";
// BSD-73: Versionsverlauf pro Seite (git-artig, dedupliziert; Format wie Swift VersionHistory.swift)
export { MemoryHistoryStorage, VersionHistory, compressObject, decompressObject, encodeVersionBlock, versionHash as historyHash, wordCount as versionWordCount } from "./history/version-history.js";
export type { HistoryStats, HistoryStorage, HistoryVersion, VersionContent, VersionHistoryOptions } from "./history/version-history.js";
export { restoreVersion, versionBlocks } from "./history/restore.js";
export type { RestoreOptions, RestoreResult } from "./history/restore.js";
// Editor-Parität: Einfügen (Markdown-Erkennung), Datums-Erwähnungen, Gliederung, Backlinks, Synced Blocks.
export { hasInlineMarkdown, isMarkdownBlockLine, looksLikeMarkdown, pasteKind } from "./editor/paste.js";
export type { PasteInput, PasteKind } from "./editor/paste.js";
export { dateMentionValue, dateParts, dateSuggestions, parseTypedDate, withDateParts } from "./editor/date-mention.js";
export type { DateMentionValue, DateParts, DateSuggestion } from "./editor/date-mention.js";
export { activeHeadingIndex, headingOutline, withDepth } from "./editor/headings.js";
export type { HeadingSource, OutlineHeading } from "./editor/headings.js";
export { countWords, findInText, foldWithMap, pageTextStats, textStats } from "./editor/text-stats.js";
export type { TextMatch, TextStats } from "./editor/text-stats.js";
export { EMOJI_CATALOG, RANDOM_ICONS, randomIcon, searchEmoji } from "./editor/emoji.js";
export type { EmojiEntry } from "./editor/emoji.js";
export { COVER_HEIGHT_MAX, COVER_HEIGHT_MIN, coverHeight, setCoverHeight } from "./store/page-options.js";
export { pageCover, pageFormat, setCoverPosition, setPageCover, setPageFormat, setPageIcon, setPageIconImage } from "./store/page-options.js";
export type { CoverAsset, PageCoverValue, PageFont, PageFormatPatch } from "./store/page-options.js";
export { CODE_LANGUAGES, syntaxTokens } from "./editor/syntax.js";
export type { SyntaxKind, SyntaxToken } from "./editor/syntax.js";
export { embedTarget } from "./editor/embed.js";
export type { EmbedTarget } from "./editor/embed.js";
export { LinkIndex, backlinksTo, containingPage, linkedPages, mentionedPages } from "./store/links.js";
export { syncedCopies, syncedDependencies, syncedInstances, syncedOriginal, syncedPasteProblem, trashedRoot, unsyncCopy } from "./store/synced.js";
export type { SyncedPasteProblem } from "./store/synced.js";
// BSD-226: Meeting-Notizen (Datenmodell, Transkript-Chunks, Zeitstempel, Zitate, Zusammenfassung)
export {
  ME_SPEAKER, OTHERS_SPEAKER, TRANSCRIPT_CHUNK_SIZE, assignSpeakers, citations, secondsFromTimecode, segmentOrder, segmentsFromWords, speakerName,
  speakerOf, splitCitations, timecode, transcriptParagraphs, transcriptText, vocabularyFromContext,
} from "./model/meeting.js";
export type {
  AudioTrackRole, Citation, MeetingContextItem, MeetingInfo, MeetingSectionKind, MeetingSpeaker, MeetingStatus, MeetingTrack, SpeakerTurn,
  TranscriptParagraph, TranscriptSegment, TranscriptWord,
} from "./model/meeting.js";
export {
  addMeetingContext, addMeetingTrack, appendTranscript, applyMeetingSummary, applySpeakerTurns, createMeeting, editTranscript, findMeetingSection,
  meetingContaining, meetingContextText, meetingInfo, meetingNotesText, meetingSection, meetingSummaryTexts, meetingTitleFor, meetingTranscript,
  meetingVocabulary, mergeSpeakers, mergedSpeakers, removeMeetingContext, renameSpeaker, replaceTranscript, setMeetingStatus, setMeetingTitle,
  setSegmentSpeaker, stampNote, stampedNotes, transcriptChunks, unstampedNotes, updateMeeting,
} from "./store/meeting-ops.js";
export type { CreateMeetingOptions } from "./store/meeting-ops.js";
// BSD-217: Import über die Notion-API.
export { NotionWorkspaceImport, NotionClient, NotionAPIError, fetchTransport, notionTarget, parseNotionTargets, NotionCrawler, mapNotionSnapshot,
  convertNotionFormula, readableNotionFormula, emptySnapshot, notionFileKey, defaultNotionImportOptions } from "./interop/notion-api/index.js";
export type { NotionTransport, NotionResponse, NotionImportOptions as NotionAPIImportOptions, NotionSnapshot, NotionRoot, NotionAPIErrorKind } from "./interop/notion-api/index.js";
// BSD-230: Datei-Verweise auf den synchronisierten Speicher umschreiben.
export { assetIDsInStore, remapAssetRefs, remapStoreAssets } from "./interop/asset-ids.js";
export { graphemes, firstGrapheme, graphemeCount } from "./graphemes.js";
export { BUTTON_ACTION_KINDS, buttonActionName, buttonLabel, contentBlocks, describeButtonAction, effectiveButtonActions, isKnownButtonAction, runButton, setButton } from "./store/button-ops.js";
export type { ButtonAction, ButtonActionKind, ButtonEffect, ButtonPause, OpenMode, RunButtonOptions } from "./store/button-ops.js";
export {
  beginSession, buildReport, DiagnosticsLog, endSession, formatEntry, heartbeat, LOG_LIMIT, previousSessionNotice, redact, SESSION_KEY, startStallDetector,
  type DiagnosticsEntry, type DiagnosticsLevel, type DiagnosticsStorage, type ReportFacts, type SessionRecord, type StallDetectorOptions,
} from "./diagnostics.js";
export {
  WB_KINDS, backZ, bounds, danglingConnectors, frontZ, parseWBObject, sortByZ, wbFields,
  type ConnectorEnd, type ConnectorShape, type ConnectorSide, type WBConnector, type WBKind, type WBObject, type WBShape, type WBStyleValue,
} from "./whiteboard/model.js";
export { decodeInk, encodeInk, INK_SCALE, INK_VERSION, InkFormatError, type InkPoint } from "./whiteboard/ink.js";
