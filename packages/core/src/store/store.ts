// BSD-171 (Phase 1, Teil 2): der Datenspeicher des TS-Kerns, portiert aus BasedCore Store/WorkspaceStore.swift.
// Transaktionen mit Undo/Redo (prüft Remote-Änderungen, BSD-27), Last-Writer-Wins-Merge mit gestempelten
// Tombstones (ADR 0002, BSD-24) und einer austauschbaren Persistenz. Verifiziert über fixtures/merge und
// fixtures/undo-remote. Kein UI, keine Plattform-APIs.
import { canonicalStringify } from "../json.js";
import { compareStamps, StampClock, ZERO_STAMP, type Stamp } from "../hlc.js";
import { keyBetween, keysBetween } from "../sortkeys.js";
import { diffProperties } from "../model/property-records.js";
import type { Block, Database, DatabaseView, PropertyRecord, PropertySchema, RecordKind, WireRecord, Workspace } from "../model/records.js";

export type RecordKeyString = `${RecordKind}:${string}`;
export const keyOf = (kind: RecordKind, id: string): RecordKeyString => `${kind}:${id}`;
export const recordKey = (r: WireRecord): RecordKeyString => keyOf(r.kind, r.data.id);
export function parseKey(key: RecordKeyString): { kind: RecordKind; id: string } {
  const i = key.indexOf(":");
  return { kind: key.slice(0, i) as RecordKind, id: key.slice(i + 1) };
}

export const WORKSPACE_ID = "workspace";

/** Swift `Date` = Sekunden seit 2001-01-01. */
const swiftNow = () => (Date.now() - 978_307_200_000) / 1000;

/**
 * Läuft nach jedem Remote-Merge (Swift: am Ende von `applyRemote`). BSD-123: database-ops.ts repariert dort doppelte
 * ID-Nummern; als Liste, damit store.ts nicht von den Datenbank-Operationen abhängt.
 */
export const afterRemoteMerge: ((store: WorkspaceStore, records: readonly WireRecord[]) => void)[] = [];

/**
 * `derived`: lokal geschrieben, aber aus einem Y.Doc abgeleitet, das über `/collab` abgeglichen wird (BSD-220). Wird
 * gespeichert und angezeigt, aber nicht gepusht – der Server schreibt dieselben Records aus dem Y.Doc selbst.
 */
export type ChangeOrigin = "local" | "undo" | "redo" | "remote" | "load" | "import" | "derived";
const isLocalWrite = (o: ChangeOrigin) => o === "local" || o === "undo" || o === "redo" || o === "import";

/** Speicher unter dem Store (SQLite auf dem Gerät, Speicher in Tests). */
export interface Persistence {
  loadAll(): WireRecord[];
  /** `derived` (BSD-220): lokal, aber nicht pushen (siehe ChangeOrigin); `local` ist dann `false`. */
  write(upserts: WireRecord[], deletions: RecordKeyString[], tombstones: Map<RecordKeyString, Stamp>, local: boolean, derived?: boolean): void;
  /** Stempel der Löschung, falls der Record hier gelöscht wurde (und die Löschung einen Stempel hatte). */
  tombstone(key: RecordKeyString): Stamp | undefined;
  /** Schreibt eine Probe; wirft, wenn die Datenbank nicht beschreibbar ist (für `retryWrites`). */
  checkWritable?(): void;
}

export class MemoryPersistence implements Persistence {
  private records = new Map<RecordKeyString, WireRecord>();
  private tombs = new Map<RecordKeyString, Stamp | undefined>();
  constructor(initial: WireRecord[] = []) {
    for (const r of initial) this.records.set(recordKey(r), structuredClone(r));
  }
  loadAll(): WireRecord[] {
    return [...this.records.values()].map((r) => structuredClone(r));
  }
  write(upserts: WireRecord[], deletions: RecordKeyString[], tombstones: Map<RecordKeyString, Stamp>): void {
    for (const r of upserts) {
      const k = recordKey(r);
      this.records.set(k, structuredClone(r));
      this.tombs.delete(k);
    }
    for (const k of deletions) {
      this.records.delete(k);
      this.tombs.set(k, tombstones.get(k));
    }
  }
  tombstone(key: RecordKeyString): Stamp | undefined {
    return this.tombs.get(key);
  }
}

/** Schreiben auf die Platte ist gescheitert: der Store ist schreibgeschützt, bis `retryWrites()` klappt. */
export interface WriteFailure {
  message: string;
  /** Swift-Datum (Sekunden seit 2001). */
  since: number;
  /** Änderungen, die seitdem abgewiesen wurden. */
  rejected: number;
}

/** Der Store nimmt keine Änderungen an, weil das Speichern gescheitert ist (nie stiller RAM-Fallback). */
export class StoreReadOnlyError extends Error {
  constructor(message: string) {
    super(`read-only: ${message}`);
    this.name = "StoreReadOnlyError";
  }
}

/** Eine gespeicherte Transaktion (für UI und Sync-Client). */
export interface StoreChange {
  keys: RecordKeyString[];
  origin: ChangeOrigin;
  /**
   * BSD-30: Schlüssel in `keys`, die nur zur Benachrichtigung dabei sind – die Datenbank einer geänderten Property.
   * Ihr eigener Record wurde nicht geschrieben; wer Records weiterreicht (Replik, Sync), überspringt sie.
   */
  notified?: RecordKeyString[];
}

export interface RemoteMergeResult {
  /** Lokal neuer als das Angekommene: der Sender soll die lokale Version nehmen. */
  stale: RecordKeyString[];
  /** Angekommen, aber von einem neueren lokalen Tombstone geschlagen (bleibt gelöscht). */
  tombstoned: Map<RecordKeyString, Stamp>;
}

export interface UndoOutcome {
  name: string | null;
  applied: number;
  skipped: number;
  droppedSteps: number;
}

type Snapshot = WireRecord | undefined;
interface UndoEntry {
  name: string;
  before: Map<RecordKeyString, Snapshot>;
  after: Map<RecordKeyString, Snapshot>;
  coalesceKey: string | undefined;
  time: number;
}

const same = (a: unknown, b: unknown) => canonicalStringify(a) === canonicalStringify(b);
const stampOf = (r: WireRecord): Stamp => (r.data.stamp as Stamp | undefined) ?? ZERO_STAMP;

/** Änderungen innerhalb einer Transaktion. */
export class Tx {
  readonly before = new Map<RecordKeyString, Snapshot>();
  readonly order: RecordKeyString[] = [];
  preserveTimestamps = false;
  readonly tombstoneStamps = new Map<RecordKeyString, Stamp>();
  readonly forced = new Set<RecordKeyString>();
  /**
   * BSD-30: Die Records dieser Transaktion tragen schon ihre Stempel (Sync, Import, Editor-Replik). Eine Datenbank
   * im alten Format (Properties im Record) wird dann je Property nach Last-Writer-Wins eingearbeitet statt blind.
   */
  lww = false;

  constructor(private readonly store: WorkspaceStore) {}

  private touch(key: RecordKeyString) {
    if (!this.before.has(key)) {
      this.before.set(key, this.store.record(key));
      this.order.push(key);
    }
  }
  block(id: string): Block | undefined {
    return this.store.blocks.get(id);
  }
  put(r: WireRecord) {
    // BSD-30: Wer eine Datenbank mit ihrer Property-Liste schreibt (alle Aufrufer, Importe, alte Archive), bekommt
    // sie in Kern + Property-Records zerlegt. Nur ein Record mit leerer Liste ist schon der Kern.
    if (r.kind === "database" && this.store.propertyRecords && r.data.properties.length > 0) {
      const ids = new Set(r.data.properties.map((p) => p.id));
      if (ids.size === r.data.properties.length) return this.putDatabaseWithProperties(r.data);
      // Zwei Properties mit derselben ID lassen sich nicht aufteilen, ohne eine zu verlieren. Eine Datenbank, die
      // so gespeichert ist, bleibt im alten Format; in eine schon aufgeteilte darf so etwas nicht hineingeschrieben werden.
      if (this.store.propertyRecordsOf(r.data.id).length > 0) throw new Error(`BSD-30: database ${r.data.id} would get two properties with the same id`);
    }
    this.putRaw(r);
  }
  private putRaw(r: WireRecord) {
    this.touch(recordKey(r));
    this.store._set(structuredClone(r));
  }
  remove(key: RecordKeyString) {
    if (!this.store.record(key)) return;
    // BSD-30: eine Datenbank nimmt lokal ihre Property-Records mit (vom Sync kommen deren Löschungen einzeln)
    if (this.store.propertyRecords && !this.lww && key.startsWith("database:")) {
      for (const p of this.store.propertyRecordsOf(parseKey(key).id)) this.removeRaw(keyOf("property", p.id));
    }
    this.removeRaw(key);
  }
  private removeRaw(key: RecordKeyString) {
    if (!this.store.record(key)) return;
    this.touch(key);
    this.store._remove(key);
  }

  /**
   * BSD-30 (ADR 0014): Datenbank mit Property-Liste → Kern + Property-Records. Geschrieben wird nur, was sich
   * geändert oder bewegt hat; der Kern nur, wenn sich an ihm etwas geändert hat (das erkennt `commit`).
   */
  private putDatabaseWithProperties(db: Database) {
    const store = this.store;
    const key = keyOf("database", db.id);
    const stored = store.record(key) as { kind: "database"; data: Database & { legacyProperties?: PropertySchema[] } } | undefined;
    // Stand vor der Umstellung (Properties noch im gespeicherten Record): die alte Liste einfrieren – der Rückweg.
    const migrating = stored !== undefined && stored.data.properties.length > 0;
    const diff = diffProperties(db.id, store.propertyRecordsOf(db.id), db.properties, db.stamp);
    for (const rec of diff.upserts) {
      const k = keyOf("property", rec.id);
      if (this.lww) {
        const old = store.properties.get(rec.id);
        if (old && compareStamps(old.stamp, rec.stamp) >= 0) continue;
        const ts = old ? undefined : store.persistence?.tombstone(k);
        if (ts && compareStamps(ts, rec.stamp) >= 0) continue;
      }
      this.putRaw({ kind: "property", data: rec });
    }
    for (const id of diff.removed) {
      const k = keyOf("property", id);
      if (this.lww) {
        const old = store.properties.get(id);
        if (old && compareStamps(old.stamp, db.stamp) > 0) continue;
        this.tombstoneStamps.set(k, db.stamp);
      }
      this.removeRaw(k);
    }
    const core: Database & { legacyProperties?: PropertySchema[] } = { ...structuredClone(db), properties: [] };
    const frozen = migrating ? stored.data.properties : stored?.data.legacyProperties;
    if (frozen !== undefined) core.legacyProperties = structuredClone(frozen);
    else delete core.legacyProperties;
    this.putRaw({ kind: "database", data: core });
  }
  update(id: string, f: (b: Block) => void) {
    const b = this.store.blocks.get(id);
    if (!b) return;
    const copy = structuredClone(b);
    f(copy);
    this.put({ kind: "block", data: copy });
  }
  restamp(key: RecordKeyString) {
    if (!this.store.record(key)) return;
    this.touch(key);
    this.forced.add(key);
  }
}

export interface StoreOptions {
  persistence?: Persistence;
  node: string;
  /** Aktuelle Zeit als Swift-Datum (Sekunden seit 2001); für Tests austauschbar. */
  now?: () => number;
  userID?: string | null;
  /**
   * BSD-30 (ADR 0014): Properties als eigene Records. `databases` zeigt weiter Datenbanken mit ihrer Property-Liste
   * (aus Kern + Property-Records zusammengesetzt); gespeichert und gesynct werden Kern und Property-Records einzeln.
   * Beim Öffnen werden Datenbanken im alten Format umgestellt (deterministisch, siehe `splitDatabase`).
   */
  propertyRecords?: boolean;
  /**
   * Die Uhr setzt beim Laden hinter den gespeicherten Stempeln fort (Standard). Aus für Kopien, die mit der
   * Geräte-Kennung eines anderen Stores schreiben (Seitenreplik im Editor): zwei Uhren mit gleicher Kennung und gleichem
   * Startstand erzeugen sonst dieselben Stempel, und eine der beiden Änderungen verliert.
   */
  resumeClock?: boolean;
}

export class WorkspaceStore {
  readonly blocks = new Map<string, Block>();
  /** Datenbanken, wie die App sie liest: immer mit `properties`. */
  readonly databases = new Map<string, Database>();
  readonly views = new Map<string, DatabaseView>();
  /**
   * BSD-30: Vorgabe für Stores ohne ausdrückliche Angabe. Die Umgebungsvariable BASED_PROPERTY_RECORDS=1 schaltet
   * sie ein – so läuft die ganze Testsuite auch im neuen Format (ci/typecheck/run-ts.sh).
   */
  static propertyRecordsByDefault = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.BASED_PROPERTY_RECORDS === "1";
  /** BSD-30: Property-Records (nur mit `propertyRecords`). */
  readonly properties = new Map<string, PropertyRecord>();
  readonly propertyRecords: boolean;
  /** BSD-30: gespeicherte Datenbank-Records ohne Properties (nur mit `propertyRecords`). */
  private cores = new Map<string, Database>();
  private propertyIndex = new Map<string, Set<string>>();
  private composing = true;
  workspace: Workspace;
  readonly clock: StampClock;
  readonly persistence: Persistence | undefined;
  now: () => number;
  userID: string | null;
  undoCoalesceInterval = 1.5;
  maxUndo = 300;
  revision = 0;
  /** Gesetzt, wenn ein Schreiben gescheitert ist (BSD-152 Punkt 4, wie Swift `writeFailure`). Der Store ist dann schreibgeschützt. */
  writeFailure: WriteFailure | undefined;
  /** Wird gerufen, wenn `writeFailure` gesetzt oder gelöscht wird (Banner in der UI). */
  onWriteFailureChanged: (() => void) | undefined;
  private observers = new Set<(change: StoreChange) => void>();
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private childIndex = new Map<string, string[]>();

  constructor(opts: StoreOptions) {
    this.persistence = opts.persistence;
    this.clock = new StampClock(opts.node);
    this.now = opts.now ?? swiftNow;
    this.userID = opts.userID === undefined ? "me" : opts.userID;
    this.propertyRecords = opts.propertyRecords ?? WorkspaceStore.propertyRecordsByDefault;
    let ws: Workspace | undefined;
    const resume = opts.resumeClock !== false;
    this.composing = false;
    for (const r of opts.persistence?.loadAll() ?? []) {
      if (r.kind === "workspace") {
        if (!ws || r.data.id === WORKSPACE_ID) ws = r.data;
      } else this._set(r);
      // Die Uhr setzt hinter dem Gespeicherten fort: eine lokale Änderung ist sonst (gleiche Millisekunde, zurück
      // gestellte Systemuhr) älter gestempelt als der Stand, den sie ändert, und verliert gegen dessen Wiederkehr.
      if (resume) this.clock.observe(stampOf(r));
    }
    this.composing = true;
    if (this.propertyRecords) for (const id of this.cores.keys()) this.compose(id);
    const t = this.now();
    this.workspace = ws ?? { id: WORKSPACE_ID, name: "My Workspace", favorites: [], createdAt: t, updatedAt: t, stamp: { ...ZERO_STAMP } };
    this.rebuildChildIndex();
    if (this.propertyRecords) this.migrateToPropertyRecords();
  }

  // MARK: Properties als eigene Records (BSD-30)

  /** Property-Records einer Datenbank in ihrer Reihenfolge. */
  propertyRecordsOf(databaseID: string): PropertyRecord[] {
    const ids = this.propertyIndex.get(databaseID);
    if (!ids || ids.size === 0) return [];
    const out: PropertyRecord[] = [];
    for (const id of ids) {
      const r = this.properties.get(id);
      if (r) out.push(r);
    }
    return out.sort((a, b) => (a.sk !== b.sk ? (a.sk < b.sk ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Sicht einer Datenbank neu zusammensetzen: Kern + Property-Records (vor der Umstellung: die Liste im Record). */
  private compose(databaseID: string) {
    if (!this.composing) return;
    const core = this.cores.get(databaseID);
    if (!core) {
      this.databases.delete(databaseID);
      return;
    }
    const records = this.propertyRecordsOf(databaseID);
    const { legacyProperties: _frozen, ...rest } = core as Database & { legacyProperties?: unknown };
    this.databases.set(databaseID, { ...rest, properties: records.length > 0 || core.properties.length === 0 ? records.map((r) => r.schema) : core.properties } as Database);
  }

  /**
   * Datenbanken im alten Format umstellen. Deterministisch (IDs aus Datenbank- und Property-ID, Stempel der
   * Datenbank, Reihenfolge aus der Liste): jedes Gerät kommt zum selben Ergebnis, spätere Änderungen gewinnen.
   * Die alte Liste bleibt im Kern als `legacyProperties`. Gibt die Zahl der umgestellten Datenbanken zurück.
   */
  migrateToPropertyRecords(): number {
    const old = [...this.cores.values()].filter((d) => d.properties.length > 0);
    if (old.length === 0) return 0;
    // Zwei Properties mit derselben ID lassen sich nicht aufteilen, ohne eine zu verlieren: die Datenbank bleibt, wie sie ist.
    const fit = old.filter((d) => new Set(d.properties.map((p) => p.id)).size === d.properties.length);
    this.unsplittable = old.filter((d) => !fit.includes(d)).map((d) => d.id);
    if (fit.length === 0) return 0;
    const tx = new Tx(this);
    tx.lww = true;
    try {
      for (const d of fit) tx.put({ kind: "database", data: d });
    } catch (e) {
      this.rollback(tx);
      throw e;
    }
    // wie ein Import: Stempel bleiben, gespeichert als lokale Änderung (jedes Gerät schickt dieselben Records)
    if (!this.commit(tx, "Properties as records", undefined, "import", false, false)) throw new StoreReadOnlyError(this.writeFailure?.message ?? "write failed");
    return fit.length;
  }
  /** Datenbanken, die nicht umgestellt werden konnten (doppelte Property-ID); sie bleiben im alten Format lesbar. */
  unsplittable: string[] = [];

  // MARK: Lesen

  record(key: RecordKeyString): WireRecord | undefined {
    const { kind, id } = parseKey(key);
    switch (kind) {
      case "block": { const d = this.blocks.get(id); return d && { kind, data: d }; }
      case "database": { const d = this.propertyRecords ? this.cores.get(id) : this.databases.get(id); return d && { kind, data: d }; }
      case "view": { const d = this.views.get(id); return d && { kind, data: d }; }
      case "workspace": return this.workspace.id === id ? { kind, data: this.workspace } : undefined;
      case "property": { const d = this.properties.get(id); return d && { kind, data: d }; }
      default: return undefined;
    }
  }

  /**
   * Record, wie die App ihn liest: eine Datenbank mit ihren Properties (BSD-30). Für Suche, Anzeige und alles, was
   * den Inhalt braucht; `record` liefert, was gespeichert und gesynct wird.
   */
  logicalRecord(key: RecordKeyString): WireRecord | undefined {
    if (this.propertyRecords && key.startsWith("database:")) {
      const d = this.databases.get(parseKey(key).id);
      return d && { kind: "database", data: d };
    }
    return this.record(key);
  }

  /** Alle gespeicherten Records einer Datenbank: der Datenbank-Record und (BSD-30) ihre Property-Records. */
  databaseRecords(databaseID: string): WireRecord[] {
    const db = this.record(keyOf("database", databaseID));
    if (!db) return [];
    return this.propertyRecords ? [db, ...this.propertyRecordsOf(databaseID).map((data) => ({ kind: "property", data }) as const)] : [db];
  }

  /**
   * Alle Records in der Austauschform (Archiv, Export): Datenbanken mit ihrer Property-Liste, keine Property-Records.
   * Das Archivformat bleibt damit dasselbe, egal wie der Store speichert (BSD-30). Der Stempel einer Datenbank ist
   * der neueste aus Kern und Properties, damit ein Import sie als so aktuell behandelt, wie sie ist.
   */
  exportRecords(): WireRecord[] {
    if (!this.propertyRecords) return this.allRecords().filter((r) => r.kind !== "property");
    const databases = [...this.databases.values()].map((d) => {
      let stamp = d.stamp;
      for (const p of this.propertyRecordsOf(d.id)) if (compareStamps(p.stamp, stamp) > 0) stamp = p.stamp;
      return { kind: "database", data: stamp === d.stamp ? d : { ...d, stamp } } as const;
    });
    return [
      { kind: "workspace", data: this.workspace },
      ...[...this.blocks.values()].map((data) => ({ kind: "block", data }) as const),
      ...databases,
      ...[...this.views.values()].map((data) => ({ kind: "view", data }) as const),
    ];
  }

  allRecords(): WireRecord[] {
    return [
      { kind: "workspace", data: this.workspace },
      ...[...this.blocks.values()].map((data) => ({ kind: "block", data }) as const),
      ...[...(this.propertyRecords ? this.cores : this.databases).values()].map((data) => ({ kind: "database", data }) as const),
      ...[...this.views.values()].map((data) => ({ kind: "view", data }) as const),
      ...[...this.properties.values()].map((data) => ({ kind: "property", data }) as const),
    ];
  }

  /** Kinder eines Elternteils (`w`, `b:<id>`, `d:<id>`) nach (sk, id). */
  children(parent: string): string[] {
    return this.childIndex.get(parent) ?? [];
  }

  descendants(id: string): string[] {
    const out: string[] = [];
    const stack = [...this.children("b:" + id)].reverse();
    while (stack.length) {
      const cur = stack.pop()!;
      out.push(cur);
      stack.push(...[...this.children("b:" + cur)].reverse());
    }
    return out;
  }

  /** Nach jeder gespeicherten Transaktion benachrichtigt werden; gibt die Abmeldung zurück. */
  observe(fn: (change: StoreChange) => void): () => void {
    this.observers.add(fn);
    return () => this.observers.delete(fn);
  }

  get isReadOnly(): boolean {
    return this.writeFailure !== undefined;
  }

  /** Prüft, ob die Datenbank wieder beschreibbar ist; hebt den Schreibschutz dann auf. */
  retryWrites(): boolean {
    if (!this.writeFailure) return true;
    try {
      this.persistence?.checkWritable?.();
    } catch (e) {
      this.writeFailure.message = String(e);
      return false;
    }
    this.writeFailure = undefined;
    this.onWriteFailureChanged?.();
    return true;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  // MARK: Rohe Änderungen (nur über Tx)

  /** @internal */
  _set(r: WireRecord) {
    switch (r.kind) {
      case "block": {
        const old = this.blocks.get(r.data.id);
        this.blocks.set(r.data.id, r.data);
        if (!old || old.parent !== r.data.parent || old.sk !== r.data.sk) {
          if (old) this.unindex(old);
          this.index(r.data);
        }
        break;
      }
      case "database":
        if (this.propertyRecords) {
          this.cores.set(r.data.id, r.data);
          this.compose(r.data.id);
        } else this.databases.set(r.data.id, r.data);
        break;
      case "view": this.views.set(r.data.id, r.data); break;
      case "workspace": this.workspace = r.data; break;
      case "property": {
        // Ohne `propertyRecords` nur aufbewahrt (nichts geht verloren), nicht ausgewertet.
        const old = this.properties.get(r.data.id);
        if (old && old.databaseID !== r.data.databaseID) this.propertyIndex.get(old.databaseID)?.delete(old.id);
        this.properties.set(r.data.id, r.data);
        let ids = this.propertyIndex.get(r.data.databaseID);
        if (!ids) this.propertyIndex.set(r.data.databaseID, (ids = new Set()));
        ids.add(r.data.id);
        if (this.propertyRecords) {
          if (old && old.databaseID !== r.data.databaseID) this.compose(old.databaseID);
          this.compose(r.data.databaseID);
        }
        break;
      }
    }
  }

  /** @internal */
  _remove(key: RecordKeyString) {
    const { kind, id } = parseKey(key);
    if (kind === "block") {
      const old = this.blocks.get(id);
      if (old) this.unindex(old);
      this.blocks.delete(id);
    } else if (kind === "database") {
      this.cores.delete(id);
      this.databases.delete(id);
    } else if (kind === "view") this.views.delete(id);
    else if (kind === "property") {
      const old = this.properties.get(id);
      if (!old) return;
      this.properties.delete(id);
      this.propertyIndex.get(old.databaseID)?.delete(id);
      if (this.propertyRecords) this.compose(old.databaseID);
    }
  }

  /** Sortiert einfügen (binäre Suche statt Neusortieren: Laden und große Pulls blieben sonst quadratisch). */
  private index(b: Block) {
    let list = this.childIndex.get(b.parent);
    if (!list) {
      list = [];
      this.childIndex.set(b.parent, list);
    }
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compareSiblings(list[mid]!, b.id) < 0) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, b.id);
  }
  private unindex(b: Block) {
    const list = this.childIndex.get(b.parent);
    if (!list) return;
    const i = list.indexOf(b.id);
    if (i >= 0) list.splice(i, 1);
  }
  private compareSiblings(x: string, y: string) {
    const a = this.blocks.get(x)!.sk, b = this.blocks.get(y)!.sk;
    if (a !== b) return a < b ? -1 : 1;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  private rebuildChildIndex() {
    this.childIndex.clear();
    for (const b of this.blocks.values()) {
      const list = this.childIndex.get(b.parent) ?? [];
      list.push(b.id);
      this.childIndex.set(b.parent, list);
    }
    for (const list of this.childIndex.values()) list.sort((x, y) => this.compareSiblings(x, y));
  }

  // MARK: Transaktionen

  /**
   * Eine Transaktion. `keepStamps`: Records sind schon gestempelt (z. B. vom Editor im Hauptthread oder aus einem
   * Import) und werden unverändert übernommen – trotzdem als lokale Änderung gespeichert und gesynct. Ohne würde der
   * Worker neu stempeln, und das Echo überschriebe neuere Eingaben in der Replik.
   */
  transact<T>(name: string, body: (tx: Tx) => T, opts: { coalesce?: string; undoable?: boolean; keepStamps?: boolean; derived?: boolean } = {}): T {
    const tx = new Tx(this);
    tx.lww = opts.keepStamps === true;
    try {
      const result = body(tx);
      // BSD-220 `derived`: aus einem /collab-Y.Doc abgeleitet (nie rückgängig, nicht pushen); gestempelt wie sonst auch.
      const origin: ChangeOrigin = opts.derived ? "derived" : opts.keepStamps ? "import" : "local";
      this.commit(tx, name, opts.coalesce, origin, opts.keepStamps || opts.derived ? false : opts.undoable ?? true, !opts.keepStamps);
      return result;
    } catch (e) {
      this.rollback(tx);
      throw e;
    }
  }

  private rollback(tx: Tx) {
    for (const key of [...tx.order].reverse()) this.restore(key, tx.before.get(key));
  }

  private restore(key: RecordKeyString, value: Snapshot) {
    if (value) this._set(value);
    else this._remove(key);
  }

  private stamped(r: WireRecord, now: number, keepTimes: boolean): WireRecord {
    const s = this.clock.now();
    const c = structuredClone(r);
    c.data.stamp = s;
    if (c.kind === "block") {
      if (!keepTimes) {
        c.data.updatedAt = now;
        if (this.userID == null) delete c.data.updatedBy;
        else c.data.updatedBy = this.userID;
      }
    } else if (c.kind !== "property") c.data.updatedAt = now;
    return c;
  }

  /** `false`: nicht gespeichert (schreibgeschützt oder Schreiben gescheitert); die Änderungen sind im Speicher zurückgedreht. */
  private commit(tx: Tx, name: string, coalesce: string | undefined, origin: ChangeOrigin, undoable: boolean, stamp?: boolean): boolean {
    if (this.persistence && this.writeFailure && tx.order.length > 0) {
      this.rollback(tx);
      this.writeFailure.rejected += 1;
      return false;
    }
    const upserts: WireRecord[] = [];
    const deletions: RecordKeyString[] = [];
    const tombstones = new Map<RecordKeyString, Stamp>();
    const before = new Map<RecordKeyString, Snapshot>();
    const after = new Map<RecordKeyString, Snapshot>();
    const now = this.now();
    const restamp = stamp ?? (origin !== "remote" && origin !== "load" && origin !== "import");
    for (const key of tx.order) {
      const prev = tx.before.get(key);
      let cur = this.record(key);
      if (!cur) {
        if (prev) {
          deletions.push(key);
          const s = tx.tombstoneStamps.get(key);
          if (s) tombstones.set(key, s);
          else if (restamp) tombstones.set(key, this.clock.now());
          before.set(key, prev);
          after.set(key, undefined);
        }
        continue;
      }
      const unchanged = prev !== undefined && same(cur, prev);
      if (unchanged && !tx.forced.has(key)) continue;
      if (restamp) {
        cur = this.stamped(cur, now, tx.preserveTimestamps || unchanged);
        this.restore(key, cur);
      }
      upserts.push(cur);
      before.set(key, prev);
      after.set(key, cur);
    }
    if (upserts.length === 0 && deletions.length === 0) return true;
    try {
      this.persistence?.write(upserts, deletions, tombstones, isLocalWrite(origin), origin === "derived");
    } catch (e) {
      // Speicher und Platte bleiben gleich: Transaktion im Speicher zurückdrehen, ab jetzt schreibgeschützt.
      this.rollback(tx);
      this.writeFailure = { message: e instanceof Error ? e.message : String(e), since: now, rejected: 1 };
      this.onWriteFailureChanged?.();
      return false;
    }

    if (origin === "local" && undoable) {
      const top = this.undoStack[this.undoStack.length - 1];
      if (coalesce !== undefined && top && top.coalesceKey === coalesce && now - top.time < this.undoCoalesceInterval) {
        for (const [k, v] of before) if (!top.before.has(k)) top.before.set(k, v);
        for (const [k, v] of after) top.after.set(k, v);
        top.time = now;
      } else {
        this.undoStack.push({ name, before, after, coalesceKey: coalesce, time: now });
        if (this.undoStack.length > this.maxUndo) this.undoStack.splice(0, this.undoStack.length - this.maxUndo);
      }
      this.redoStack = [];
    }
    this.revision += 1;
    if (this.observers.size > 0) {
      const keys = [...upserts.map(recordKey), ...deletions];
      const notified: RecordKeyString[] = [];
      // BSD-30: Wer auf eine Datenbank hört, erfährt auch von Änderungen an ihren Properties.
      if (this.propertyRecords) {
        const seen = new Set(keys);
        for (const [k, snap] of [...after, ...before]) {
          if (snap?.kind !== "property") continue;
          const dbKey = keyOf("database", snap.data.databaseID);
          if (k !== dbKey && !seen.has(dbKey)) {
            seen.add(dbKey);
            keys.push(dbKey);
            notified.push(dbKey);
          }
        }
      }
      const change: StoreChange = notified.length > 0 ? { keys, origin, notified } : { keys, origin };
      for (const fn of this.observers) fn(change);
    }
    return true;
  }

  // MARK: Undo / Redo

  clearUndoHistory() {
    this.undoStack = [];
    this.redoStack = [];
  }

  undo(): UndoOutcome {
    return this.step(true);
  }
  redo(): UndoOutcome {
    return this.step(false);
  }

  /** Nur zurückdrehen, was noch so ist, wie der Schritt es hinterlassen hat (keine Remote-Änderung überschreiben). */
  private step(undo: boolean): UndoOutcome {
    const outcome: UndoOutcome = { name: null, applied: 0, skipped: 0, droppedSteps: 0 };
    const stack = undo ? this.undoStack : this.redoStack;
    for (let entry = stack.pop(); entry; entry = stack.pop()) {
      const restore = undo ? entry.before : entry.after;
      const expect = undo ? entry.after : entry.before;
      const keys: RecordKeyString[] = [];
      let skipped = 0;
      const sorted = [...restore.keys()].sort((a, b) => {
        const x = parseKey(a).id, y = parseKey(b).id;
        return x < y ? -1 : x > y ? 1 : 0;
      });
      for (const key of sorted) {
        if (WorkspaceStore.sameContent(this.record(key), expect.get(key))) keys.push(key);
        else skipped += 1;
      }
      outcome.name = entry.name;
      outcome.skipped += skipped;
      if (keys.length === 0) {
        outcome.droppedSteps += 1;
        continue;
      }
      const tx = new Tx(this);
      for (const key of keys) {
        const value = WorkspaceStore.keepingOpenState(restore.get(key), this.record(key));
        if (value) tx.put(value);
        else tx.remove(key);
      }
      this.commit(tx, entry.name, undefined, undo ? "undo" : "redo", false);
      outcome.applied = keys.length;
      const moved: UndoEntry = {
        name: entry.name,
        coalesceKey: undefined,
        time: entry.time,
        before: new Map([...entry.before].filter(([k]) => keys.includes(k))),
        after: new Map([...entry.after].filter(([k]) => keys.includes(k))),
      };
      (undo ? this.redoStack : this.undoStack).push(moved);
      return outcome;
    }
    return outcome;
  }

  /** Gleicher Inhalt, ohne Stempel, Änderungszeit, Bearbeiter und Auf/Zu-Zustand von Toggles. */
  static sameContent(a: Snapshot, b: Snapshot): boolean {
    if (!a || !b) return a === b;
    if (a.kind !== b.kind) return false;
    const strip = (r: WireRecord) => {
      const d = structuredClone(r.data) as Record<string, unknown>;
      delete d.stamp;
      delete d.updatedAt;
      if (r.kind === "block") {
        delete d.updatedBy;
        const props = d.props as Record<string, unknown> | undefined;
        if (props) {
          delete props.isOpen;
          if (Object.keys(props).length === 0) delete d.props;
        }
      }
      return d;
    };
    return same(strip(a), strip(b));
  }

  static keepingOpenState(value: Snapshot, current: Snapshot): Snapshot {
    if (value?.kind !== "block" || current?.kind !== "block") return value;
    const open = current.data.props?.isOpen;
    if (value.data.props?.isOpen === open) return value;
    const c = structuredClone(value) as { kind: "block"; data: Block };
    const props = { ...(c.data.props ?? {}) };
    if (open === undefined) delete props.isOpen;
    else props.isOpen = open;
    if (Object.keys(props).length === 0) delete c.data.props;
    else c.data.props = props;
    return c;
  }

  // MARK: Remote

  /** Records eines anderen Geräts einspielen (Last-Writer-Wins pro Record, gestempelte Tombstones). */
  /**
   * `force` (BSD-285): Records, die der Server abgelehnt hat (Freigabe ohne Bearbeiten-Recht) – seine Kopie gilt,
   * auch wenn die lokale Version einen neueren Stempel trägt; die lokale Änderung käme sonst nie an und bliebe stehen.
   */
  applyRemote(records: WireRecord[], deletions: RecordKeyString[] = [], deletionStamps = new Map<RecordKeyString, Stamp>(), force?: ReadonlySet<RecordKeyString>): RemoteMergeResult {
    const tx = new Tx(this);
    tx.lww = true;
    const stale: RecordKeyString[] = [];
    const tombstoned = new Map<RecordKeyString, Stamp>();
    for (const r of records) {
      if (r.kind === "workspace" && r.data.id !== this.workspace.id) continue; // ein Workspace pro Store (BSD-23)
      const key = recordKey(r);
      this.clock.observe(stampOf(r));
      const local = this.record(key);
      if (local) {
        if (same(local, r)) continue;
        if (!force?.has(key) && compareStamps(stampOf(local), stampOf(r)) > 0) {
          stale.push(key);
          continue;
        }
      } else {
        const ts = this.persistence?.tombstone(key);
        if (ts && !force?.has(key) && compareStamps(ts, stampOf(r)) >= 0) {
          tombstoned.set(key, ts); // hier gelöscht, nachdem diese Version entstand: bleibt gelöscht
          continue;
        }
      }
      tx.put(r);
    }
    for (const key of deletions) {
      const local = this.record(key);
      if (!local) continue;
      const ts = deletionStamps.get(key);
      if (ts) {
        this.clock.observe(ts);
        if (compareStamps(stampOf(local), ts) > 0) {
          stale.push(key);
          continue;
        }
        tx.tombstoneStamps.set(key, ts);
      }
      tx.remove(key);
    }
    // Ohne Speichern darf der Sync seinen Cursor nicht weiterschieben: werfen statt still verwerfen.
    if (!this.commit(tx, "Sync", undefined, "remote", false)) throw new StoreReadOnlyError(this.writeFailure?.message ?? "write failed");
    for (const hook of afterRemoteMerge) hook(this, records);
    return { stale, tombstoned };
  }

  // MARK: Bearbeiten (Ausschnitt; der Rest kommt mit dem Editor in Phase 2)

  /** Tippen: pro Block zu einem Undo-Schritt zusammengefasst. */
  setText(id: string, text: Block["text"]) {
    const b = this.blocks.get(id);
    if (!b || same(b.text ?? "", text ?? "")) return;
    this.transact("Typing", (tx) => tx.update(id, (x) => {
      if (text === undefined || text === "" || (Array.isArray(text) && text.length === 0)) delete x.text;
      else x.text = text;
    }), { coalesce: "text:" + id });
  }

  /** Seite oder eigene Datenbank: kommt in den Papierkorb statt gelöscht zu werden. */
  isTrashable(b: Block): boolean {
    if (b.type === "page" || b.type === "databasePage") return true;
    if (b.type === "databaseInline" || b.type === "databasePage") {
      const db = b.props?.databaseID;
      return db !== undefined && this.databases.get(db)?.blockID === b.id;
    }
    return false;
  }

  /** Blöcke löschen: Seiten/Datenbanken in den Papierkorb, sonst entfernen; darin liegende Seiten werden gerettet (BSD-99). */
  deleteBlocks(ids: string[]) {
    this.transact("Delete", (tx) => {
      const now = this.now();
      for (const id of ids) {
        const b = tx.block(id);
        if (!b) continue;
        if (this.isTrashable(b)) tx.update(id, (x) => { x.trashedAt = now; });
        else this.removeSubtreeKeepingPages(id, now, tx);
      }
    });
  }

  private nestedTrashables(id: string): string[] {
    const out: string[] = [];
    const stack = [...this.children("b:" + id)].reverse();
    while (stack.length) {
      const cur = stack.pop()!;
      const b = this.blocks.get(cur);
      if (!b) continue;
      if (this.isTrashable(b)) {
        out.push(cur);
        continue;
      }
      stack.push(...[...this.children("b:" + cur)].reverse());
    }
    return out;
  }

  containingPage(id: string): string | undefined {
    let cur = this.blocks.get(id);
    while (cur) {
      if (cur.type === "page" || cur.type === "databasePage") return cur.id;
      if (!cur.parent.startsWith("b:")) return undefined;
      cur = this.blocks.get(cur.parent.slice(2));
    }
    return undefined;
  }

  private removeSubtreeKeepingPages(id: string, now: number, tx: Tx) {
    const rescued = this.nestedTrashables(id);
    if (rescued.length) {
      const parent = this.blocks.get(id)?.parent ?? "w";
      let host = "w";
      if (parent.startsWith("b:")) {
        const page = this.containingPage(parent.slice(2));
        if (page) host = "b:" + page;
      } else if (parent.startsWith("d:")) host = parent;
      const keys = this.children(host).map((c) => this.blocks.get(c)!.sk);
      const max = keys.length ? keys.reduce((a, b) => (a > b ? a : b)) : undefined;
      const newKeys = keysBetween(rescued.length, max, undefined);
      rescued.forEach((rid, i) => tx.update(rid, (blk) => {
        blk.parent = host;
        blk.sk = newKeys[i]!;
        if (blk.trashedAt === undefined) blk.trashedAt = now;
        if (host === "w" && blk.type === "databaseInline") blk.type = "databasePage";
      }));
    }
    for (const d of [id, ...this.descendants(id)]) {
      const b = this.blocks.get(d);
      if (b) {
        for (const v of this.views.values()) if (v.blockID === d) tx.remove(keyOf("view", v.id));
        const db = b.props?.databaseID;
        if (db && this.databases.get(db)?.blockID === d) tx.remove(keyOf("database", db));
      }
      tx.remove(keyOf("block", d));
    }
  }

  /** Neuer Sortierschlüssel am Ende eines Elternteils. */
  endKey(parent: string): string {
    const kids = this.children(parent);
    return keyBetween(kids.length ? this.blocks.get(kids[kids.length - 1]!)!.sk : undefined, undefined);
  }
}
