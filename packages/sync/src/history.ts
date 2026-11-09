// BSD-73: Ablage des Versionsverlaufs in SQLite, gleiches Format wie BasedCore VersionHistory.swift: eine eigene
// Datei `history.sqlite` neben dem Workspace (nie gesynct) mit den Tabellen `objects(hash, data)` und `versions`.
// Bewusst keine Tabelle in based.sqlite: eine Migration v4 würde die Datei für die Swift-App (kennt bis v3) zu
// „newerFormat“ machen; so bleiben beide Dateien zwischen Swift und TS austauschbar. Fehler werfen (anders als
// Swift, das sie mit `try?` schluckte), der Aufrufer meldet sie.
import type { HistoryStats, HistoryStorage, HistoryVersion } from "@based/core";
import { asInt, asText, first, type SqlDatabase, type SqlValue } from "./sql.js";

/** Tabellen wie in Swift (`CREATE TABLE IF NOT EXISTS`, gleiche Spalten und Index). */
export const HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS objects (hash TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS versions (id INTEGER PRIMARY KEY AUTOINCREMENT, page TEXT NOT NULL, at REAL NOT NULL,
                                     manifest TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
                                     blocks INTEGER NOT NULL DEFAULT 0, words INTEGER NOT NULL DEFAULT 0,
                                     reason TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS versions_page ON versions(page, at);
`;

const blob = (v: SqlValue | undefined): Uint8Array | undefined => {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return new TextEncoder().encode(v);
  return undefined;
};

const asNumber = (v: SqlValue | undefined): number => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : Number(v ?? 0));

export class SqliteHistoryStorage implements HistoryStorage {
  private depth = 0;

  constructor(readonly db: SqlDatabase) {
    db.exec(HISTORY_SCHEMA);
  }

  getObject(hash: string) {
    return blob(first(this.db, "SELECT data FROM objects WHERE hash = ?", [hash])?.data);
  }

  putObject(hash: string, stored: Uint8Array) {
    this.db.run("INSERT OR IGNORE INTO objects(hash, data) VALUES (?, ?)", [hash, stored]);
  }

  insertVersion(v: Omit<HistoryVersion, "id">) {
    this.db.run("INSERT INTO versions(page, at, manifest, title, blocks, words, reason) VALUES (?,?,?,?,?,?,?)",
      [v.pageID, v.at, v.manifest, v.title, v.blockCount, v.wordCount, v.reason]);
    return asInt(first(this.db, "SELECT last_insert_rowid() AS id")?.id);
  }

  versions(pageID: string, limit: number): HistoryVersion[] {
    return this.db.all("SELECT id, at, manifest, title, blocks, words, reason FROM versions WHERE page = ? ORDER BY at DESC, id DESC LIMIT ?", [pageID, limit])
      .map((r) => ({
        id: asInt(r.id), pageID, at: asNumber(r.at), manifest: asText(r.manifest) ?? "", title: asText(r.title) ?? "",
        blockCount: asInt(r.blocks), wordCount: asInt(r.words), reason: asText(r.reason) ?? "",
      }));
  }

  versionRefs() {
    return this.db.all("SELECT id, page, at FROM versions ORDER BY page, at DESC, id DESC")
      .map((r) => ({ id: asInt(r.id), pageID: asText(r.page) ?? "", at: asNumber(r.at) }));
  }

  deleteVersions(ids: number[]) {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      this.db.run(`DELETE FROM versions WHERE id IN (${chunk.map(() => "?").join(",")})`, chunk);
    }
  }

  deletePageVersions(pageID: string) {
    this.db.run("DELETE FROM versions WHERE page = ?", [pageID]);
  }

  manifests() {
    return this.db.all("SELECT DISTINCT manifest FROM versions").map((r) => asText(r.manifest) ?? "");
  }

  objectHashes() {
    return this.db.all("SELECT hash FROM objects").map((r) => asText(r.hash) ?? "");
  }

  deleteObjects(hashes: string[]) {
    for (const h of hashes) this.db.run("DELETE FROM objects WHERE hash = ?", [h]);
  }

  stats(): HistoryStats {
    const n = (sql: string) => asInt(first(this.db, sql)?.n);
    return {
      versions: n("SELECT COUNT(*) AS n FROM versions"),
      objects: n("SELECT COUNT(*) AS n FROM objects"),
      bytes: n("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM objects"),
    };
  }

  transaction<T>(body: () => T): T {
    if (this.depth > 0) return body();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth += 1;
    try {
      const out = body();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // schon zurückgerollt
      }
      throw e;
    } finally {
      this.depth -= 1;
    }
  }
}
