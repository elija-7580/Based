// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Datenbanken: auflisten, Schema, Zeilen lesen und schreiben, Schema ändern, Ansichten. Die Logik liegt in
// `Databases`; hier stehen nur Name, Beschreibung, Argumente und die Antwort.
import { plainText, titleOf, type JSONValue } from "@based/core";
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
        description: "Rows of a database with property values as text. Optional text search across all cells and sort by a property name.",
        inputSchema: obj({ id: dbID, search: S, sort: str("Property name"), descending: bool("Sort descending"), limit: limitSchema, offset: offsetSchema }, ["id"]),
      },
      run: (a) => paged(dbs.query(needStr(a, "id"), { search: optStr(a, "search"), sort: optStr(a, "sort"), descending: a.descending === true }), Math.max(1, optNum(a, "limit", 50)), optNum(a, "offset", 0)),
    },
    {
      group: "databases", write: true, aliases: { database_id: "id", properties: "values" },
      spec: {
        name: "add_row",
        description: "Add a row to a database; set properties by name with plain strings. A select option that does not exist yet is created. Returns the row id.",
        inputSchema: obj({ id: dbID, title: str("Row title (or set the title property in values)"), values: VALUES }, ["id"]),
      },
      run: (a) => {
        const db = dbs.db(needStr(a, "id"));
        const rowID = dbs.addRow(db.id, record(a, "values"), optStr(a, "title"));
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
        description: "Rename a database, or add, rename, retype or delete properties, or add select options. Deleting a property or changing its type can discard its values.",
        inputSchema: obj({
          database_id: dbID, title: S,
          add_properties: stringMap("name → type"),
          rename_properties: stringMap("old name → new name"),
          change_types: stringMap("name → new type"),
          delete_properties: { type: "array", items: S },
          add_options: { type: "object", additionalProperties: { type: "array", items: S }, description: "select/status property name → option names" },
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
        description: "Add a view (table, board, list, gallery, calendar, timeline, map, form) to a database, optionally with filters, sorts and grouping.",
        inputSchema: obj({ database_id: dbID, type: S, ...VIEW_ARGS }, ["database_id", "type"]),
      },
      run: (a) => dbs.createView(a as unknown as ViewArgs & { database_id: string; type: string }),
    },
    {
      group: "databases", write: true,
      spec: {
        name: "update_view",
        description: "Change a view's name, layout, filters, sorts or grouping. Passing filters/sorts replaces them; pass [] to clear.",
        inputSchema: obj({ view_id: S, type: S, ...VIEW_ARGS }, ["view_id"]),
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
