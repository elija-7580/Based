// BSD-152 Punkt 1: lokaler Speicher unter dem WorkspaceStore. Gleiches Dateiformat wie BasedCore
// SQLitePersistence.swift: `records(kind, id, data BLOB)` mit dem JSON des Payloads, `meta(key, value BLOB)` und
// das Sync-v2-Change-Log `changes(seq, kind, id, deleted, local, deleted_stamp)` (ein Eintrag pro Record: seine
// neueste Änderung). Fehler werfen `PersistenceError`; der Store wird dann schreibgeschützt (kein RAM-Fallback).
import {
  canonicalStringify,
  compareStamps,
  SKELETON_TYPES,
  StampClock,
  keyOf,
  parseStamp,
  safeParseRecord,
  safeParseRecordOfKind,
  WorkspaceStore,
  type Block,
  type LazyPersistence,
  type Persistence,
  type RecordKeyString,
  type RecordKind,
  type Stamp,
  type StoreOptions,
  type WireRecord,
} from "@based/core";
import { CURRENT_SCHEMA_VERSION, enablePropertyRecords, hasPropertyRecords, migrate, PersistenceError, setMeta } from "./migrations.js";
import { asInt, asText, first, utf8, type SqlDatabase, type SqlRow } from "./sql.js";

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

// ADR 0017 Stufe B: Indizes über Feldern im JSON, ohne die Zeilen umzuschreiben (kein neues Dateiformat: ältere
// Builds öffnen die Datei weiter, SQLite pflegt die Indizes auch für sie; der Rückweg ist DROP INDEX).
// `json_valid` zuerst: eine unlesbare Zeile (BSD-16, bleibt unangetastet) ließe `json_extract` sonst werfen – beim
// Anlegen des Index und bei jedem Schreiben. Abfragen müssen die Ausdrücke wörtlich so verwenden.
const JSON_TEXT = "CAST(data AS TEXT)";
/** Elternteil eines Blocks (`w`, `b:<id>`, `d:<id>`). */
export const PARENT_SQL = `CASE WHEN json_valid(${JSON_TEXT}) THEN json_extract(${JSON_TEXT}, '$.parent') END`;
/** 1 für Gerüst-Blöcke – dieselbe Regel wie `isSkeletonBlock` im Kern (ein Test hält beide gleich). */
export const SKELETON_SQL =
  `CASE WHEN json_valid(${JSON_TEXT}) AND (json_extract(${JSON_TEXT}, '$.type') IN (${SKELETON_TYPES.map((t) => `'${t}'`).join(", ")})` +
  ` OR json_extract(${JSON_TEXT}, '$.trashedAt') IS NOT NULL) THEN 1 END`;
const CLOCK_MAX_KEY = "clock.max";
/** Zeilen je Stück beim Durchlauf über die ganze Tabelle (`scanRecords`): begrenzt den Speicher, ein Text je Stück. */
const SCAN_BATCH = 2048;
export const LAZY_INDEXES = ["records_parent", "records_skeleton"] as const;

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
  private undecodableKeys = new Set<RecordKeyString>();

  constructor(readonly db: SqlDatabase) {
    migrate(db);
  }

  /** Eine Zeile aus `records` prüfen; unlesbare werden vermerkt (einmal je Schlüssel) und übersprungen. */
  private decode(row: SqlRow, kindOf?: RecordKind): WireRecord | undefined {
    const kind = kindOf ?? (asText(row.kind) as RecordKind);
    const id = asText(row.id) ?? "";
    const key = keyOf(kind, id);
    const fail = (error: string) => {
      if (!this.undecodableKeys.has(key)) {
        this.undecodableKeys.add(key);
        this.undecodable.push({ key, error });
      }
      return undefined;
    };
    if (!KINDS.has(kind)) return fail(`unknown record kind ${kind}`);
    try {
      const parsed = safeParseRecord({ kind, data: JSON.parse(asText(row.data) ?? "") });
      return parsed.ok ? parsed.record : fail(parsed.error.message);
    } catch (e) {
      return fail(String(e));
    }
  }

  /** Wie `decode`, für eine Zeile, deren JSON schon gelesen ist (`scanRecords`). Dieselbe Prüfung, dieselben Meldungen. */
  private decodeParsed(kind: RecordKind, id: string, data: unknown): WireRecord | undefined {
    const fail = (error: string) => {
      const key = keyOf(kind, id);
      if (!this.undecodableKeys.has(key)) {
        this.undecodableKeys.add(key);
        this.undecodable.push({ key, error });
      }
      return undefined;
    };
    if (!KINDS.has(kind)) return fail(`unknown record kind ${kind}`);
    const parsed = safeParseRecordOfKind(kind, data);
    return parsed.ok ? parsed.record : fail(parsed.error.message);
  }

  /**
   * Alle Zeilen aus `records` (optional nur eine Art), in der Reihenfolge der Datei. Ein Durchlauf über die ganze
   * Tabelle kostete im Browser vor allem den Weg je Zeile aus SQLite-WASM heraus (18.11., 113 000 Records, WebKit:
   * 0,8–1,0 s von 1,8 s; dazu je Zeile ein eigenes `TextDecoder.decode` und `JSON.parse`). Darum setzt SQLite je
   * `SCAN_BATCH` Zeilen einen JSON-Text zusammen, der in einem Stück herauskommt und einmal gelesen wird.
   *
   * Gleich bleibt, was geprüft wird: Jede Zeile läuft durch dieselbe Schema-Prüfung. Eine Zeile, deren Daten kein
   * gültiges JSON sind (`json_valid`), steht im Stück nur mit ihrer Zeilennummer und wird einzeln über `decode`
   * gelesen – mit derselben Fehlermeldung wie bisher. Lässt sich ein Stück nicht lesen (z. B. ein NUL-Zeichen in den
   * Daten), wird genau dieses Stück Zeile für Zeile gelesen. Die Datei wird nie verändert.
   */
  private scanRecords(only: RecordKind | undefined, each: (r: WireRecord) => void, skip?: (id: string) => boolean): void {
    const filter = only ? ` AND kind = '${only}'` : "";
    const range = `FROM records WHERE rowid > ?${filter} ORDER BY rowid LIMIT ${SCAN_BATCH}`;
    const batchSQL =
      `SELECT max(r) AS last, '[' || group_concat(j) || ']' AS batch FROM (SELECT rowid AS r, '{"r":' || rowid || ',"k":' || json_quote(kind)` +
      ` || ',"i":' || json_quote(id) || CASE WHEN json_valid(${JSON_TEXT}) THEN ',"d":' || ${JSON_TEXT} ELSE ',"x":1' END || '}' AS j ${range})`;
    const single = (rowid: number) => {
      const row = first(this.db, "SELECT kind, id, data FROM records WHERE rowid = ?", [rowid]);
      if (!row || skip?.(asText(row.id) ?? "")) return;
      const r = this.decode(row);
      if (r) each(r);
    };
    /** Rückweg für ein Stück: wie bisher Zeile für Zeile. */
    const plain = (after: number): number => {
      let last = after;
      for (const row of this.db.all(`SELECT rowid AS r, kind, id, data ${range}`, [after])) {
        last = asInt(row.r);
        if (skip?.(asText(row.id) ?? "")) continue;
        const r = this.decode(row);
        if (r) each(r);
      }
      return last;
    };
    for (let after = 0; ; ) {
      let rows: { r: number; k: string; i: string; d?: unknown; x?: 1 }[] | undefined;
      let last = after;
      try {
        const head = first(this.db, batchSQL, [after]);
        if (head?.last == null) return;
        last = asInt(head.last);
        rows = JSON.parse(asText(head.batch) ?? "") as typeof rows;
      } catch {
        rows = undefined;
      }
      if (!rows) {
        const end = plain(after);
        if (end === after) return;
        after = end;
        continue;
      }
      for (const row of rows) {
        if (row.x) single(row.r);
        else if (!skip?.(row.i)) {
          const r = this.decodeParsed(row.k as RecordKind, row.i, row.d);
          if (r) each(r);
        }
      }
      after = last;
    }
  }

  // MARK: Laden nach Bedarf (ADR 0017 Stufe B)

  /** Legt die beiden Indizes an, falls sie fehlen (einmalig; bei 520 000 Records rund 1,5 s nativ). */
  ensureLazyIndexes(): void {
    this.guard("lazy indexes", () => {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS records_parent ON records(${PARENT_SQL}) WHERE kind = 'block';
        CREATE INDEX IF NOT EXISTS records_skeleton ON records(kind, id) WHERE kind = 'block' AND ${SKELETON_SQL} = 1;
      `);
    });
  }

  /** Rückweg: die Indizes wieder entfernen (die Datei ist danach wie vorher). */
  dropLazyIndexes(): void {
    this.guard("lazy indexes", () => { for (const name of LAZY_INDEXES) this.db.exec(`DROP INDEX IF EXISTS ${name}`); });
  }

  private blocksOf(rows: SqlRow[], out: Block[]) {
    for (const row of rows) {
      const r = this.decode(row, "block");
      if (r?.kind === "block") out.push(r.data);
    }
  }

  readonly lazy: LazyPersistence = {
    loadSkeleton: () => {
      this.ensureLazyIndexes();
      return this.guard("load", () => {
        const out: WireRecord[] = [];
        const rows = [
          ...this.db.all("SELECT kind, id, data FROM records WHERE kind != 'block'"),
          ...this.db.all(`SELECT kind, id, data FROM records WHERE kind = 'block' AND ${SKELETON_SQL} = 1`),
        ];
        for (const row of rows) {
          const r = this.decode(row);
          if (r) out.push(r);
        }
        return out;
      });
    },
    // Je ID und je Elternteil eine eigene (vorbereitete) Abfrage: Mit `IN (…)` über dem Index-Ausdruck sucht SQLite
    // die ganze Tabelle ab (gemessen 17.11.: 1,4 s statt 0,05 ms bei 520 000 Zeilen).
    loadBlocks: (ids) =>
      this.guard("load", () => {
        const out: Block[] = [];
        for (const id of ids) this.blocksOf(this.db.all("SELECT id, data FROM records WHERE kind = 'block' AND id = ?", [id]), out);
        return out;
      }),
    loadChildren: (parents) =>
      this.guard("load", () => {
        const out: Block[] = [];
        for (const parent of parents) this.blocksOf(this.db.all(`SELECT id, data FROM records WHERE kind = 'block' AND ${PARENT_SQL} = ?`, [parent]), out);
        return out;
      }),
    loadRemaining: (skip) =>
      this.guard("load", () => {
        const out: Block[] = [];
        this.scanRecords("block", (r) => { if (r.kind === "block") out.push(r.data); }, skip);
        return out;
      }),
    scanBlocks: (containing, each, opts) =>
      this.guard("load", () => {
        // SQLite sucht die Zeilen ab; JSON und Prüfung laufen nur für Treffer. LIKE unterscheidet bei ASCII nicht
        // nach Groß/Klein, instr sucht genau.
        const where = containing.map(() => (opts?.ignoreCase ? `${JSON_TEXT} LIKE ? ESCAPE '\\'` : `instr(${JSON_TEXT}, ?) > 0`)).join(" OR ");
        const params = opts?.ignoreCase ? containing.map((c) => `%${c.replace(/[\\%_]/g, "\\$&")}%`) : [...containing];
        const out: Block[] = [];
        this.blocksOf(this.db.all(`SELECT id, data FROM records WHERE kind = 'block'${where ? ` AND (${where})` : ""}`, params), out);
        for (const b of out) each(b);
      }),
    countBlocks: () => this.guard("load", () => asInt(first(this.db, "SELECT count(*) AS n FROM records WHERE kind = 'block'")?.n)),
    clockFloor: (maxMillis) => this.guard("load", () => this.readClockMax(maxMillis)),
  };

  /**
   * Neuester Stempel der Datei, gemerkt in `meta` zusammen mit dem Stand des Change-Logs. Passt der nicht mehr (ein
   * Build ohne dieses Merken hat geschrieben) oder fehlt der Eintrag, wird einmal über alle Zeilen gesucht. Stempel,
   * die beim Schreiben weiter als `StampClock.maxDrift` in der Zukunft lagen, zählen nicht (die Uhr lehnt sie ab).
   */
  private clockMax: Stamp | undefined;
  private tracksClock = false;
  private readClockMax(maxMillis: number): Stamp | undefined {
    const seq = this.maxSeq();
    try {
      const saved = JSON.parse(this.meta(CLOCK_MAX_KEY) ?? "null") as { seq?: number; stamp?: string } | null;
      const stamp = saved ? decodeStamp(saved.stamp) : undefined;
      if (saved && saved.seq === seq && (!stamp || stamp.millis <= maxMillis)) {
        this.tracksClock = true;
        return (this.clockMax = stamp);
      }
    } catch {
      // unlesbar: neu bestimmen
    }
    const millis = `json_extract(${JSON_TEXT}, '$.stamp.millis')`;
    const row = first(this.db, `SELECT data FROM records WHERE json_valid(${JSON_TEXT}) AND ${millis} <= ${Math.floor(maxMillis)} ORDER BY ${millis} DESC, json_extract(${JSON_TEXT}, '$.stamp.counter') DESC, json_extract(${JSON_TEXT}, '$.stamp.node') DESC LIMIT 1`);
    let max: Stamp | undefined;
    try {
      const s = (JSON.parse(asText(row?.data) ?? "null") as { stamp?: Partial<Stamp> } | null)?.stamp;
      if (s && typeof s.millis === "number" && typeof s.counter === "number" && typeof s.node === "string") max = { millis: s.millis, counter: s.counter, node: s.node };
    } catch {
      // keine lesbare Zeile
    }
    this.clockMax = max;
    this.tracksClock = true;
    try {
      this.saveClockMax();
    } catch {
      // nicht beschreibbar: beim nächsten Öffnen wieder suchen
    }
    return max;
  }
  private saveClockMax(): void {
    setMeta(this.db, CLOCK_MAX_KEY, JSON.stringify({ seq: this.maxSeq(), stamp: this.clockMax ? encodeStamp(this.clockMax) : undefined }));
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
      this.undecodableKeys.clear();
      // ADR 0017 A1: in Stücken – sonst liegen alle Zeilen als BLOB, als Text und als Objekt gleichzeitig im Speicher.
      this.scanRecords(undefined, (r) => out.push(r));
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
        if (this.tracksClock) {
          // ADR 0017 Stufe B: den neuesten Stempel mitführen (siehe `readClockMax`), in derselben Transaktion.
          const limit = Date.now() + StampClock.maxDrift;
          for (const r of upserts) {
            const s = r.data.stamp as Stamp | undefined;
            if (s && s.millis <= limit && (!this.clockMax || compareStamps(s, this.clockMax) > 0)) this.clockMax = s;
          }
          this.saveClockMax();
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
        if (this.tracksClock) this.saveClockMax(); // das Log ist weitergelaufen: der gemerkte Stempel gilt weiter
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
  // BSD-569: Eine neue, leere Datei beginnt gleich im endgültigen Format – wer mit der Beta anfängt, braucht diese
  // Umstellung nie. Vorhandene Dateien im alten Format bleiben, bis sie ausdrücklich umgestellt werden; `false` als
  // Option (Tests des alten Formats, Geräte an einem noch nicht umgestellten Server) gilt weiter.
  const fresh = rest.propertyRecords === undefined && WorkspaceStore.propertyRecordsForNewFiles && first(db, "SELECT 1 AS x FROM records LIMIT 1") === undefined
    && first(db, "SELECT 1 AS x FROM changes LIMIT 1") === undefined;
  const propertyRecords = hasPropertyRecords(db) || (rest.propertyRecords ?? (WorkspaceStore.propertyRecordsByDefault || fresh));
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
  // ADR 0017 Stufe B, Rückweg: Ohne Laden nach Bedarf braucht die Datei die beiden Indizes nicht – sie kosten Platz und
  // Zeit bei jedem Schreiben. Entfernen ist billig und wiederholbar; die Datei ist danach wie vorher.
  if (!(rest.lazy ?? WorkspaceStore.lazyByDefault)) {
    try {
      persistence.dropLazyIndexes();
    } catch {
      // nicht beschreibbar: bleibt, wie es ist
    }
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
