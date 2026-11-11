// BSD-221: Datenbank-Werkzeuge für MCP (docs/mcp.md: list_databases, query_database, add_row, update_row) über den
// Kern-Funktionen (QueryEngine, addRow, setValue, addOption). Werte als einfacher Text, Properties per Name.
import {
  addOption, addProperty, addRow, addView, cellText, changePropertyType, createDatabase, deleteProperty, deleteView, ENUMS, isTrashed, parseCSVValue, values,
  plainText, QueryEngine, renameProperty, rowsOf, setDatabaseTitle, setRowTitle, setValue, updateView,
  type Database, type DatabaseView, type PropertySchema, type PropertyValue, type WorkspaceStore,
} from "@based/core";
import { PAGE_URI, ToolError } from "./pages.js";

const TYPE_HINT: Record<string, string> = {
  select: "one option name", status: "one option name", multiSelect: "option names, comma-separated", checkbox: "Yes / No",
  date: "YYYY-MM-DD or YYYY-MM-DD HH:mm", number: "number", relation: "read-only here", formula: "computed", rollup: "computed",
  createdTime: "automatic", createdBy: "automatic", lastEditedTime: "automatic", lastEditedBy: "automatic", uniqueID: "automatic",
};
const WRITABLE = new Set(["text", "number", "select", "status", "multiSelect", "date", "checkbox", "url", "email", "phone", "title"]);

export class Databases {
  constructor(readonly store: WorkspaceStore) {}

  private db(id: string): Database {
    const db = this.store.databases.get(id) ?? [...this.store.databases.values()].find((d) => d.blockID === id);
    if (!db) throw new ToolError(`No database with id ${id}. Use list_databases.`);
    const block = this.store.blocks.get(db.blockID);
    if (block && isTrashed(this.store, block.id)) throw new ToolError("This database is in the Trash.");
    return db;
  }

  private prop(db: Database, name: string): PropertySchema {
    const p = db.properties.find((x) => x.name === name) ?? db.properties.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!p) throw new ToolError(`No property “${name}”. Properties: ${db.properties.map((x) => x.name).join(", ")}`);
    return p;
  }

  private live(): Database[] {
    return [...this.store.databases.values()].filter((d) => {
      const b = this.store.blocks.get(d.blockID);
      return b !== undefined && !isTrashed(this.store, b.id);
    }).sort((a, b) => plainText(a.title).localeCompare(plainText(b.title)));
  }

  /** Eine Zeile je Datenbank: Titel, ID, Zeilenzahl, Properties mit Typ. */
  list(): string[] {
    return this.live().map((d) => {
      const props = d.properties.map((p) => `${p.name}: ${p.type}${p.options?.length ? ` [${p.options.map((o) => o.name).join(", ")}]` : ""}`).join("; ");
      return `- ${plainText(d.title) || "Untitled"} (id: ${d.id}) — ${rowsOf(this.store, d.id).length} rows — ${props}`;
    });
  }

  /** Zeilen mit Werten als Text; optional Suche in allen Zellen und Sortierung nach einer Property. */
  query(id: string, opts: { search?: string | undefined; sort?: string | undefined; descending?: boolean | undefined } = {}): string[] {
    const db = this.db(id);
    const engine = new QueryEngine(this.store);
    const props = db.properties;
    let rows = rowsOf(this.store, db.id).filter((r) => r.props?.isTemplate !== true);
    const cells = new Map(rows.map((r) => [r.id, props.map((p) => [p, cellText(this.store, engine.value(r, p, db))] as const)]));
    const q = opts.search?.trim().toLowerCase();
    if (q) rows = rows.filter((r) => cells.get(r.id)!.some(([, t]) => t.toLowerCase().includes(q)));
    if (opts.sort) {
      const p = this.prop(db, opts.sort);
      const key = (rid: string) => cells.get(rid)!.find(([x]) => x.id === p.id)?.[1] ?? "";
      rows = [...rows].sort((a, b) => key(a.id).localeCompare(key(b.id), undefined, { numeric: true }) * (opts.descending ? -1 : 1));
    }
    return rows.map((r) => {
      const all = cells.get(r.id)!;
      const title = all.find(([p]) => p.type === "title")?.[1] || "Untitled";
      const rest = all.filter(([p, t]) => p.type !== "title" && t !== "").map(([p, t]) => `${p.name}: ${t}`).join("; ");
      return `- [${title}](${PAGE_URI}${r.id})${rest ? ` — ${rest}` : ""}`;
    });
  }

  /** Schema als Markdown (für das Modell: was es schreiben darf und wie). */
  schema(id: string): string {
    const db = this.db(id);
    const lines = [`# ${plainText(db.title) || "Untitled"} (id: ${db.id})`, "", "| Property | Type | Values |", "|---|---|---|"];
    for (const p of db.properties) {
      const vals = p.options?.length ? p.options.map((o) => o.name).join(", ") : TYPE_HINT[p.type] ?? "text";
      lines.push(`| ${p.name} | ${p.type} | ${vals} |`);
    }
    return lines.join("\n");
  }

  private value(db: Database, p: PropertySchema, raw: string): PropertyValue | null {
    if (!WRITABLE.has(p.type)) throw new ToolError(`“${p.name}” (${p.type}) can't be set here.`);
    if (raw.trim() === "") return null;
    // Neue Optionen anlegen statt Werte still zu verlieren.
    if (p.type === "select" || p.type === "status" || p.type === "multiSelect") {
      const names = p.type === "multiSelect" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [raw.trim()];
      for (const n of names) {
        const fresh = this.store.databases.get(db.id)!.properties.find((x) => x.id === p.id)!;
        if (!fresh.options?.some((o) => o.name === n)) {
          if (p.type === "status") throw new ToolError(`“${n}” isn't a status of “${p.name}”. Options: ${(fresh.options ?? []).map((o) => o.name).join(", ")}`);
          addOption(this.store, db.id, p.id, n);
        }
      }
      p = this.store.databases.get(db.id)!.properties.find((x) => x.id === p.id)!;
    }
    const v = parseCSVValue(raw, p);
    if (v === undefined) throw new ToolError(`“${raw}” isn't a valid ${p.type} for “${p.name}” (${TYPE_HINT[p.type] ?? "text"}).`);
    return v;
  }

  /** Neue Zeile; Werte per Property-Name als Text. Gibt die Zeilen-ID zurück. */
  addRow(id: string, values: Record<string, string>): string {
    const db = this.db(id);
    this.precheck(db, values);
    const title = Object.entries(values).find(([k]) => this.prop(db, k).type === "title")?.[1] ?? "";
    const rowID = addRow(this.store, db.id, title ? { title } : {});
    if (!rowID) throw new ToolError("Couldn't add a row.");
    this.set(db, rowID, values);
    return rowID;
  }

  updateRow(rowID: string, values: Record<string, string>): void {
    const row = this.store.blocks.get(rowID);
    if (!row || !row.parent.startsWith("d:") || isTrashed(this.store, rowID)) throw new ToolError(`No database row with id ${rowID}.`);
    const db = this.db(row.parent.slice(2));
    this.precheck(db, values);
    this.set(db, rowID, values);
  }

  /** Alles prüfen, bevor etwas geschrieben wird (keine halb angelegten Zeilen). */
  private precheck(db: Database, values: Record<string, string>) {
    for (const [name, raw] of Object.entries(values)) {
      const p = this.prop(db, name);
      if (p.type === "title") continue;
      if (!WRITABLE.has(p.type)) throw new ToolError(`“${p.name}” (${p.type}) can't be set here.`);
      if (raw.trim() === "" || p.type === "select" || p.type === "multiSelect") continue;
      if (p.type === "status") {
        if (!p.options?.some((o) => o.name === raw.trim())) throw new ToolError(`“${raw}” isn't a status of “${p.name}”. Options: ${(p.options ?? []).map((o) => o.name).join(", ")}`);
        continue;
      }
      if (parseCSVValue(raw, p) === undefined) throw new ToolError(`“${raw}” isn't a valid ${p.type} for “${p.name}” (${TYPE_HINT[p.type] ?? "text"}).`);
    }
  }

  private set(db: Database, rowID: string, values: Record<string, string>) {
    for (const [name, raw] of Object.entries(values)) {
      const p = this.prop(db, name);
      if (p.type === "title") { setRowTitle(this.store, rowID, raw); continue; }
      setValue(this.store, rowID, p.id, this.value(db, p, raw));
    }
  }

  // MARK: Schema und Ansichten (BSD-221 Teil 3b, wie Swift AgentTools create_database/update_database/…_view)

  /** Typname aus dem Werkzeug (auch „rich_text“, „tags“, „people“ …) → Property-Typ. */
  static propertyType(s: string): string | undefined {
    const k = s.toLowerCase().replace(/[_-]/g, "");
    const known = ["title", "text", "number", "select", "multiSelect", "status", "date", "person", "files", "checkbox", "url", "email", "phone", "relation", "place", "formula", "rollup", "createdTime", "createdBy", "lastEditedTime", "lastEditedBy", "uniqueID", "button", "verification"];
    const hit = known.find((t) => t.toLowerCase() === k);
    if (hit) return hit;
    return ({ richtext: "text", string: "text", multiselect: "multiSelect", tags: "multiSelect", people: "person", file: "files", link: "url" } as Record<string, string>)[k];
  }

  createDatabase(a: { title: string; parent_id?: string | undefined; inline?: boolean | undefined; properties?: Record<string, string> | undefined; view?: string | undefined }): string {
    if (a.parent_id && !this.store.blocks.has(a.parent_id)) throw new ToolError(`No page ${a.parent_id}`);
    const props = Object.entries(a.properties ?? {}).map(([name, t]) => {
      const type = Databases.propertyType(t);
      if (!type || type === "title") throw new ToolError(`Unknown property type '${t}' for ${name}`);
      return [name, type] as const;
    });
    const viewType = a.view && (ENUMS.ViewType as readonly string[]).includes(a.view) ? a.view : "table";
    const made = createDatabase(this.store, { parent: a.parent_id ? "b:" + a.parent_id : "w", title: a.title, inline: a.inline ?? a.parent_id !== undefined, viewType, sampleRows: 0 });
    const added: string[] = [];
    for (const [name, type] of props) if (addProperty(this.store, made.databaseID, name, type) !== undefined) added.push(name);
    return `Created database ${made.databaseID} (block ${made.blockID}, view ${made.viewID})` + (added.length ? ` with properties: ${added.join(", ")}` : "");
  }

  updateDatabase(a: { database_id: string; title?: string | undefined; add_properties?: Record<string, string> | undefined; rename_properties?: Record<string, string> | undefined;
    change_types?: Record<string, string> | undefined; delete_properties?: string[] | undefined; add_options?: Record<string, string[]> | undefined }): string {
    const id = this.db(a.database_id).id;
    const cur = () => this.db(id);
    const log: string[] = [];
    // Erst alles prüfen, dann schreiben (kein halber Umbau bei einem Tippfehler).
    for (const [name, t] of Object.entries(a.add_properties ?? {})) if (!Databases.propertyType(t)) throw new ToolError(`Unknown type for ${name}`);
    for (const [name, t] of Object.entries(a.change_types ?? {})) { this.prop(cur(), name); if (!Databases.propertyType(t)) throw new ToolError(`Unknown type for ${name}`); }
    for (const old of Object.keys(a.rename_properties ?? {})) this.prop(cur(), old);
    for (const name of a.delete_properties ?? []) if (this.prop(cur(), name).type === "title") throw new ToolError("The title property cannot be deleted");
    for (const name of Object.keys(a.add_options ?? {})) this.prop(cur(), name);
    if (a.title !== undefined) { setDatabaseTitle(this.store, id, a.title); log.push("renamed"); }
    for (const [name, t] of Object.entries(a.add_properties ?? {})) { addProperty(this.store, id, name, Databases.propertyType(t)!); log.push(`added ${name}`); }
    for (const [old, name] of Object.entries(a.rename_properties ?? {})) { renameProperty(this.store, id, this.prop(cur(), old).id, name); log.push(`renamed ${old}`); }
    for (const [name, t] of Object.entries(a.change_types ?? {})) { changePropertyType(this.store, id, this.prop(cur(), name).id, Databases.propertyType(t)!); log.push(`retyped ${name}`); }
    for (const name of a.delete_properties ?? []) { deleteProperty(this.store, id, this.prop(cur(), name).id); log.push(`deleted ${name}`); }
    for (const [name, opts] of Object.entries(a.add_options ?? {})) {
      const p = this.prop(cur(), name);
      for (const o of opts) addOption(this.store, id, p.id, o);
      log.push(`options for ${name}`);
    }
    return log.length === 0 ? "Nothing to change." : "Updated database: " + log.join(", ");
  }

  private describe(item: unknown, db: Database): string {
    const it = item as { group?: { _0?: { combinator?: string; items?: unknown[] } }; condition?: { _0?: { propertyID: string; op: string; value?: Record<string, { _0?: unknown }> } } };
    if (it.group?._0) return "(" + (it.group._0.items ?? []).map((x) => this.describe(x, db)).join(` ${it.group._0.combinator ?? "and"} `) + ")";
    const c = it.condition?._0;
    if (!c) return "(filter from a newer version)";
    const p = db.properties.find((x) => x.id === c.propertyID);
    const [kind, raw] = Object.entries(c.value ?? {})[0] ?? [];
    const val = raw?._0;
    const v = kind === "options" && Array.isArray(val) ? val.map((o) => p?.options?.find((x) => x.id === o)?.name ?? String(o)).join("|")
      : kind === "date" && typeof val === "number" ? new Date((val + 978_307_200) * 1000).toISOString() : val === undefined ? "" : String(val);
    return `${p?.name ?? "?"} ${c.op} ${v}`.trim();
  }

  listViews(databaseID: string): string {
    const db = this.db(databaseID);
    const views = [...this.store.views.values()].filter((v) => v.blockID === db.blockID).sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    return views.map((v) => {
      let line = `- ${v.name} [view_id: ${v.id}] ${v.type}`;
      const f = v.filter as { combinator?: string; items?: unknown[] } | undefined;
      if (f?.items?.length) line += `; filter(${f.combinator ?? "and"}): ` + f.items.map((x) => this.describe(x, db)).join(", ");
      if (v.sorts?.length) line += "; sort: " + v.sorts.map((s) => `${db.properties.find((p) => p.id === s.propertyID)?.name ?? "?"} ${s.ascending === false ? "desc" : "asc"}`).join(", ");
      if (v.groupBy) line += `; group by ${db.properties.find((p) => p.id === v.groupBy!.propertyID)?.name ?? "?"}`;
      return line;
    }).join("\n") || "(no views)";
  }

  private filterValue(raw: unknown, p: PropertySchema): Record<string, { _0: unknown }> | undefined {
    if (raw === undefined || raw === null) return undefined;
    const s = typeof raw === "string" ? raw : Array.isArray(raw) ? String(raw[0] ?? "") : String(raw);
    switch (p.type) {
      case "number": return Number.isFinite(Number(s)) ? { number: { _0: Number(s) } } : undefined;
      case "checkbox": return { bool: { _0: ["true", "yes", "1", "checked"].includes(s.toLowerCase()) } };
      case "date": case "createdTime": case "lastEditedTime": {
        if ((ENUMS.RelativeDate as readonly string[]).includes(s)) return { relative: { _0: s } };
        const d = values.parseDate(s);
        return d ? { date: { _0: d.start } } : undefined;
      }
      case "select": case "status": case "multiSelect": {
        const names = Array.isArray(raw) ? raw.map(String) : [s];
        return { options: { _0: names.map((n) => {
          const o = p.options?.find((x) => x.name.toLowerCase() === n.toLowerCase());
          if (!o) throw new ToolError(`No option '${n}' in ${p.name}`);
          return o.id;
        }) } };
      }
      case "relation": return { options: { _0: Array.isArray(raw) ? raw.map(String) : [s] } };
      default: return { text: { _0: s } };
    }
  }

  private applyViewArgs(viewID: string, db: Database, a: ViewArgs) {
    let filter: unknown, sorts: unknown, group: unknown;
    const set = { filter: false, sorts: false, group: false };
    if (a.filters) {
      const items = a.filters.map((f) => {
        const p = this.prop(db, f.property);
        const op = f.op ?? "equals";
        if (!(ENUMS.FilterOp as readonly string[]).includes(op)) throw new ToolError(`Unknown filter op '${op}'`);
        const value = this.filterValue(f.value, p);
        return { condition: { _0: { id: globalThis.crypto.randomUUID(), propertyID: p.id, op, ...(value ? { value } : {}) } } };
      });
      filter = items.length ? { combinator: a.filter_mode === "or" ? "or" : "and", items } : undefined;
      set.filter = true;
    }
    if (a.sorts) {
      const s = a.sorts.map((x) => ({ propertyID: this.prop(db, x.property).id, ascending: !(x.direction ?? "").toLowerCase().startsWith("desc") }));
      sorts = s.length ? s : undefined;
      set.sorts = true;
    }
    if (a.group_by !== undefined) { group = a.group_by === "" ? undefined : { propertyID: this.prop(db, a.group_by).id }; set.group = true; }
    if (a.type !== undefined && !(ENUMS.ViewType as readonly string[]).includes(a.type)) throw new ToolError("Unknown layout");
    updateView(this.store, viewID, (v) => {
      const w = v as DatabaseView & Record<string, unknown>;
      if (set.filter) { if (filter) w.filter = filter as DatabaseView["filter"]; else delete w.filter; }
      if (set.sorts) { if (sorts) w.sorts = sorts as DatabaseView["sorts"]; else delete w.sorts; }
      if (set.group) { if (group) w.groupBy = group as DatabaseView["groupBy"]; else delete w.groupBy; }
      if (a.type) w.type = a.type;
      if (a.name) w.name = a.name;
    });
  }

  createView(a: ViewArgs & { database_id: string; type: string }): string {
    const db = this.db(a.database_id);
    if (!(ENUMS.ViewType as readonly string[]).includes(a.type)) throw new ToolError("Unknown layout");
    const vid = addView(this.store, db.blockID, a.type, a.name);
    if (!vid) throw new ToolError("Could not add view");
    this.applyViewArgs(vid, this.db(db.id), a);
    return `Created view ${vid}.`;
  }

  updateViewTool(a: ViewArgs & { view_id: string }): string {
    const v = this.store.views.get(a.view_id);
    const db = v ? this.store.databases.get(v.databaseID) : undefined;
    if (!v || !db) throw new ToolError(`No view ${a.view_id}`);
    this.applyViewArgs(v.id, db, a);
    return `Updated view ${v.id}.`;
  }

  deleteViewTool(viewID: string): string {
    if (!this.store.views.has(viewID)) throw new ToolError(`No view ${viewID}`);
    deleteView(this.store, viewID);
    return `Deleted view ${viewID}.`;
  }
}

export interface ViewArgs {
  type?: string | undefined;
  name?: string | undefined;
  filters?: { property: string; op?: string | undefined; value?: unknown }[] | undefined;
  filter_mode?: string | undefined;
  sorts?: { property: string; direction?: string | undefined }[] | undefined;
  group_by?: string | undefined;
}
