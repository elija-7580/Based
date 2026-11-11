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
import { CURRENT_SCHEMA_VERSION, enablePropertyRecords, hasPropertyRecords, migrate, PersistenceError, setMeta } from "./migrations.js";
import { asInt, asText, first, utf8, type SqlDatabase } from "./sql.js";

export interface ChangeEntry {
  seq: number;
  key: RecordKeyString;
  deleted: boolean;
  /** Auf diesem Gerät entstanden (wird gepusht) oder per Sync angekommen (nie zurückgepusht). */
  local: boolean;
  /**
   * BSD-220: lokal aus einem /collab-Y.Doc abgeleitet (Spalte `local = 2`): nicht pushen, bei einem Voll-Pull nicht
   * löschen. Swift liest `local != 0` und pusht sie (altes Verhalten, LWW) – die Datei bleibt austauschbar.
   */
  derived: boolean;
  deletedStamp: Stamp | undefined;
}

/** Wert der Spalte `changes.local`: 0 angekommen, 1 lokal (pushen), 2 abgeleitet (BSD-220, nicht pushen). */
export const LOCAL_DERIVED = 2;

export interface UndecodableRow {
  key: RecordKeyString;
  error: string;
}

const KINDS = new Set<RecordKind>(["workspace", "block", "database", "view", "property"]);

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

  write(upserts: WireRecord[], deletions: RecordKeyString[], tombstones: Map<RecordKeyString, Stamp>, local: boolean, derived = false): void {
    const flag = derived ? LOCAL_DERIVED : local ? 1 : 0;
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
            flag,
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
          local: asInt(r.local) !== 0 && asInt(r.local) !== LOCAL_DERIVED,
          derived: asInt(r.local) === LOCAL_DERIVED,
          deletedStamp: decodeStamp(asText(r.deleted_stamp)),
        })),
    );
  }

  /** BSD-220: abgeleitete Änderungen, die der Server noch nicht bestätigt hat (sein Record ersetzt den Eintrag). */
  derivedKeys(): RecordKeyString[] {
    return this.guard("read change log", () =>
      this.db.all("SELECT kind, id FROM changes WHERE local = ?", [LOCAL_DERIVED]).map((r) => keyOf(asText(r.kind) as RecordKind, asText(r.id) ?? "")));
  }

  /**
   * BSD-220: abgeleitete Änderungen doch pushen (Echtzeit-Text ausgeschaltet oder ohne Server): als neue lokale
   * Einträge hinter den Push-Cursor. Gibt die Anzahl zurück.
   */
  promoteDerived(): number {
    return this.guard("write", () => {
      const rows = this.db.all("SELECT kind, id, deleted, deleted_stamp FROM changes WHERE local = ? ORDER BY seq", [LOCAL_DERIVED]);
      if (rows.length === 0) return 0;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const r of rows) {
          this.db.run("DELETE FROM changes WHERE kind = ? AND id = ?", [r.kind ?? null, r.id ?? null]);
          this.db.run("INSERT INTO changes(kind, id, deleted, local, deleted_stamp) VALUES(?, ?, ?, 1, ?)", [r.kind ?? null, r.id ?? null, r.deleted ?? 0, r.deleted_stamp ?? null]);
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
      return rows.length;
    });
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

const newNode = () => crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();

export interface NodeResolution {
  node: string;
  /** Neue Kennung gewählt (Datenbank stammt von einem anderen Gerät oder aus einer Sicherung). */
  rotated: boolean;
  reason: "same" | "new" | "adopted" | "copied" | "unknownDevice";
}

/**
 * BSD-145 (Rest von BSD-72): Gerätekennung für die HLC-Stempel. Die Kennung gehört dem Gerät (außerhalb der
 * Datenbank gespeichert: localStorage, App-Einstellungen), `meta.node` merkt sich, welches Gerät die Datei zuletzt
 * geöffnet hat. Passen sie nicht zusammen, ist die Datei kopiert oder wiederhergestellt; dann schreiben zwei Geräte
 * sonst mit derselben Kennung gleiche Stempel für verschiedene Inhalte → neue Kennung. Im Zweifel neu wählen: das
 * kostet nichts, eine geteilte Kennung kostet Divergenz. Reine Funktion; das Datenformat bleibt gleich (nur meta).
 */
export function resolveNode(deviceNode: string | undefined, dbNode: string | undefined, make: () => string = newNode): NodeResolution {
  if (deviceNode && dbNode) return deviceNode === dbNode ? { node: deviceNode, rotated: false, reason: "same" } : { node: make(), rotated: true, reason: "copied" };
  if (deviceNode) return { node: deviceNode, rotated: false, reason: "adopted" }; // alte Datei ohne meta.node
  if (dbNode) return { node: make(), rotated: true, reason: "unknownDevice" }; // Datei ohne bekanntes Gerät (Kopie, Neuinstallation)
  return { node: make(), rotated: false, reason: "new" };
}

/** Wo das Gerät seine Kennung außerhalb der Datenbank aufbewahrt. */
export interface DeviceNodeStore {
  get(): string | undefined;
  set(node: string): void;
}

/** Löst die Kennung auf und trägt sie in Gerät und `meta.node` ein. */
export function deviceNodeID(p: SqlitePersistence, device: DeviceNodeStore, make?: () => string): NodeResolution {
  const r = resolveNode(device.get(), p.meta("node"), make);
  if (device.get() !== r.node) device.set(r.node);
  if (p.meta("node") !== r.node) p.setMeta("node", r.node);
  if (r.rotated) p.setMeta("node.rotated", `${r.reason} at ${new Date().toISOString()}`);
  return r;
}

/**
 * Öffnet einen Workspace auf einer SQLite-Datenbank (migriert sie, lädt alles). Die Gerätekennung kommt aus
 * `device` (BSD-145); ohne `device` aus `meta.node` der Datei (nur für Tests und Werkzeuge, die keine Geräte sind).
 */
export function openWorkspace(
  db: SqlDatabase,
  opts: Omit<StoreOptions, "persistence" | "node"> & { node?: string; device?: DeviceNodeStore; onNodeRotated?: (r: NodeResolution) => void } = {},
): { store: WorkspaceStore; persistence: SqlitePersistence } {
  const { device, onNodeRotated, node, ...rest } = opts;
  const persistence = new SqlitePersistence(db);
  // BSD-30: Eine umgestellte Datei öffnet immer mit Property-Records, egal was eingestellt ist (sonst zeigten die
  // Datenbanken keine Spalten). Eingeschaltet wird über die Option (oder die Vorgabe des Stores); zurück geht es
  // nur ausdrücklich (`revertPropertyRecords`).
  const propertyRecords = hasPropertyRecords(db) || (rest.propertyRecords ?? WorkspaceStore.propertyRecordsByDefault);
  if (propertyRecords) enablePropertyRecords(db);
  let id = node;
  if (!id && device) {
    const r = deviceNodeID(persistence, device);
    if (r.rotated) onNodeRotated?.(r);
    id = r.node;
  }
  if (!id) {
    id = persistence.meta("node") ?? newNode();
    if (!persistence.meta("node")) persistence.setMeta("node", id);
  }
  const store = new WorkspaceStore({ ...rest, persistence, node: id, propertyRecords });
  return { store, persistence };
}

/**
 * BSD-30, Rückweg: eine umgestellte Datei wieder ins alte Format bringen. Jede Datenbank bekommt ihre aktuelle
 * Property-Liste zurück in den Record (nichts geht verloren, auch keine Schema-Änderung seit der Umstellung), die
 * Property-Records und ihre Log-Einträge verschwinden, die Datei trägt wieder Version 3. Die Datenbank-Records
 * gelten als lokale Änderung und gehen beim nächsten Sync an einen Server im alten Format. Gibt die Zahl der
 * Datenbanken zurück. Nur ausführen, wenn Server und alle Geräte zurückgestellt werden.
 */
export function revertPropertyRecords(db: SqlDatabase): number {
  if (!hasPropertyRecords(db)) return 0;
  const { store } = openWorkspace(db, { node: "revert" });
  const databases = store.exportRecords().filter((r) => r.kind === "database");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const r of databases) {
      db.run("INSERT OR REPLACE INTO records(kind, id, data) VALUES(?, ?, ?)", [r.kind, r.data.id, utf8(canonicalStringify(r.data))]);
      db.run("DELETE FROM changes WHERE kind = ? AND id = ?", [r.kind, r.data.id]);
      db.run("INSERT INTO changes(kind, id, deleted, local, deleted_stamp) VALUES(?, ?, 0, 1, NULL)", [r.kind, r.data.id]);
    }
    db.run("DELETE FROM records WHERE kind = 'property'", []);
    db.run("DELETE FROM changes WHERE kind = 'property'", []);
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // nichts offen
    }
    throw new PersistenceError(`reverting property records failed: ${String(e)}`, "migration");
  }
  setMeta(db, "propertyRecords.log", `reverted to v${CURRENT_SCHEMA_VERSION} at ${new Date().toISOString()}`);
  return databases.length;
}
