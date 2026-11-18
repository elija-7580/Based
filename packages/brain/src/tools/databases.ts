// BSD-221: Datenbank-Werkzeuge (docs/mcp.md: list_databases, query_database, add_row, update_row, Schema, Ansichten)
// über den Kern-Funktionen (QueryEngine, addRow, setValue, addOption). Werte als einfacher Text, Properties per Name.
// Jede Methode kann mehrere Kern-Transaktionen auslösen; das Werkzeug drumherum fasst sie zu einer (`store.atomic`).
import {
  addDashboardWidget, addOption, addProperty, addRow, addTemplate, addView, calculationOptions, calculationText, cellText, changePropertyType, createDatabase, deleteOption, deleteProperty,
  deleteTemplate, deleteView, ENUMS, Formula, isTrashed, makeRelationTwoWay, parseCSVValue, values, plainText, QueryEngine, renameProperty, rowsOf, setDatabaseLocked, setDatabaseTitle,
  setDefaultTemplate, setRelation, setRelationTarget, setRollup, setRowTitle, setValue, templatesOf, titleOf, titleProperty, updateChart, updateOption, updateProperty, updateView, viewsForBlock,
  visiblePropertyIDs, WIDGET_TYPES, workspaceFiles, wouldCreateRollupCycle,
  type Database, type DatabaseView, type PropertySchema, type PropertyValue, type Value, type WorkspaceStore,
} from "@based/core";
import { ToolError } from "./base.js";

const TYPE_HINT: Record<string, string> = {
  select: "one option name", status: "one option name", multiSelect: "option names, comma-separated", checkbox: "Yes / No",
  date: "YYYY-MM-DD or YYYY-MM-DD HH:mm", number: "number", relation: "row ids or titles of the related database, comma-separated", formula: "computed", rollup: "computed",
  person: "names, comma-separated (me = the user)", files: "file refs (list_files) or https URLs, comma-separated", place: "address or lat,lng",
  createdTime: "automatic", createdBy: "automatic", lastEditedTime: "automatic", lastEditedBy: "automatic", uniqueID: "automatic",
};
const WRITABLE = new Set(["text", "number", "select", "status", "multiSelect", "date", "checkbox", "url", "email", "phone", "title", "relation", "person", "files", "place"]);
/** Farben für Optionen (Namen wie in der Oberfläche, aus der Liste des Kerns). */
const OPTION_COLORS: readonly string[] = (ENUMS.TColor as readonly string[]).filter((c) => !c.endsWith("Background"));
const one = <T>(kind: string, v: T): PropertyValue => ({ [kind]: { _0: v } }) as unknown as PropertyValue;
const list = (raw: string) => raw.split(",").map((x) => x.trim()).filter(Boolean);

const pad = (n: number) => String(n).padStart(2, "0");
/** Swift-Datum (Sekunden seit 2001) als „YYYY-MM-DD“ bzw. „YYYY-MM-DD HH:mm“ – so, wie die Werkzeuge es auch annehmen. */
function isoLocal(swift: number, time: boolean): string {
  const d = new Date((swift + 978_307_200) * 1000);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return time ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

/**
 * Ein Zellwert für Agenten: knapp und so, dass er sich wieder schreiben lässt (Daten als ISO, gesetzte Checkbox „yes“,
 * nicht gesetzte leer – die stehen dann gar nicht in der Zeile).
 */
export function agentCell(store: WorkspaceStore, v: Value): string {
  switch (v.t) {
    case "bool": return v.v ? "yes" : "";
    case "date": return isoLocal(v.v.start, v.v.includeTime) + (v.v.end !== undefined ? ` → ${isoLocal(v.v.end, v.v.includeTime)}` : "");
    case "list": return v.v.map((x) => agentCell(store, x)).filter((t) => t.length > 0).join(", ");
    default: return cellText(store, v).replace(/\n/g, " ");
  }
}

export class Databases {
  constructor(readonly store: WorkspaceStore) {}

  /** Datenbank per ID oder per ID ihrer Seite bzw. ihres Blocks; nicht im Papierkorb. */
  db(id: string): Database {
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

  /** Eine Ansicht der Datenbank per ID oder Name (ohne Groß/klein). */
  view(db: Database, ref: string): DatabaseView {
    const all = viewsForBlock(this.store, db.blockID);
    const linked = [...this.store.views.values()].filter((v) => v.databaseID === db.id);
    const v = this.store.views.get(ref) ?? [...all, ...linked].find((x) => x.name.toLowerCase() === ref.toLowerCase());
    if (!v || v.databaseID !== db.id) throw new ToolError(`No view “${ref}” in this database. Views: ${all.map((x) => x.name).join(", ") || "(none)"}`);
    return v;
  }

  /**
   * Zeilen mit Werten als Text. `view`: Filter, Sortierung und sichtbare Spalten einer Ansicht; `filters` (wie in
   * update_view) kommen dazu; `search` sucht in allen Zellen; `sort` nach einer Property; `properties` wählt Spalten.
   * Hat die Ansicht Berechnungen (Tabellenfuß), steht ihr Ergebnis in `footer`.
   */
  query(id: string, opts: { search?: string | undefined; sort?: string | undefined; descending?: boolean | undefined; view?: string | undefined; filters?: ViewArgs["filters"]; filter_mode?: string | undefined; properties?: string[] | undefined } = {}): string[] {
    return this.queryWithFooter(id, opts).lines;
  }

  queryWithFooter(id: string, opts: Parameters<Databases["query"]>[1] = {}): { lines: string[]; footer?: string } {
    const db = this.db(id);
    const engine = new QueryEngine(this.store);
    const base = opts.view !== undefined ? this.view(db, opts.view) : undefined;
    const q: DatabaseView = { ...(base ? structuredClone(base) : { id: "query", databaseID: db.id, blockID: db.blockID, name: "query", type: "table", sortKey: "a", createdAt: 0, updatedAt: 0 }) } as DatabaseView;
    q.id = "query:" + (base?.id ?? db.id);
    delete (q as { groupBy?: unknown }).groupBy;
    if (opts.filters?.length) {
      const extra = { combinator: opts.filter_mode === "or" ? "or" : "and", items: this.filterItems(db, opts.filters) };
      const own = q.filter as { items?: unknown[] } | undefined;
      q.filter = (own?.items?.length ? { combinator: "and", items: [{ group: { _0: own } }, { group: { _0: extra } }] } : extra) as unknown as DatabaseView["filter"];
    }
    if (opts.sort) q.sorts = [{ propertyID: this.prop(db, opts.sort).id, ascending: !opts.descending }];
    const rows = engine.run(q, opts.search).rows.filter((r) => r.trashedAt === undefined);
    const chosen = opts.properties?.length ? opts.properties.map((n) => this.prop(db, n)) : base ? visiblePropertyIDs(base, db).map((pid) => db.properties.find((p) => p.id === pid)).filter((p): p is PropertySchema => p !== undefined) : db.properties;
    const title = titleProperty(db);
    const lines = rows.map((r) => {
      const rest = chosen.filter((p) => p.id !== title.id && p.type !== "title" && p.type !== "button").map((p) => [p, agentCell(this.store, engine.value(r, p, db))] as const).filter(([, t]) => t !== "").map(([p, t]) => `${p.name}: ${t}`).join("; ");
      return `- ${plainText(r.text) || "Untitled"} (id: ${r.id})${rest ? ` — ${rest}` : ""}`;
    });
    const calc = Object.entries(base?.calculations ?? {}).map(([pid, fn]) => {
      const p = db.properties.find((x) => x.id === pid);
      const t = p ? calculationText(engine, fn, p, rows, db) : undefined;
      return p && t !== undefined ? `${p.name} ${fn}: ${t}` : undefined;
    }).filter((x): x is string => x !== undefined);
    return calc.length ? { lines, footer: `Calculations: ${calc.join("; ")}` } : { lines };
  }

  /** Schema als Markdown (für das Modell: was es schreiben darf und wie). */
  schema(id: string): string {
    const db = this.db(id);
    const lines = [`# ${plainText(db.title) || "Untitled"} (id: ${db.id})`, "", "| Property | Type | Values |", "|---|---|---|"];
    for (const p of db.properties) {
      let vals = p.options?.length ? p.options.map((o) => o.name).join(", ") : TYPE_HINT[p.type] ?? "text";
      const target = p.relation ? this.store.databases.get(p.relation.databaseID) : undefined;
      if (p.type === "relation" && target) vals = `rows of “${plainText(target.title) || "Untitled"}” (id: ${target.id}), ids or titles${p.relation?.limitOne ? ", one only" : ""}`;
      if (p.type === "formula" && p.formula) vals = `= ${p.formula}`;
      if (p.type === "rollup" && p.rollup) {
        const rel = db.properties.find((x) => x.id === p.rollup!.relationPropertyID);
        const tdb = rel?.relation ? this.store.databases.get(rel.relation.databaseID) : undefined;
        vals = `${p.rollup.function} of ${rel?.name ?? "?"} → ${tdb?.properties.find((x) => x.id === p.rollup!.targetPropertyID)?.name ?? "?"}`;
      }
      if (p.type === "number" && p.numberFormat && p.numberFormat !== "number") vals += ` (${p.numberFormat})`;
      if (p.description) vals += ` — ${p.description}`;
      lines.push(`| ${p.name} | ${p.type} | ${vals.replace(/\|/g, "\\|")} |`);
    }
    const tpl = templatesOf(this.store, db.id);
    if (tpl.length) lines.push("", `Templates: ${tpl.map((t) => `${plainText(t.text) || "Untitled"} (id: ${t.id})${t.id === db.defaultTemplateID ? " [default]" : ""}`).join(", ")}`);
    if (db.locked) lines.push("", "Locked in the app.");
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
    const special = this.special(db, p, raw);
    if (special !== undefined) return special;
    const v = parseCSVValue(raw, p);
    if (v === undefined) throw new ToolError(`“${raw}” isn't a valid ${p.type} for “${p.name}” (${TYPE_HINT[p.type] ?? "text"}).`);
    return v;
  }

  /** Relation, Person, Dateien, Ort aus Text (alles andere liest `parseCSVValue`). Schreibt nichts. */
  private special(db: Database, p: PropertySchema, raw: string): PropertyValue | undefined {
    switch (p.type) {
      case "relation": {
        const target = p.relation ? this.store.databases.get(p.relation.databaseID) : undefined;
        if (!target) throw new ToolError(`“${p.name}” has no related database yet (update_database with relations).`);
        const rows = rowsOf(this.store, target.id).filter((r) => r.trashedAt === undefined && r.props?.isTemplate !== true);
        const ids = list(raw).map((ref) => {
          const byID = rows.find((r) => r.id === ref);
          if (byID) return byID.id;
          const hits = rows.filter((r) => plainText(r.text).toLowerCase() === ref.toLowerCase());
          if (hits.length === 1) return hits[0]!.id;
          throw new ToolError(hits.length > 1 ? `“${ref}” matches ${hits.length} rows in “${plainText(target.title)}”; use the row id.` : `No row “${ref}” in “${plainText(target.title) || "the related database"}” (query_database shows the rows).`);
        });
        if (p.relation?.limitOne && ids.length > 1) throw new ToolError(`“${p.name}” takes only one row.`);
        return one("relation", ids);
      }
      case "person": return one("person", list(raw).map((n) => (n.toLowerCase() === "me" ? this.store.userID ?? "me" : n)));
      case "files": {
        let known: ReturnType<typeof workspaceFiles> | undefined;
        return one("files", list(raw).map((ref) => {
          if (ref.startsWith("based-asset:")) {
            const f = (known ??= workspaceFiles(this.store)).get(ref);
            const id = ref.slice("based-asset:".length);
            if (!/^[0-9a-f]{64}$/.test(id)) throw new ToolError(`“${ref}” is not a file ref (list_files shows them).`);
            const name = f?.name || "file";
            return { name, asset: { id, name, ...(f?.mime ? { mime: f.mime } : {}), ...(f?.size ? { size: Math.round(f.size) } : {}) } };
          }
          if (!/^https?:\/\//i.test(ref)) throw new ToolError(`“${ref}” is neither a file ref nor an http(s) URL.`);
          let name = ref;
          try { name = decodeURIComponent(new URL(ref).pathname.split("/").filter(Boolean).pop() ?? "") || new URL(ref).hostname; } catch { /* bleibt die Adresse */ }
          return { name, url: ref };
        }));
      }
      case "place": return one("place", raw.trim());
      default: return undefined;
    }
  }

  /** Neue Zeile; Werte per Property-Name als Text. Gibt die Zeilen-ID zurück. */
  addRow(id: string, values: Record<string, string>, givenTitle?: string, template?: string): string {
    const db = this.db(id);
    this.precheck(db, values);
    const title = givenTitle ?? Object.entries(values).find(([k]) => this.prop(db, k).type === "title")?.[1] ?? "";
    const tpl = template !== undefined ? this.template(db, template) : undefined;
    const rowID = addRow(this.store, db.id, { ...(title ? { title } : {}), ...(tpl ? { template: tpl } : {}) });
    if (!rowID) throw new ToolError("Couldn't add a row.");
    this.set(db, rowID, values);
    return rowID;
  }

  /** Vorlage per Titel oder ID. */
  private template(db: Database, ref: string): string {
    const all = templatesOf(this.store, db.id);
    const t = all.find((x) => x.id === ref) ?? all.find((x) => plainText(x.text).toLowerCase() === ref.toLowerCase());
    if (!t) throw new ToolError(`No template “${ref}”. Templates: ${all.map((x) => plainText(x.text) || "Untitled").join(", ") || "(none)"}`);
    return t.id;
  }

  /** Viele Zeilen in einem Schritt: erst alle prüfen, dann schreiben. Gibt die neuen IDs zurück. */
  addRows(id: string, rows: { title?: string | undefined; values?: Record<string, string> | undefined; template?: string | undefined }[]): string[] {
    const db = this.db(id);
    for (const r of rows) { this.precheck(db, r.values ?? {}); if (r.template !== undefined) this.template(db, r.template); }
    return rows.map((r) => this.addRow(db.id, r.values ?? {}, r.title, r.template));
  }

  updateRows(rows: { id: string; title?: string | undefined; values?: Record<string, string> | undefined }[]): number {
    for (const r of rows) {
      const row = this.store.blocks.get(r.id);
      if (!row || !row.parent.startsWith("d:") || isTrashed(this.store, r.id)) throw new ToolError(`No database row with id ${r.id}.`);
      this.precheck(this.db(row.parent.slice(2)), r.values ?? {});
    }
    for (const r of rows) this.updateRow(r.id, r.values ?? {}, r.title);
    return rows.length;
  }

  updateRow(rowID: string, values: Record<string, string>, title?: string): void {
    const row = this.store.blocks.get(rowID);
    if (!row || !row.parent.startsWith("d:") || isTrashed(this.store, rowID)) throw new ToolError(`No database row with id ${rowID}.`);
    const db = this.db(row.parent.slice(2));
    this.precheck(db, values);
    if (title !== undefined) setRowTitle(this.store, rowID, title);
    this.set(db, rowID, values);
  }

  /** Alles prüfen, bevor etwas geschrieben wird (keine halb angelegten Zeilen). */
  private precheck(db: Database, values: Record<string, string>) {
    for (const [name, raw] of Object.entries(values)) {
      const p = this.prop(db, name);
      if (p.type === "title") continue;
      if (!WRITABLE.has(p.type)) throw new ToolError(`“${p.name}” (${p.type}) can't be set here.`);
      if (raw.trim() === "" || p.type === "select" || p.type === "multiSelect") continue;
      if (this.special(db, p, raw) !== undefined) continue;
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
      const v = this.value(db, p, raw);
      // Relationen über den Kern, damit die Gegenseite (two-way) und „Limit to 1 page“ stimmen.
      if (p.type === "relation") setRelation(this.store, rowID, p.id, ((v as { relation?: { _0?: string[] } } | null)?.relation?._0) ?? []);
      else setValue(this.store, rowID, p.id, v);
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

  updateDatabase(a: DatabaseChanges): string {
    const id = this.db(a.database_id).id;
    const cur = () => this.db(id);
    const log: string[] = [];
    const E = Object.entries as <T>(o: Record<string, T> | undefined) => [string, T][];
    const entries = <T>(o: Record<string, T> | undefined) => E(o ?? {});
    /** Property, die es schon gibt oder die dieser Aufruf anlegt (dann mit ihrem neuen Typ). */
    const planned = (name: string, type: string): PropertySchema | undefined => {
      const p = cur().properties.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (p) return p;
      const willAdd = Object.entries(a.add_properties ?? {}).find(([n]) => n.toLowerCase() === name.toLowerCase());
      if (willAdd && Databases.propertyType(willAdd[1]) !== type) throw new ToolError(`“${name}” is added as ${willAdd[1]}, not ${type}.`);
      return undefined;
    };
    // Erst alles prüfen, dann schreiben (kein halber Umbau bei einem Tippfehler).
    for (const [name, t] of entries(a.add_properties)) if (!Databases.propertyType(t)) throw new ToolError(`Unknown type for ${name}`);
    for (const [name, t] of entries(a.change_types)) { this.prop(cur(), name); if (!Databases.propertyType(t)) throw new ToolError(`Unknown type for ${name}`); }
    for (const [old] of entries(a.rename_properties)) this.prop(cur(), old);
    for (const name of a.delete_properties ?? []) if (this.prop(cur(), name).type === "title") throw new ToolError("The title property cannot be deleted");
    for (const [name] of entries(a.add_options)) this.prop(cur(), name);
    for (const [name, src] of entries(a.formulas)) {
      const p = planned(name, "formula");
      if (p && p.type !== "formula") throw new ToolError(`“${name}” is a ${p.type} property; a formula needs its own property (or change_types to formula).`);
      try { new Formula(src); } catch (e) { throw new ToolError(`Formula for “${name}”: ${e instanceof Error ? e.message : String(e)}`); }
    }
    for (const [name, target] of entries(a.relations)) {
      const p = planned(name, "relation");
      if (p && p.type !== "relation") throw new ToolError(`“${name}” is a ${p.type} property, not a relation.`);
      this.db(target);
    }
    for (const [name] of entries(a.two_way)) { const p = planned(name, "relation"); if (p && p.type !== "relation") throw new ToolError(`“${name}” is not a relation.`); }
    for (const [name, cfg] of entries(a.rollups)) {
      const p = planned(name, "rollup");
      if (p && p.type !== "rollup") throw new ToolError(`“${name}” is a ${p.type} property, not a rollup.`);
      if (!cfg || typeof cfg.relation !== "string" || typeof cfg.property !== "string") throw new ToolError(`Rollup “${name}” needs {relation, property, function}.`);
      if (cfg.function !== undefined && !(ENUMS.CalculationType as readonly string[]).includes(cfg.function)) throw new ToolError(`Rollup function must be one of: ${(ENUMS.CalculationType as readonly string[]).join(", ")}`);
    }
    for (const [name, f] of entries(a.number_formats)) {
      this.prop(cur(), name);
      if (!(ENUMS.NumberFormat as readonly string[]).includes(f)) throw new ToolError(`Number format must be one of: ${(ENUMS.NumberFormat as readonly string[]).join(", ")}`);
    }
    for (const [name] of [...entries(a.id_prefixes), ...entries(a.descriptions)]) this.prop(cur(), name);
    for (const [name, opts] of entries(a.update_options)) {
      const p = this.prop(cur(), name);
      for (const [oname, ch] of Object.entries(opts ?? {})) {
        if (!p.options?.some((o) => o.name === oname)) throw new ToolError(`No option “${oname}” in ${p.name}. Options: ${(p.options ?? []).map((o) => o.name).join(", ")}`);
        if (ch.color !== undefined && !OPTION_COLORS.includes(ch.color)) throw new ToolError(`Option colour must be one of: ${OPTION_COLORS.join(", ")}`);
      }
    }
    for (const [name, order] of entries(a.option_order)) {
      const p = this.prop(cur(), name);
      const coming = Object.entries(a.add_options ?? {}).filter(([n]) => n.toLowerCase() === p.name.toLowerCase()).flatMap(([, v]) => v);
      const renamed = Object.values(Object.entries(a.update_options ?? {}).find(([n]) => n.toLowerCase() === p.name.toLowerCase())?.[1] ?? {}).flatMap((c) => (c.name ? [c.name] : []));
      for (const o of order) if (!p.options?.some((x) => x.name === o) && !coming.includes(o) && !renamed.includes(o)) throw new ToolError(`No option “${o}” in ${p.name}.`);
    }
    for (const t of a.delete_templates ?? []) this.template(cur(), t);

    if (a.title !== undefined) { setDatabaseTitle(this.store, id, a.title); log.push("renamed"); }
    for (const [name, t] of entries(a.add_properties)) { addProperty(this.store, id, name, Databases.propertyType(t)!); log.push(`added ${name}`); }
    for (const [old, name] of entries(a.rename_properties)) { renameProperty(this.store, id, this.prop(cur(), old).id, name); log.push(`renamed ${old}`); }
    for (const [name, t] of entries(a.change_types)) { changePropertyType(this.store, id, this.prop(cur(), name).id, Databases.propertyType(t)!); log.push(`retyped ${name}`); }
    for (const name of a.delete_properties ?? []) { deleteProperty(this.store, id, this.prop(cur(), name).id); log.push(`deleted ${name}`); }
    for (const [name, opts] of entries(a.add_options)) {
      const p = this.prop(cur(), name);
      for (const o of opts) addOption(this.store, id, p.id, o);
      log.push(`options for ${name}`);
    }
    /** Property holen oder mit dem Typ anlegen. */
    const ensure = (name: string, type: string): PropertySchema => {
      const have = cur().properties.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (have) return have;
      addProperty(this.store, id, name, type);
      return this.prop(cur(), name);
    };
    for (const [name, src] of entries(a.formulas)) {
      const p = ensure(name, "formula");
      updateProperty(this.store, id, p.id, (x) => { x.formula = src; }, "Edit formula");
      log.push(`formula ${name}`);
    }
    for (const [name, target] of entries(a.relations)) {
      const p = ensure(name, "relation");
      setRelationTarget(this.store, id, p.id, this.db(target).id);
      log.push(`relation ${name}`);
    }
    for (const [name, mirror] of entries(a.two_way)) {
      const p = this.prop(cur(), name);
      if (!p.relation) throw new ToolError(`“${name}” has no related database yet; set relations first.`);
      if (p.relation.syncedPropertyID === undefined && !makeRelationTwoWay(this.store, id, p.id, mirror || undefined)) throw new ToolError(`Couldn't make “${name}” two-way.`);
      log.push(`two-way ${name}`);
    }
    for (const [name, cfg] of entries(a.rollups)) {
      const rel = this.prop(cur(), cfg.relation);
      const target = rel.type === "relation" && rel.relation ? this.store.databases.get(rel.relation.databaseID) : undefined;
      if (!target) throw new ToolError(`Rollup “${name}”: “${cfg.relation}” is not a relation with a related database.`);
      const tp = target.properties.find((x) => x.name.toLowerCase() === cfg.property.toLowerCase());
      if (!tp) throw new ToolError(`Rollup “${name}”: no property “${cfg.property}” in “${plainText(target.title)}”. Properties: ${target.properties.map((x) => x.name).join(", ")}`);
      const p = ensure(name, "rollup");
      if (wouldCreateRollupCycle(this.store, id, p.id, rel.id, tp.id)) throw new ToolError(`Rollup “${name}” would depend on itself.`);
      setRollup(this.store, id, p.id, { relationPropertyID: rel.id, targetPropertyID: tp.id, function: cfg.function ?? "showOriginal" });
      log.push(`rollup ${name}`);
    }
    for (const [name, f] of entries(a.number_formats)) { updateProperty(this.store, id, this.prop(cur(), name).id, (x) => { x.numberFormat = f; }); log.push(`format ${name}`); }
    for (const [name, pre] of entries(a.id_prefixes)) { updateProperty(this.store, id, this.prop(cur(), name).id, (x) => { if (pre) x.idPrefix = pre; else delete x.idPrefix; }); log.push(`prefix ${name}`); }
    for (const [name, d] of entries(a.descriptions)) { updateProperty(this.store, id, this.prop(cur(), name).id, (x) => { if (d) x.description = d; else delete x.description; }); log.push(`description ${name}`); }
    for (const [name, opts] of entries(a.update_options)) {
      for (const [oname, ch] of Object.entries(opts)) {
        const p = this.prop(cur(), name);
        const o = p.options!.find((x) => x.name === oname)!;
        if (ch.delete) deleteOption(this.store, id, p.id, o.id);
        else updateOption(this.store, id, p.id, o.id, (x) => { if (ch.name) x.name = ch.name; if (ch.color) x.color = ch.color as typeof x.color; });
      }
      log.push(`options of ${name}`);
    }
    for (const [name, order] of entries(a.option_order)) {
      updateProperty(this.store, id, this.prop(cur(), name).id, (x) => {
        const opts = x.options ?? [];
        x.options = [...order.flatMap((n) => opts.find((o) => o.name === n) ?? []), ...opts.filter((o) => !order.includes(o.name))];
      });
      log.push(`order of ${name}`);
    }
    if (a.locked !== undefined) { setDatabaseLocked(this.store, id, a.locked); log.push(a.locked ? "locked" : "unlocked"); }
    const made: string[] = [];
    for (const title of a.add_templates ?? []) { const t = addTemplate(this.store, id, title); if (t) made.push(`${title} (id: ${t})`); }
    if (made.length) log.push(`templates: ${made.join(", ")}`);
    for (const t of a.delete_templates ?? []) { deleteTemplate(this.store, id, this.template(cur(), t)); log.push(`deleted template ${t}`); }
    if (a.default_template !== undefined) { setDefaultTemplate(this.store, id, a.default_template === "" ? undefined : this.template(cur(), a.default_template)); log.push("default template"); }
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
    const views = [...this.store.views.values()].filter((v) => v.blockID === db.blockID && v.widgetOf === undefined).sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    return views.map((v) => {
      let line = `- ${v.name} [view_id: ${v.id}] ${v.type}`;
      const f = v.filter as { combinator?: string; items?: unknown[] } | undefined;
      if (f?.items?.length) line += `; filter(${f.combinator ?? "and"}): ` + f.items.map((x) => this.describe(x, db)).join(", ");
      if (v.sorts?.length) line += "; sort: " + v.sorts.map((s) => `${db.properties.find((p) => p.id === s.propertyID)?.name ?? "?"} ${s.ascending === false ? "desc" : "asc"}`).join(", ");
      if (v.groupBy) line += `; group by ${db.properties.find((p) => p.id === v.groupBy!.propertyID)?.name ?? "?"}`;
      const name = (pid: string | undefined) => db.properties.find((p) => p.id === pid)?.name ?? "?";
      if (v.properties?.some((p) => p.visible)) line += `; shows: ${visiblePropertyIDs(v, db).map(name).join(", ")}`;
      if (v.calculations && Object.keys(v.calculations).length) line += `; calculations: ${Object.entries(v.calculations).map(([pid, fn]) => `${name(pid)} ${fn}`).join(", ")}`;
      if (v.type === "chart" && v.chart) line += `; chart: ${v.chart.kind}${v.chart.xPropertyID ? ` x=${name(v.chart.xPropertyID)}` : ""}${v.chart.yPropertyID ? ` y=${name(v.chart.yPropertyID)}` : ""} ${v.chart.aggregate}`;
      if (v.datePropertyID) line += `; date: ${name(v.datePropertyID)}`;
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

  /** `[{property, op, value}]` → Filterbedingungen des Kerns. */
  filterItems(db: Database, filters: NonNullable<ViewArgs["filters"]>): unknown[] {
    return filters.map((f) => {
      const p = this.prop(db, f.property);
      const op = f.op ?? "equals";
      if (!(ENUMS.FilterOp as readonly string[]).includes(op)) throw new ToolError(`Unknown filter op '${op}'. Ops: ${(ENUMS.FilterOp as readonly string[]).join(", ")}`);
      const value = this.filterValue(f.value, p);
      return { condition: { _0: { id: globalThis.crypto.randomUUID(), propertyID: p.id, op, ...(value ? { value } : {}) } } };
    });
  }

  private applyViewArgs(viewID: string, db: Database, a: ViewArgs) {
    let filter: unknown, sorts: unknown, group: unknown;
    const set = { filter: false, sorts: false, group: false };
    if (a.filters) {
      const items = this.filterItems(db, a.filters);
      filter = items.length ? { combinator: a.filter_mode === "or" ? "or" : "and", items } : undefined;
      set.filter = true;
    }
    if (a.sorts) {
      const s = a.sorts.map((x) => ({ propertyID: this.prop(db, x.property).id, ascending: !(x.direction ?? "").toLowerCase().startsWith("desc") }));
      sorts = s.length ? s : undefined;
      set.sorts = true;
    }
    if (a.group_by !== undefined) { group = a.group_by === "" ? undefined : { propertyID: this.prop(db, a.group_by).id }; set.group = true; }
    if (a.type !== undefined && !(ENUMS.ViewType as readonly string[]).includes(a.type)) throw new ToolError(`Unknown layout. Layouts: ${(ENUMS.ViewType as readonly string[]).join(", ")}`);
    // Anzeige – alles prüfen, bevor geschrieben wird
    const oneOf = (v: string | undefined, allowed: readonly string[], what: string) => { if (v !== undefined && !allowed.includes(v)) throw new ToolError(`${what} must be one of: ${allowed.join(", ")}`); };
    oneOf(a.open_in, ENUMS.OpenMode as readonly string[], "open_in");
    oneOf(a.card_size, ENUMS.CardSize as readonly string[], "card_size");
    oneOf(a.date_grouping, ENUMS.DateGrouping as readonly string[], "date_grouping");
    const visible = a.properties?.map((n) => this.prop(db, n).id);
    const propID = (n: string | undefined) => (n === undefined ? undefined : n === "" ? "" : this.prop(db, n).id);
    const dateProp = propID(a.date_property), endProp = propID(a.end_date_property), mapProp = propID(a.map_property);
    let cover: unknown;
    if (a.card_preview !== undefined) cover = ["none", "pageCover", "pageContent", "pageIcon"].includes(a.card_preview) ? { [a.card_preview]: {} } : { property: { _0: this.prop(db, a.card_preview).id } };
    const calcs = Object.entries(a.calculations ?? {}).map(([n, fn]) => {
      const p = this.prop(db, n);
      const allowed = ["none", ...calculationOptions(p.type)];
      if (!allowed.includes(fn)) throw new ToolError(`Calculation for “${p.name}” must be one of: ${allowed.join(", ")}`);
      return [p.id, fn] as const;
    });
    const chart = a.chart;
    if (chart) {
      oneOf(chart.kind, ENUMS.ChartKind as readonly string[], "chart.kind");
      oneOf(chart.aggregate, ENUMS.ChartAggregate as readonly string[], "chart.aggregate");
      oneOf(chart.date_bucket, ENUMS.ChartDateBucket as readonly string[], "chart.date_bucket");
    }
    const chartX = propID(chart?.x), chartY = propID(chart?.y);
    for (const w of a.add_widgets ?? []) if (!WIDGET_TYPES.includes(w)) throw new ToolError(`Widget must be one of: ${WIDGET_TYPES.join(", ")}`);

    updateView(this.store, viewID, (v) => {
      const w = v as DatabaseView & Record<string, unknown>;
      if (set.filter) { if (filter) w.filter = filter as DatabaseView["filter"]; else delete w.filter; }
      if (set.sorts) { if (sorts) w.sorts = sorts as DatabaseView["sorts"]; else delete w.sorts; }
      if (set.group) { if (group) w.groupBy = group as DatabaseView["groupBy"]; else delete w.groupBy; }
      if (a.type) w.type = a.type;
      if (a.name) w.name = a.name;
      if (visible) w.properties = [...visible.map((id) => ({ id, visible: true, ...(v.properties?.find((x) => x.id === id)?.width !== undefined ? { width: v.properties!.find((x) => x.id === id)!.width } : {}) })), ...db.properties.filter((p) => !visible.includes(p.id)).map((p) => ({ id: p.id, visible: false }))] as DatabaseView["properties"];
      if (a.wrap !== undefined) { if (a.wrap) w.wrapCells = true; else delete w.wrapCells; }
      if (a.open_in !== undefined) w.openIn = a.open_in as DatabaseView["openIn"];
      if (a.show_icons !== undefined) w.showIcons = a.show_icons;
      if (a.show_title !== undefined) w.showTitle = a.show_title;
      if (a.card_size !== undefined) w.cardSize = a.card_size as DatabaseView["cardSize"];
      if (cover !== undefined) w.cardCover = cover as DatabaseView["cardCover"];
      const setID = (key: "datePropertyID" | "endDatePropertyID" | "mapPropertyID", id: string | undefined) => { if (id === undefined) return; if (id === "") delete w[key]; else w[key] = id; };
      setID("datePropertyID", dateProp);
      setID("endDatePropertyID", endProp);
      setID("mapPropertyID", mapProp);
      if (a.limit !== undefined) { if (a.limit > 0) w.loadLimit = a.limit; else delete w.loadLimit; }
      if ((a.hide_empty_groups !== undefined || a.date_grouping !== undefined) && w.groupBy) {
        const g = { ...w.groupBy } as NonNullable<DatabaseView["groupBy"]>;
        if (a.hide_empty_groups !== undefined) { if (a.hide_empty_groups) g.hideEmptyGroups = true; else delete g.hideEmptyGroups; }
        if (a.date_grouping !== undefined) g.dateGrouping = a.date_grouping as NonNullable<typeof g.dateGrouping>;
        w.groupBy = g;
      }
      if (calcs.length) {
        const c = { ...(w.calculations ?? {}) } as Record<string, string>;
        for (const [id, fn] of calcs) { if (fn === "none") delete c[id]; else c[id] = fn; }
        if (Object.keys(c).length) w.calculations = c as DatabaseView["calculations"]; else delete w.calculations;
      }
    });
    if (chart) {
      updateChart(this.store, viewID, (c) => {
        if (chart.kind) c.kind = chart.kind as typeof c.kind;
        if (chartX !== undefined) { if (chartX) c.xPropertyID = chartX; else delete c.xPropertyID; }
        if (chartY !== undefined) { if (chartY) c.yPropertyID = chartY; else delete c.yPropertyID; }
        if (chart.aggregate) c.aggregate = chart.aggregate as typeof c.aggregate;
        if (chart.date_bucket) c.dateBucket = chart.date_bucket as typeof c.dateBucket;
        if (chart.show_legend !== undefined) c.showLegend = chart.show_legend;
        if (chart.show_values !== undefined) c.showValues = chart.show_values;
        if (chart.sort_by_value !== undefined) c.sortByValue = chart.sort_by_value;
        if (chart.limit !== undefined) { if (chart.limit > 0) c.limit = chart.limit; else delete c.limit; }
        if (chart.caption !== undefined) { if (chart.caption) c.caption = chart.caption; else delete c.caption; }
      });
    }
    for (const type of a.add_widgets ?? []) {
      if (this.store.views.get(viewID)?.type !== "dashboard") throw new ToolError("add_widgets works on a dashboard view.");
      addDashboardWidget(this.store, viewID, type, { databaseID: db.id });
    }
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
  hide_empty_groups?: boolean | undefined;
  date_grouping?: string | undefined;
  /** Sichtbare Properties in dieser Reihenfolge (alle anderen werden ausgeblendet). */
  properties?: string[] | undefined;
  wrap?: boolean | undefined;
  open_in?: string | undefined;
  show_icons?: boolean | undefined;
  show_title?: boolean | undefined;
  card_size?: string | undefined;
  /** none | pageCover | pageContent | pageIcon | Name einer Dateien-Property */
  card_preview?: string | undefined;
  date_property?: string | undefined;
  end_date_property?: string | undefined;
  map_property?: string | undefined;
  limit?: number | undefined;
  calculations?: Record<string, string> | undefined;
  chart?: { kind?: string; x?: string; y?: string; aggregate?: string; date_bucket?: string; show_legend?: boolean; show_values?: boolean; sort_by_value?: boolean; limit?: number; caption?: string } | undefined;
  add_widgets?: string[] | undefined;
}

export interface DatabaseChanges {
  database_id: string;
  title?: string | undefined;
  add_properties?: Record<string, string> | undefined;
  rename_properties?: Record<string, string> | undefined;
  change_types?: Record<string, string> | undefined;
  delete_properties?: string[] | undefined;
  add_options?: Record<string, string[]> | undefined;
  /** Property → Formel-Ausdruck (legt die Property an, wenn es sie nicht gibt). */
  formulas?: Record<string, string> | undefined;
  /** Property → ID der verknüpften Datenbank. */
  relations?: Record<string, string> | undefined;
  /** Relation → Name der Gegen-Property in der anderen Datenbank (leer: Standardname). */
  two_way?: Record<string, string> | undefined;
  rollups?: Record<string, { relation: string; property: string; function?: string }> | undefined;
  number_formats?: Record<string, string> | undefined;
  id_prefixes?: Record<string, string> | undefined;
  descriptions?: Record<string, string> | undefined;
  /** Property → Optionsname → Änderung. */
  update_options?: Record<string, Record<string, { name?: string; color?: string; delete?: boolean }>> | undefined;
  option_order?: Record<string, string[]> | undefined;
  locked?: boolean | undefined;
  add_templates?: string[] | undefined;
  delete_templates?: string[] | undefined;
  default_template?: string | undefined;
}
