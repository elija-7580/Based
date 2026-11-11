// BSD-148: Datenmodell von Based als Zod-Schemas – das Wire-Format (Sync v2, docs/sync-protocol.md),
// genau so, wie die Swift-App es schreibt. Abgeleitet aus Swift/BasedCore/Sources/BasedCore/Model/*.swift
// (Codable-Implementierungen); ab jetzt ist dieses Schema die Quelle für den TypeScript-Stack.
//
// Abgesichert durch fixtures/records/ (von `swift run based-fixtures` erzeugt):
//  - corpus.jsonl: jeder Record parst und serialisiert byte-gleich zurück,
//  - schema.json: bekannte Schlüssel und Enum-Werte stimmen mit Swift überein (Drift-Check).
//
// Regeln (ADR 0002, Vorwärtskompatibilität):
//  - Objekte sind „loose“: unbekannte Felder bleiben erhalten und werden zurückgeschrieben.
//  - Offene Enums (`openEnum`) akzeptieren jeden String; bekannte Werte sind nur für Typen/Autovervollständigung.
//  - Enums mit Werten (PropertyValue, CardCover, FilterItem) akzeptieren unbekannte Fälle als rohes JSON.
//  - Kein `.default()`, keine Transformationen: Parsen ändert nie die Daten.
// Swift-Eigenheiten im Format: `Date` = Sekunden seit 2001-01-01 (Zahl); Enum-Fälle mit Wert als
// `{"fall":{"_0":wert}}`, ohne Wert als `{"fall":{}}`.
import { z } from "zod";
import { jsonValue, type JSONValue } from "../json.js";

// MARK: Helfer

type Open<T extends string> = T | (string & {});

/** Enum, das unbekannte Werte behält (Swift: OpenRawEnum / OpenStringEnum). */
function openEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return Object.assign(z.string(), { known: values }) as unknown as z.ZodType<Open<T[number]>> & { readonly known: T };
}

/** Swift-Enum-Fall mit einem Wert: `{"name":{"_0":wert}}`. */
function caseOf<const K extends string, S extends z.ZodType>(name: K, value: S) {
  return z.strictObject({ [name]: z.looseObject({ _0: value }) } as { [P in K]: z.ZodObject<{ _0: S }, z.core.$loose> });
}

/** Swift-Enum-Fall ohne Wert: `{"name":{}}`. */
function bareCase<const K extends string>(name: K) {
  return z.strictObject({ [name]: z.looseObject({}) } as { [P in K]: z.ZodObject<Record<never, never>, z.core.$loose> });
}

/** Unbekannter Fall einer neueren Version: Objekt mit genau einem Schlüssel, der nicht bekannt ist. */
function unknownCase(known: readonly string[]) {
  const names = new Set(known);
  return z.record(z.string(), jsonValue).refine((o) => {
    const keys = Object.keys(o);
    return keys.length === 1 && !names.has(keys[0]!);
  }, "kein unbekannter Enum-Fall") as unknown as z.ZodType<{ [key: string]: JSONValue }>;
}

const int = z.number().int();
/** Swift `Date` (Sekunden seit 2001-01-01). */
export const swiftDate = z.number();
export const recordID = z.string();

// MARK: Enums (Werte wie in Swift; Reihenfolge = alphabetisch wie in fixtures/records/schema.json)

export const ENUMS = {
  BlockType: ["audio", "bookmark", "breadcrumb", "bulletedList", "button", "callout", "code", "column", "columnList", "databaseInline", "databasePage", "divider", "embed", "equation", "file", "heading1", "heading2", "heading3", "heading4", "image", "linkToPage", "meeting", "meetingSection", "numberedList", "page", "pdf", "quote", "syncedBlock", "table", "tableOfContents", "tableRow", "text", "todo", "toggle", "transcript", "video"],
  PropertyType: ["button", "checkbox", "createdBy", "createdTime", "date", "email", "files", "formula", "lastEditedBy", "lastEditedTime", "multiSelect", "number", "person", "phone", "place", "relation", "rollup", "select", "status", "text", "title", "uniqueID", "url", "verification"],
  ViewType: ["board", "calendar", "chart", "dashboard", "feed", "form", "gallery", "list", "map", "table", "timeline"],
  FilterOp: ["after", "before", "contains", "endsWith", "equals", "greater", "greaterOrEqual", "isEmpty", "isNotEmpty", "less", "lessOrEqual", "notContains", "notEquals", "onOrAfter", "onOrBefore", "startsWith", "within"],
  TColor: ["blue", "blueBackground", "brown", "brownBackground", "default", "gray", "grayBackground", "green", "greenBackground", "orange", "orangeBackground", "pink", "pinkBackground", "purple", "purpleBackground", "red", "redBackground", "yellow", "yellowBackground"],
  NumberFormat: ["dollar", "euro", "franc", "lira", "number", "numberWithCommas", "percent", "pound", "real", "ruble", "rupee", "won", "yen", "yuan"],
  CalculationType: ["average", "checked", "countAll", "countEmpty", "countNotEmpty", "countUnique", "countValues", "dateRange", "earliest", "latest", "max", "median", "min", "none", "percentChecked", "percentEmpty", "percentNotEmpty", "percentUnchecked", "range", "showOriginal", "sum", "unchecked"],
  Combinator: ["and", "or"],
  RelativeDate: ["nextMonth", "nextWeek", "nextYear", "pastMonth", "pastWeek", "pastYear", "today", "tomorrow", "yesterday"],
  OpenMode: ["centerPeek", "fullPage", "sidePeek"],
  ChartKind: ["area", "bar", "donut", "horizontalBar", "line", "number", "pie"],
  ChartAggregate: ["average", "count", "max", "median", "min", "sum"],
  ChartDateBucket: ["day", "month", "quarter", "week", "year"],
  ButtonActionKind: ["addPage", "confirm", "insertBlocks", "openAdded", "openPage", "openURL"],
  MeetingSectionKind: ["notes", "summary"],
  CardSize: ["large", "medium", "small"],
  DateGrouping: ["day", "month", "relative", "week", "year"],
  PageFont: ["default", "mono", "serif"],
  AudioTrackRole: ["microphone", "mixed", "system", "upload"],
  // `property` gibt es nur im TS-Stack (BSD-30, ADR 0014); die eingefrorene Swift-App kennt die Art nicht.
  RecordKind: ["block", "database", "view", "workspace", "property"],
  PropertyValueCase: ["checkbox", "date", "email", "files", "multiSelect", "number", "person", "phone", "place", "relation", "select", "status", "text", "uniqueID", "url"],
  CardCoverCase: ["none", "pageContent", "pageCover", "pageIcon", "property"],
} as const;

export const blockType = openEnum(ENUMS.BlockType);
export const propertyType = openEnum(ENUMS.PropertyType);
export const viewType = openEnum(ENUMS.ViewType);
export const filterOp = openEnum(ENUMS.FilterOp);
export const tColor = openEnum(ENUMS.TColor);
export const numberFormat = openEnum(ENUMS.NumberFormat);
export const calculationType = openEnum(ENUMS.CalculationType);
export const combinator = openEnum(ENUMS.Combinator);
export const relativeDate = openEnum(ENUMS.RelativeDate);
export const openMode = openEnum(ENUMS.OpenMode);
export const buttonActionKind = openEnum(ENUMS.ButtonActionKind);
export const meetingSectionKind = openEnum(ENUMS.MeetingSectionKind);
// In Swift geschlossen (unbekannter Wert = Fehler beim Dekodieren):
export const cardSize = z.enum(ENUMS.CardSize);
export const dateGrouping = z.enum(ENUMS.DateGrouping);
export const pageFont = z.enum(ENUMS.PageFont);
export const audioTrackRole = z.enum(ENUMS.AudioTrackRole);
export const recordKind = z.enum(ENUMS.RecordKind);
export const meetingStatus = z.enum(["done", "failed", "paused", "processing", "ready", "recording"]);
export const meetingSummaryState = z.enum(["done", "failed", "pending", "running", "unavailable"]);
export const meetingContextKind = z.enum(["file", "page", "text", "url"]);

// MARK: Grundtypen

/** HLC-Stempel; Ordnung: millis, dann counter, dann node. */
export const stamp = z.looseObject({ millis: int, counter: int.nonnegative(), node: z.string() });
/** Elternverweis: `w` (Workspace), `b:<blockID>`, `d:<databaseID>`. */
export const parentRef = z.string().regex(/^(w|b:[\s\S]*|d:[\s\S]*)$/, "ungültiger parent");

export const assetRef = z.looseObject({ id: z.string(), name: z.string(), size: int.optional(), mime: z.string().optional() });
export const dateValue = z.looseObject({ start: swiftDate, end: swiftDate.optional(), includeTime: z.boolean(), remind: z.boolean().optional() });

export const marks = z.looseObject({
  b: z.boolean().optional(), i: z.boolean().optional(), u: z.boolean().optional(), s: z.boolean().optional(), c: z.boolean().optional(),
  color: tColor.optional(), link: z.string().optional(),
});
export const mention = z.union([caseOf("page", recordID), caseOf("date", dateValue), caseOf("user", z.string()), caseOf("link", z.string())]);
export const textRun = z.looseObject({ t: z.string().optional(), m: marks.optional(), mention: mention.optional(), eq: z.string().optional() });
/** Reiner Text als String, sonst Liste von Läufen. */
export const richText = z.union([z.string(), z.array(textRun)]);

export const pageIcon = z.union([
  z.string(),
  z.looseObject({ asset: assetRef.optional(), url: z.string().optional(), symbol: z.string().optional(), emoji: z.string().optional() }),
]);
export const pageCover = z.union([caseOf("gradient", int), caseOf("color", tColor), caseOf("asset", assetRef), caseOf("url", z.string())]);
export const pageFormat = z.looseObject({
  font: pageFont.optional(), smallText: z.boolean().optional(), fullWidth: z.boolean().optional(), locked: z.boolean().optional(),
  coverPosition: z.number().optional(), coverHeight: z.number().optional(), hideBacklinks: z.boolean().optional(), hideOutline: z.boolean().optional(),
});
export const bookmarkMeta = z.looseObject({
  title: z.string().optional(), summary: z.string().optional(), imageURL: z.string().optional(), iconURL: z.string().optional(),
});

// MARK: Property-Werte

export const fileValue = z.looseObject({ name: z.string(), asset: assetRef.optional(), url: z.string().optional() });
export const propertyValue = z.union([
  caseOf("text", richText), caseOf("number", z.number()), caseOf("select", z.string()), caseOf("multiSelect", z.array(z.string())),
  caseOf("status", z.string()), caseOf("date", dateValue), caseOf("person", z.array(z.string())), caseOf("files", z.array(fileValue)),
  caseOf("checkbox", z.boolean()), caseOf("url", z.string()), caseOf("email", z.string()), caseOf("phone", z.string()),
  caseOf("relation", z.array(recordID)), caseOf("uniqueID", int), caseOf("place", z.string()),
  unknownCase(ENUMS.PropertyValueCase),
]);

// MARK: Block

export const buttonAction = z.looseObject({
  kind: buttonActionKind, targetID: recordID.optional(), openAfter: z.boolean().optional(),
  values: z.record(z.string(), propertyValue).optional(), title: z.string().optional(), mode: openMode.optional(),
  step: int.optional(), url: z.string().optional(), message: z.string().optional(),
});
export const meetingInfo = z.looseObject({
  status: meetingStatus, startedAt: swiftDate.optional(), endedAt: swiftDate.optional(), duration: z.number().optional(),
  tracks: z.array(z.looseObject({ role: audioTrackRole, asset: assetRef, offset: z.number(), duration: z.number().optional() })).optional(),
  speakers: z.array(z.looseObject({ id: z.string(), name: z.string(), isMe: z.boolean().optional(), color: tColor.optional() })).optional(),
  context: z.array(z.looseObject({
    id: z.string(), kind: meetingContextKind, pageID: recordID.optional(), asset: assetRef.optional(), text: z.string().optional(), title: z.string().optional(),
  })).optional(),
  attendees: z.array(z.string()).optional(), vocabulary: z.array(z.string()).optional(), language: z.string().optional(),
  engine: z.string().optional(), summary: meetingSummaryState.optional(), summaryEngine: z.string().optional(),
  summaryInstructions: z.string().optional(), consentNotice: z.boolean().optional(), error: z.string().optional(),
});
/** Zeitstempel in Sekunden ab Aufnahmebeginn; kurze Schlüssel wie in Swift. */
export const transcriptSegment = z.looseObject({
  id: z.string(), s: z.number(), e: z.number(), sp: z.string().optional(), tr: audioTrackRole.optional(), t: z.string(), p: z.boolean().optional(),
});

export const blockProps = z.looseObject({
  checked: z.boolean().optional(), color: tColor.optional(), language: z.string().optional(), wrap: z.boolean().optional(),
  caption: richText.optional(), url: z.string().optional(), asset: assetRef.optional(), icon: pageIcon.optional(),
  cover: pageCover.optional(), isOpen: z.boolean().optional(), toggleable: z.boolean().optional(), expression: z.string().optional(),
  ratio: z.number().optional(), tableColumns: int.optional(), tableHeaderRow: z.boolean().optional(), tableHeaderColumn: z.boolean().optional(),
  cells: z.array(richText).optional(), tableColumnWidths: z.array(z.number()).optional(),
  tableColumnColors: z.array(tColor.nullable()).optional(), cellColors: z.array(tColor.nullable()).optional(),
  databaseID: recordID.optional(), viewIDs: z.array(recordID).optional(), linkTarget: recordID.optional(), syncSource: recordID.optional(),
  format: pageFormat.optional(), bookmark: bookmarkMeta.optional(), width: z.number().optional(), isTemplate: z.boolean().optional(),
  buttonLabel: z.string().optional(), buttonAction: buttonAction.optional(), buttonActions: z.array(buttonAction).optional(),
  teamspace: recordID.optional(), meeting: meetingInfo.optional(), meetingSection: meetingSectionKind.optional(),
  segments: z.array(transcriptSegment).optional(), meetingTime: z.number().optional(),
});

export const block = z.looseObject({
  id: recordID, type: blockType, parent: parentRef, sk: z.string(), text: richText.optional(), props: blockProps.optional(),
  values: z.record(z.string(), propertyValue).optional(), createdAt: swiftDate, updatedAt: swiftDate,
  createdBy: z.string().optional(), updatedBy: z.string().optional(), trashedAt: swiftDate.optional(),
  /** Fehlt nur bei sehr alten Records (dann wie Stamp.zero). */
  stamp: stamp.optional(),
});

// MARK: Database

export const selectOption = z.looseObject({ id: z.string(), name: z.string(), color: tColor });
export const statusGroup = z.looseObject({ id: z.string(), name: z.string(), color: tColor, optionIDs: z.array(z.string()) });
export const relationConfig = z.looseObject({ databaseID: recordID, syncedPropertyID: z.string().optional(), limitOne: z.boolean().optional() });
export const rollupConfig = z.looseObject({ relationPropertyID: z.string(), targetPropertyID: z.string(), function: calculationType });

export const propertySchema = z.looseObject({
  id: z.string(), name: z.string(), type: propertyType, options: z.array(selectOption).optional(),
  statusGroups: z.array(statusGroup).optional(), numberFormat: numberFormat.optional(), formula: z.string().optional(),
  relation: relationConfig.optional(), rollup: rollupConfig.optional(), idPrefix: z.string().optional(),
  dateFormat: z.string().optional(), description: z.string().optional(),
});

export const database = z.looseObject({
  id: recordID, blockID: recordID, title: richText, summary: richText.optional(), properties: z.array(propertySchema),
  templateIDs: z.array(recordID).optional(), defaultTemplateID: recordID.optional(), nextUniqueID: int.optional(),
  locked: z.boolean().optional(), createdAt: swiftDate, updatedAt: swiftDate, stamp,
});

/**
 * BSD-30 (ADR 0014): eine Property als eigener Record. `id` = `<databaseID>/<propertyID>` (Property-IDs sind nur je
 * Datenbank eindeutig), `sk` = Reihenfolge in der Datenbank, `schema` = die Property wie bisher in `database.properties`.
 */
export const propertyRecord = z.looseObject({ id: recordID, databaseID: recordID, sk: z.string(), schema: propertySchema, stamp });

// MARK: View

export const filterValue = z.union([
  caseOf("text", z.string()), caseOf("number", z.number()), caseOf("bool", z.boolean()), caseOf("date", swiftDate),
  caseOf("relative", relativeDate), caseOf("options", z.array(z.string())),
]);
export const filterCondition = z.looseObject({
  id: z.string(), propertyID: z.string(), op: filterOp,
  /** Unlesbare Werte einer neueren Version bleiben als rohes JSON erhalten. */
  value: z.union([filterValue, jsonValue]).optional(),
});

export type FilterValue = z.infer<typeof filterValue>;
export type FilterCondition = z.infer<typeof filterCondition>;
export type FilterGroup = { combinator: Open<(typeof ENUMS.Combinator)[number]>; items: FilterItem[]; [key: string]: unknown };
export type FilterItem =
  | { condition: { _0: FilterCondition; [key: string]: unknown } }
  | { group: { _0: FilterGroup; [key: string]: unknown } }
  | { [key: string]: JSONValue };

export const filterItem: z.ZodType<FilterItem> = z.lazy(() =>
  z.union([caseOf("condition", filterCondition), caseOf("group", filterGroup), unknownCase(["condition", "group"])]),
);
const filterGroupObject = z.looseObject({
  combinator,
  get items() {
    return z.array(filterItem);
  },
});
export const filterGroup = filterGroupObject as unknown as z.ZodType<FilterGroup>;

export const sortRule = z.looseObject({ propertyID: z.string(), ascending: z.boolean() });
export const groupRule = z.looseObject({
  propertyID: z.string(), hiddenGroups: z.array(z.string()).optional(), hideEmptyGroups: z.boolean().optional(),
  groupOrder: z.array(z.string()).optional(), dateGrouping: dateGrouping.optional(),
});
export const viewProperty = z.looseObject({ id: z.string(), visible: z.boolean(), width: z.number().optional() });
export const cardCover = z.union([
  bareCase("none"), bareCase("pageCover"), bareCase("pageContent"), bareCase("pageIcon"), caseOf("property", z.string()),
  unknownCase(ENUMS.CardCoverCase),
]);
export const chartConfig = z.looseObject({
  kind: openEnum(ENUMS.ChartKind), xPropertyID: z.string().optional(), yPropertyID: z.string().optional(),
  aggregate: openEnum(ENUMS.ChartAggregate), dateBucket: openEnum(ENUMS.ChartDateBucket),
  showLegend: z.boolean(), showValues: z.boolean(), sortByValue: z.boolean(), limit: int.optional(),
  caption: z.string().optional(), colorTheme: z.string().optional(), height: z.string().optional(),
});
export const dashboardWidget = z.looseObject({ id: z.string(), viewID: recordID, width: int });
export const dashboardRow = z.looseObject({ id: z.string(), widgets: z.array(dashboardWidget), height: z.number().optional() });
export const dashboardConfig = z.looseObject({ rows: z.array(dashboardRow) });

export const databaseView = z.looseObject({
  id: recordID, databaseID: recordID, blockID: recordID, name: z.string(), type: viewType,
  filter: filterGroup.optional(), sorts: z.array(sortRule).optional(), groupBy: groupRule.optional(),
  properties: z.array(viewProperty).optional(), calculations: z.record(z.string(), calculationType).optional(),
  datePropertyID: z.string().optional(), endDatePropertyID: z.string().optional(), cardCover: cardCover.optional(),
  cardSize: cardSize.optional(), wrapCells: z.boolean().optional(), openIn: openMode.optional(), showIcons: z.boolean().optional(),
  loadLimit: int.optional(), chart: chartConfig.optional(), mapPropertyID: z.string().optional(), mapHeight: z.string().optional(),
  dashboard: dashboardConfig.optional(), widgetOf: recordID.optional(), sortKey: z.string(),
  createdAt: swiftDate, updatedAt: swiftDate, stamp,
});

// MARK: Workspace

export const teamspace = z.looseObject({ id: recordID, name: z.string(), icon: pageIcon.optional(), createdAt: swiftDate });
export const workspace = z.looseObject({
  id: recordID, name: z.string(), icon: pageIcon.optional(), favorites: z.array(recordID), teamspaces: z.array(teamspace).optional(),
  homePageID: recordID.optional(), createdAt: swiftDate, updatedAt: swiftDate, stamp,
});

// MARK: Records auf dem Draht

export const record = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("block"), data: block }),
  z.looseObject({ kind: z.literal("database"), data: database }),
  z.looseObject({ kind: z.literal("view"), data: databaseView }),
  z.looseObject({ kind: z.literal("workspace"), data: workspace }),
  z.looseObject({ kind: z.literal("property"), data: propertyRecord }),
]);
export const recordKey = z.looseObject({ kind: recordKind, id: recordID });
/** Löschung auf dem Draht (ADR 0002): ohne `stamp` von älteren Clients. */
export const tombstone = z.looseObject({ kind: recordKind, id: recordID, stamp: stamp.optional() });

/** Bekannte Schlüssel je Typ, für den Drift-Check gegen fixtures/records/schema.json. */
export const KNOWN_KEYS = {
  Block: Object.keys(block.shape),
  BlockProps: Object.keys(blockProps.shape),
  PropertySchema: Object.keys(propertySchema.shape),
  Database: Object.keys(database.shape),
  DatabaseView: Object.keys(databaseView.shape),
  Workspace: Object.keys(workspace.shape),
  FilterCondition: Object.keys(filterCondition.shape),
  FilterGroup: Object.keys(filterGroupObject.shape),
  SortRule: Object.keys(sortRule.shape),
  ChartConfig: Object.keys(chartConfig.shape),
  DashboardConfig: Object.keys(dashboardConfig.shape),
  DashboardRow: Object.keys(dashboardRow.shape),
  DashboardWidget: Object.keys(dashboardWidget.shape),
} as const;
