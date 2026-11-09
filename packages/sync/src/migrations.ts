// BSD-152 Punkt 2: Schema-Version und Migrationsliste, 1:1 wie BasedCore Store/SQLiteMigrations.swift (BSD-23),
// damit dieselbe based.sqlite von Swift und TS geöffnet werden kann.
//
// Regeln: anhängen, nie ändern oder umsortieren; nie Nutzerdaten löschen (in `quarantine` verschieben);
// jede Migration braucht einen Test, der eine Datei der Vorversion öffnet.
import { compareStamps, safeParseRecord, WORKSPACE_ID, type Stamp } from "@based/core";
import { asInt, asText, first, utf8, type SqlDatabase } from "./sql.js";

export class PersistenceError extends Error {
  constructor(
    message: string,
    readonly code: "newerFormat" | "sqlite" | "migration",
  ) {
    super(message);
    this.name = "PersistenceError";
  }
}

export interface Migration {
  version: number;
  name: string;
  apply(db: SqlDatabase): void;
}

export const tableExists = (db: SqlDatabase, name: string) =>
  first(db, "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?", [name]) !== undefined;

export const columnExists = (db: SqlDatabase, table: string, column: string) =>
  first(db, `SELECT 1 AS x FROM pragma_table_info('${table.replaceAll("'", "''")}') WHERE name = ?`, [column]) !== undefined;

export const schemaVersion = (db: SqlDatabase) => asInt(first(db, "PRAGMA user_version")?.user_version);

export function setMeta(db: SqlDatabase, key: string, value: string | undefined) {
  if (value === undefined) db.run("DELETE FROM meta WHERE key = ?", [key]);
  else db.run("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)", [key, utf8(value)]);
}

/** Zeile aus `records` nach `quarantine` (und ihren Change-Log-Eintrag entfernen, damit sie nicht synct). */
export function quarantineRow(db: SqlDatabase, kind: string, id: string, data: Uint8Array, reason: string) {
  db.run("INSERT INTO quarantine(kind, id, data, reason, at) VALUES(?, ?, ?, ?, ?)", [kind, id, data, reason, Date.now() / 1000]);
  db.run("DELETE FROM records WHERE kind = ? AND id = ?", [kind, id]);
  db.run("DELETE FROM changes WHERE kind = ? AND id = ?", [kind, id]);
}

/** Mehrere `workspace`-Zeilen: die mit dem neuesten Stempel behalten (lesbare zuerst, dann die Haupt-ID). */
export function dedupeWorkspaceRows(db: SqlDatabase) {
  const rows = db.all("SELECT id, data FROM records WHERE kind = 'workspace'").map((r) => {
    const raw = r.data instanceof Uint8Array ? r.data : utf8(asText(r.data) ?? "");
    let stamp: Stamp | undefined;
    try {
      const parsed = safeParseRecord({ kind: "workspace", data: JSON.parse(asText(raw) ?? "") });
      if (parsed.ok) stamp = parsed.record.data.stamp as Stamp;
    } catch {
      // unlesbar: kein Stempel
    }
    return { id: asText(r.id) ?? "", data: raw, stamp };
  });
  if (rows.length < 2) return;
  const better = (a: (typeof rows)[number], b: (typeof rows)[number]) => {
    if ((a.stamp !== undefined) !== (b.stamp !== undefined)) return a.stamp !== undefined;
    if (a.stamp && b.stamp) {
      const c = compareStamps(a.stamp, b.stamp);
      if (c !== 0) return c > 0;
    }
    if ((a.id === WORKSPACE_ID) !== (b.id === WORKSPACE_ID)) return a.id === WORKSPACE_ID;
    return a.id > b.id;
  };
  const keep = rows.reduce((best, r) => (better(r, best) ? r : best));
  for (const r of rows) if (r.id !== keep.id) quarantineRow(db, "workspace", r.id, r.data, `duplicate workspace record (kept ${keep.id})`);
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "records, meta and the sync v2 change log",
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(kind, id));
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB);
      `);
      if (tableExists(db, "changes")) return;
      db.exec(`
        CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL,
                              deleted INTEGER NOT NULL DEFAULT 0, local INTEGER NOT NULL DEFAULT 1);
        CREATE UNIQUE INDEX changes_key ON changes(kind, id);
        INSERT INTO changes(kind, id, deleted, local) SELECT kind, id, 0, 1 FROM records ORDER BY kind, id;
      `);
    },
  },
  {
    version: 2,
    name: "quarantine table, one workspace record",
    apply(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS quarantine (kind TEXT NOT NULL, id TEXT NOT NULL, data BLOB NOT NULL,
                                                      reason TEXT NOT NULL, at REAL NOT NULL);`);
      dedupeWorkspaceRows(db);
    },
  },
  {
    version: 3,
    name: "stamped tombstones in the change log",
    apply(db) {
      if (!columnExists(db, "changes", "deleted_stamp")) db.exec("ALTER TABLE changes ADD COLUMN deleted_stamp TEXT");
    },
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** Bringt die Datei auf `CURRENT_SCHEMA_VERSION`. Eine neuere Datei wird nicht angefasst (`newerFormat`). */
export function migrate(db: SqlDatabase, migrations: readonly Migration[] = MIGRATIONS): void {
  const from = schemaVersion(db);
  const target = migrations[migrations.length - 1]?.version ?? 0;
  if (from > target) {
    throw new PersistenceError(`based.sqlite has format v${from}, this version of Based knows up to v${target}`, "newerFormat");
  }
  if (from >= target) return;
  // Bestehenden Inhalt sichern (eine Datei von vor der Liste hat user_version 0, aber schon Tabellen).
  const backupName = tableExists(db, "records") ? db.backup?.(from) : undefined;
  for (const m of migrations) {
    if (m.version <= from) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      m.apply(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // schon zurückgerollt
      }
      throw new PersistenceError(`migration ${m.version} (${m.name}) failed: ${String(e)}`, "migration");
    }
  }
  if (backupName) setMeta(db, "migration.backup", backupName);
  setMeta(db, "migration.log", `v${from} → v${target} at ${new Date().toISOString()}`);
}
