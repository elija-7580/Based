// BSD-221: Datenbank-Werkzeuge für MCP (docs/mcp.md: list_databases, query_database, add_row, update_row) über den
// Kern-Funktionen (QueryEngine, addRow, setValue, addOption). Werte als einfacher Text, Properties per Name.
import {
  addOption, addRow, cellText, isTrashed, parseCSVValue, plainText, QueryEngine, rowsOf, setRowTitle, setValue,
  type Database, type PropertySchema, type PropertyValue, type WorkspaceStore,
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
}
