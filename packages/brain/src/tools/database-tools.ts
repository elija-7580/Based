// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Datenbanken: auflisten, Schema, Zeilen lesen und schreiben, Schema ändern, Ansichten. Die Logik liegt in
// `Databases`; hier stehen nur Name, Beschreibung, Argumente und die Antwort.
import { ENUMS, plainText, titleOf, WIDGET_TYPES, type JSONValue } from "@based/core";
const E = (k: keyof typeof ENUMS) => (ENUMS[k] as readonly string[]).join(", ");
import { bool, limitSchema, needStr, obj, offsetSchema, optNum, optStr, paged, pageID, S, str, stringMap, ToolError, type Args, type ToolDef } from "./base.js";
import type { ToolCtx } from "./context.js";
import type { ViewArgs } from "./databases.js";

const VALUES = stringMap("Property name → plain text value (empty string clears; options by name; multi-select comma-separated; dates YYYY-MM-DD; checkboxes Yes/No)");
const dbID = str("Database id (list_databases shows the ids)");

const VIEW_ARGS: Record<string, JSONValue> = {
  name: str("View name"),
  filters: {
    type: "array",
    description: "[{property, op, value}] — op: equals, notEquals, contains, notContains, isEmpty, isNotEmpty, greater, less, before, after, onOrBefore, onOrAfter",
    items: { type: "object", properties: { property: S, op: S, value: {} }, required: ["property"], additionalProperties: false },
  },
  filter_mode: { type: "string", enum: ["and", "or"] },
  sorts: { type: "array", description: "[{property, direction: ascending|descending}]", items: { type: "object", properties: { property: S, direction: S }, required: ["property"], additionalProperties: false } },
  group_by: str("Property name to group by (empty string clears)"),
};

const NAMES = { type: "array", items: S } as const;
/** Anzeige einer Ansicht (nur create_view/update_view, nicht query_database). */
const VIEW_LOOK: Record<string, JSONValue> = {
  properties: { ...NAMES, description: "Visible properties in this order; all others are hidden" },
  hide_empty_groups: { type: "boolean" },
  date_grouping: str(`For grouping by a date: ${E("DateGrouping")}`),
  wrap: bool("Wrap cell text"),
  open_in: str(`How rows open: ${E("OpenMode")}`),
  show_icons: { type: "boolean" }, show_title: { type: "boolean" },
  card_size: str(E("CardSize")),
  card_preview: str("none, pageCover, pageContent, pageIcon or a files property name"),
  date_property: str("Calendar/timeline: date property"),
  end_date_property: str("Timeline: end date property (empty string clears)"),
  map_property: str("Map: place property"),
  limit: { type: "integer", minimum: 0, description: "Rows loaded at first (0 = default)" },
  calculations: stringMap(`Property name → calculation in the table footer: ${E("CalculationType")} (none removes)`),
  chart: {
    type: "object", additionalProperties: false, description: "Chart view settings",
    properties: {
      kind: str(E("ChartKind")), x: str("Property on the x axis / slices"), y: str("Number property to aggregate"),
      aggregate: str(E("ChartAggregate")), date_bucket: str(E("ChartDateBucket")),
      show_legend: { type: "boolean" }, show_values: { type: "boolean" }, sort_by_value: { type: "boolean" }, limit: { type: "integer", minimum: 0 }, caption: S,
    },
  },
  form: {
    type: "object", additionalProperties: false, description: "Form view: title, description and per question {required, description}; which properties are asked and their order is `properties`",
    properties: { title: S, description: S, questions: { type: "object", additionalProperties: { type: "object", additionalProperties: false, properties: { required: { type: "boolean" }, description: S } } } },
  },
  add_widgets: { ...NAMES, description: `Dashboard view: widgets to add (${WIDGET_TYPES.join(", ")})` },
};
const ROWS_IN = (withID: boolean): JSONValue => ({
  type: "array", minItems: 1, maxItems: 200,
  items: { type: "object", additionalProperties: false, properties: { ...(withID ? { id: str("Row id") } : { template: str("Template title or id") }), title: S, values: VALUES }, required: withID ? ["id"] : [] },
});

const record = (a: Args, k: string): Record<string, string> => (a[k] && typeof a[k] === "object" && !Array.isArray(a[k]) ? (a[k] as Record<string, string>) : {});

export function databaseTools(ctx: ToolCtx): ToolDef[] {
  const { store } = ctx;
  const dbs = ctx.databases;
  return [
    {
      group: "databases", write: false,
      spec: { name: "list_databases", description: "Databases with ids, row counts and property schemas.", inputSchema: obj({ limit: limitSchema, offset: offsetSchema }) },
      run: (a) => paged(dbs.list(), Math.max(1, optNum(a, "limit", 50)), optNum(a, "offset", 0)),
    },
    {
      group: "databases", write: false, aliases: { database_id: "id" },
      spec: { name: "database_schema", description: "Properties of a database with types and allowed values.", inputSchema: obj({ id: dbID }, ["id"]) },
      run: (a) => dbs.schema(needStr(a, "id")),
    },
    {
      group: "databases", write: false, aliases: { database_id: "id" },
      spec: {
        name: "query_database",
        description: "Rows of a database as text. view: use a view's filters, sorts and visible properties (its footer calculations are appended). filters add conditions; search matches any cell; properties picks columns.",
        inputSchema: obj({
          id: dbID, view: str("View name or id"), filters: VIEW_ARGS.filters!, filter_mode: VIEW_ARGS.filter_mode!, properties: { ...NAMES, description: "Only these properties" },
          search: S, sort: str("Property name"), descending: bool("Sort descending"), limit: limitSchema, offset: offsetSchema,
        }, ["id"]),
      },
      run: (a) => {
        const r = dbs.queryWithFooter(needStr(a, "id"), {
          search: optStr(a, "search"), sort: optStr(a, "sort"), descending: a.descending === true, view: optStr(a, "view"),
          filters: a.filters as ViewArgs["filters"], filter_mode: optStr(a, "filter_mode"), properties: a.properties as string[] | undefined,
        });
        const text = paged(r.lines, Math.max(1, optNum(a, "limit", 50)), optNum(a, "offset", 0));
        return r.footer ? `${text}\n${r.footer}` : text;
      },
    },
    {
      group: "databases", write: true, aliases: { database_id: "id", properties: "values" },
      spec: {
        name: "add_row",
        description: "Add a row to a database; set properties by name with plain strings. A select option that does not exist yet is created. Returns the row id.",
        inputSchema: obj({ id: dbID, title: str("Row title (or set the title property in values)"), values: VALUES, template: str("Template title or id") }, ["id"]),
      },
      run: (a) => {
        const db = dbs.db(needStr(a, "id"));
        const rowID = dbs.addRow(db.id, record(a, "values"), optStr(a, "title"), optStr(a, "template"));
        return `Added row “${titleOf(store, rowID) || "Untitled"}” (id: ${rowID}) to “${plainText(db.title) || "Untitled"}”`;
      },
    },
    {
      group: "databases", write: true, aliases: { row_id: "id", properties: "values" },
      spec: {
        name: "update_row",
        description: "Change a database row: title and/or properties by name with plain strings (an empty string clears a property).",
        inputSchema: obj({ id: str("Row id"), title: S, values: VALUES }, ["id"]),
      },
      run: (a) => {
        const id = needStr(a, "id");
        const values = record(a, "values");
        const title = optStr(a, "title");
        if (title === undefined && Object.keys(values).length === 0) throw new ToolError("Give a title or values to change.");
        dbs.updateRow(id, values, title);
        return `Updated row “${titleOf(store, id) || "Untitled"}”`;
      },
    },
    {
      group: "databases", write: true, aliases: { database_id: "id" },
      spec: { name: "add_rows", description: "Add many rows in one step (all or nothing). Returns the row ids.", inputSchema: obj({ id: dbID, rows: ROWS_IN(false) }, ["id", "rows"]) },
      run: (a) => {
        const db = dbs.db(needStr(a, "id"));
        const ids = dbs.addRows(db.id, a.rows as Parameters<typeof dbs.addRows>[1]);
        return `Added ${ids.length} row${ids.length === 1 ? "" : "s"} to “${plainText(db.title) || "Untitled"}”:\n${ids.map((id) => `- ${titleOf(store, id) || "Untitled"} (id: ${id})`).join("\n")}`;
      },
    },
    {
      group: "databases", write: true,
      spec: { name: "update_rows", description: "Change many rows in one step (all or nothing).", inputSchema: obj({ rows: ROWS_IN(true) }, ["rows"]) },
      run: (a) => { const n = dbs.updateRows(a.rows as Parameters<typeof dbs.updateRows>[0]); return `Updated ${n} row${n === 1 ? "" : "s"}`; },
    },
    {
      group: "databases", write: true,
      spec: {
        name: "create_database",
        description: "Create a database, inline inside a page or as a full page. Properties: name → type (text, number, select, multiSelect, status, date, person, files, checkbox, url, email, phone, relation, place).",
        inputSchema: obj({
          title: S, parent_id: { ...pageID, description: "Parent page id (omit for workspace root)" },
          inline: bool("Embed in the parent page (default true when parent_id is given)"),
          properties: stringMap("name → property type"),
          view: str("First view layout: table, board, list, gallery, calendar, timeline"),
        }, ["title"]),
      },
      run: (a) => dbs.createDatabase(a as unknown as Parameters<typeof dbs.createDatabase>[0]),
    },
    {
      group: "databases", write: true, destructive: true,
      spec: {
        name: "update_database",
        description: "Change a database's schema: properties, options, formulas, relations, rollups, formats, templates, lock. Deleting a property or option, or changing a type or relation target, can discard values.",
        inputSchema: obj({
          database_id: dbID, title: S,
          add_properties: stringMap("name → type"),
          rename_properties: stringMap("old name → new name"),
          change_types: stringMap("name → new type"),
          delete_properties: NAMES,
          add_options: { type: "object", additionalProperties: NAMES, description: "select/status property name → option names" },
          update_options: { type: "object", description: "property → option name → {name, color, delete}", additionalProperties: { type: "object", additionalProperties: { type: "object", additionalProperties: false, properties: { name: S, color: S, delete: { type: "boolean" } } } } },
          option_order: { type: "object", additionalProperties: NAMES, description: "property → option names in the new order" },
          formulas: stringMap("property → formula, e.g. prop(\"Price\") * prop(\"Qty\") (creates the property if missing)"),
          relations: stringMap("property → id of the related database (creates the property if missing)"),
          two_way: stringMap("relation property → name of the mirror property in the other database (empty = default name)"),
          rollups: { type: "object", description: "property → {relation, property, function}", additionalProperties: { type: "object", additionalProperties: false, properties: { relation: S, property: S, function: S }, required: ["relation", "property"] } },
          number_formats: stringMap(`property → ${E("NumberFormat")}`),
          id_prefixes: stringMap("ID property → prefix (empty clears)"),
          descriptions: stringMap("property → description (empty clears)"),
          locked: bool("Lock the schema against edits in the app"),
          add_templates: { ...NAMES, description: "Titles of new row templates (fill them with edit_blocks / update_row by id)" },
          delete_templates: NAMES,
          default_template: str("Template title or id (empty string clears)"),
        }, ["database_id"]),
      },
      run: (a) => dbs.updateDatabase(a as unknown as Parameters<typeof dbs.updateDatabase>[0]),
    },
    {
      group: "databases", write: false,
      spec: { name: "list_views", description: "List the views of a database with their layout, filters, sorts and grouping.", inputSchema: obj({ database_id: dbID }, ["database_id"]) },
      run: (a) => dbs.listViews(needStr(a, "database_id")),
    },
    {
      group: "databases", write: true,
      spec: {
        name: "create_view",
        description: `Add a view (${E("ViewType")}) to a database, with filters, sorts, grouping and display settings.`,
        inputSchema: obj({ database_id: dbID, type: S, ...VIEW_ARGS, ...VIEW_LOOK }, ["database_id", "type"]),
      },
      run: (a) => dbs.createView(a as unknown as ViewArgs & { database_id: string; type: string }),
    },
    {
      group: "databases", write: true,
      spec: {
        name: "update_view",
        description: "Change a view: name, layout, filters, sorts, grouping, visible properties, calculations, chart. Passing filters/sorts replaces them; pass [] to clear.",
        inputSchema: obj({ view_id: S, type: S, ...VIEW_ARGS, ...VIEW_LOOK }, ["view_id"]),
      },
      run: (a) => dbs.updateViewTool(a as unknown as ViewArgs & { view_id: string }),
    },
    {
      group: "databases", write: true, destructive: true,
      spec: { name: "delete_view", description: "Delete a view of a database (the last view stays).", inputSchema: obj({ view_id: S }, ["view_id"]) },
      run: (a) => dbs.deleteViewTool(needStr(a, "view_id")),
    },
  ];
}
