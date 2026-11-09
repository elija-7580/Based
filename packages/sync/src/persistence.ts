// BSD-152 Punkt 1: lokaler Speicher unter dem WorkspaceStore. Gleiches Dateiformat wie BasedCore
// SQLitePersistence.swift: `records(kind, id, data BLOB)` mit dem JSON des Payloads, `meta(key, value BLOB)` und
// das Sync-v2-Change-Log `changes(seq, kind, id, deleted, local, deleted_stamp)` (ein Eintrag pro Record: seine
// neueste Änderung). Fehler werfen `PersistenceError`; der Store wird dann schreibgeschützt (kein RAM-Fallback).
import {
  canonicalStringify,
  keyOf,
  parseStamp,
  safeParseRecord,
  WorkspaceStore,
  type Persistence,
  type RecordKeyString,
  type RecordKind,
  type Stamp,
  type StoreOptions,
  type WireRecord,
} from "@based/core";
import { migrate, PersistenceError, setMeta } from "./migrations.js";
import { asInt, asText, first, utf8, type SqlDatabase } from "./sql.js";

export interface ChangeEntry {
  seq: number;
  key: RecordKeyString;
  deleted: boolean;
  /** Auf diesem Gerät entstanden (wird gepusht) oder per Sync angekommen (nie zurückgepusht). */
  local: boolean;
  deletedStamp: Stamp | undefined;
}

export interface UndecodableRow {
  key: RecordKeyString;
  error: string;
}

const KINDS = new Set<RecordKind>(["workspace", "block", "database", "view"]);

/** Stempel als JSON wie Swift `JSONEncoder` (Reihenfolge egal, Swift liest es zurück). */
export const encodeStamp = (s: Stamp) => JSON.stringify({ millis: s.millis, counter: s.counter, node: s.node });

export function decodeStamp(text: string | undefined): Stamp | undefined {
  if (!text) return undefined;
  try {
    const v = JSON.parse(text) as Partial<Stamp>;
    if (typeof v.millis === "number" && typeof v.counter === "number" && typeof v.node === "string") {
      return { millis: v.millis, counter: v.counter, node: v.node };
    }
  } catch {
    return parseStamp(text);
  }
  return undefined;
}

export class SqlitePersistence implements Persistence {
  /** Zeilen, die diese Version nicht lesen kann: bleiben unangetastet in der Datei und werden nie gepusht (BSD-16). */
  undecodable: UndecodableRow[] = [];

  constructor(readonly db: SqlDatabase) {
    migrate(db);
  }

  private guard<T>(what: string, body: () => T): T {
    try {
      return body();
    } catch (e) {
      if (e instanceof PersistenceError) throw e;
      throw new PersistenceError(`${what}: ${e instanceof Error ? e.message : String(e)}`, "sqlite");
    }
  }

  loadAll(): WireRecord[] {
    return this.guard("load", () => {
      const out: WireRecord[] = [];
      this.undecodable = [];
      for (const row of this.db.all("SELECT kind, id, data FROM records")) {
        const kind = asText(row.kind) as RecordKind;
        const id = asText(row.id) ?? "";
        const key = keyOf(kind, id);
        if (!KINDS.has(kind)) {
          this.undecodable.push({ key, error: `unknown record kind ${kind}` });
          continue;
        }
        try {
          const parsed = safeParseRecord({ kind, data: JSON.parse(asText(row.data) ?? "") });
          if (parsed.ok) out.push(parsed.record);
          else this.undecodable.push({ key, error: parsed.error.message });
        } catch (e) {
          this.undecodable.push({ key, error: String(e) });
        }
      }
      return out;
    });
  }

  write(upserts: WireRecord[], deletions: RecordKeyString[], tombstones: Map<RecordKeyString, Stamp>, local: boolean): void {
    this.guard("write", () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const logChange = (kind: string, id: string, deleted: boolean, stamp: Stamp | undefined) => {
          // Ein Record hat einen Log-Eintrag: seine neueste Änderung (löschen + einfügen = neue, höhere seq).
          this.db.run("DELETE FROM changes WHERE kind = ? AND id = ?", [kind, id]);
          this.db.run("INSERT INTO changes(kind, id, deleted, local, deleted_stamp) VALUES(?, ?, ?, ?, ?)", [
            kind,
            id,
            deleted ? 1 : 0,
            local ? 1 : 0,
            deleted && stamp ? encodeStamp(stamp) : null,
          ]);
        };
        for (const r of upserts) {
          this.db.run("INSERT OR REPLACE INTO records(kind, id, data) VALUES(?, ?, ?)", [r.kind, r.data.id, utf8(canonicalStringify(r.data))]);
          logChange(r.kind, r.data.id, false, undefined);
        }
        for (const key of deletions) {
          const i = key.indexOf(":");
          const kind = key.slice(0, i), id = key.slice(i + 1);
          this.db.run("DELETE FROM records WHERE kind = ? AND id = ?", [kind, id]);
          logChange(kind, id, true, tombstones.get(key));
        }
        this.db.exec("COMMIT");
      } catch (e) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // nichts offen
        }
        throw e;
      }
    });
  }

  tombstone(key: RecordKeyString): Stamp | undefined {
    const i = key.indexOf(":");
    const row = first(this.db, "SELECT deleted_stamp FROM changes WHERE kind = ? AND id = ? AND deleted = 1", [key.slice(0, i), key.slice(i + 1)]);
    return decodeStamp(asText(row?.deleted_stamp));
  }

  checkWritable(): void {
    this.guard("write probe", () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        setMeta(this.db, "write.probe", String(Math.floor(Date.now() / 1000)));
        this.db.exec("COMMIT");
      } catch (e) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // nichts offen
        }
        throw e;
      }
    });
  }

  // MARK: Change-Log (Sync v2)

  changes(after: number, limit: number): ChangeEntry[] {
    return this.guard("read change log", () =>
      this.db
        .all("SELECT seq, kind, id, deleted, local, deleted_stamp FROM changes WHERE seq > ? ORDER BY seq LIMIT ?", [after, limit])
        .map((r) => ({
          seq: asInt(r.seq),
          key: keyOf(asText(r.kind) as RecordKind, asText(r.id) ?? ""),
          deleted: asInt(r.deleted) !== 0,
          local: asInt(r.local) !== 0,
          deletedStamp: decodeStamp(asText(r.deleted_stamp)),
        })),
    );
  }

  maxSeq(): number {
    return asInt(first(this.db, "SELECT COALESCE(MAX(seq), 0) AS m FROM changes")?.m);
  }

  // MARK: Meta

  meta(key: string): string | undefined {
    return asText(first(this.db, "SELECT value FROM meta WHERE key = ?", [key])?.value);
  }

  setMeta(key: string, value: string | undefined): void {
    this.guard("write meta", () => setMeta(this.db, key, value));
  }

  /** Ganzzahliger Meta-Wert (Sync-Cursor), 0 wenn nicht gesetzt. */
  metaInt(key: string): number {
    return asInt(this.meta(key) ?? null);
  }
}

/** Gerätekennung wie Swift (`meta.node`, 8 Zeichen); bleibt über Neustarts gleich. */
export function nodeID(p: SqlitePersistence, make: () => string = () => crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()): string {
  const existing = p.meta("node");
  if (existing) return existing;
  const id = make();
  p.setMeta("node", id);
  return id;
}

/** Öffnet einen Workspace auf einer SQLite-Datenbank (migriert sie, lädt alles, Gerätekennung aus `meta`). */
export function openWorkspace(db: SqlDatabase, opts: Omit<StoreOptions, "persistence" | "node"> & { node?: string } = {}): { store: WorkspaceStore; persistence: SqlitePersistence } {
  const persistence = new SqlitePersistence(db);
  const store = new WorkspaceStore({ ...opts, persistence, node: opts.node ?? nodeID(persistence) });
  return { store, persistence };
}
