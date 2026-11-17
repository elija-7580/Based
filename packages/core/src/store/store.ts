// BSD-171 (Phase 1, Teil 2): der Datenspeicher des TS-Kerns, portiert aus BasedCore Store/WorkspaceStore.swift.
// Transaktionen mit Undo/Redo (prüft Remote-Änderungen, BSD-27), Last-Writer-Wins-Merge mit gestempelten
// Tombstones (ADR 0002, BSD-24) und einer austauschbaren Persistenz. Verifiziert über fixtures/merge und
// fixtures/undo-remote. Kein UI, keine Plattform-APIs.
import { canonicalStringify, cloneRecord } from "../json.js";
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
  /** ADR 0017 Stufe B: Laden nach Bedarf. Fehlt es, lädt der Store immer alles. */
  lazy?: LazyPersistence;
}

/**
 * ADR 0017 Stufe B: Lesen in Teilen. Der Store hält dann das Gerüst (alles außer Inhaltsblöcken) im Speicher und
 * holt Inhaltsblöcke, wenn jemand nach ihnen fragt. Alle Aufrufe sind synchron (SQLite im Worker, in Node, nativ).
 */
export interface LazyPersistence {
  /** Alle Nicht-Block-Records und alle Gerüst-Blöcke (`isSkeletonBlock`). Darf werfen – dann lädt der Store alles. */
  loadSkeleton(): WireRecord[];
  /** Blöcke nach ID; unbekannte fehlen im Ergebnis. */
  loadBlocks(ids: readonly string[]): Block[];
  /** Alle Blöcke mit einem dieser Eltern (`w`, `b:<id>`, `d:<id>`) – je Elternteil vollständig. */
  loadChildren(parents: readonly string[]): Block[];
  /** Alle Blöcke, deren ID `skip` nicht kennt (der Rest, wenn doch alles gebraucht wird). */
  loadRemaining(skip: (id: string) => boolean): Block[];
  /** Zahl der gespeicherten Blöcke. */
  countBlocks(): number;
  /**
   * Der neueste Stempel aller gespeicherten Records. Ein voll geladener Store sieht ihn beim Laden; hier setzt die
   * Uhr damit hinter Inhalt fort, der noch nicht im Speicher liegt (zurückgestellte Systemuhr). Stempel nach
   * `maxMillis` zählen nicht – die Uhr nimmt sie auch beim Laden nicht an (`StampClock.maxDrift`).
   */
  clockFloor(maxMillis: number): Stamp | undefined;
  /**
   * Alle gespeicherten Blöcke, deren JSON einen der Texte enthält, der Reihe nach durchreichen – ohne sie im
   * Speicher zu behalten. Für abgeleitete Indizes (Links), die nur wenige Blöcke betreffen. Leere Liste = alle
   * Blöcke. `ignoreCase`: Groß/Klein von ASCII-Buchstaben zählt nicht.
   */
  scanBlocks(containing: readonly string[], each: (b: Block) => void, opts?: { ignoreCase?: boolean }): void;
}

/**
 * Gerüst-Blöcke bleiben immer im Speicher: alles mit eigenem Titel (Seiten, Datenbanken, Zeilen) und alles im
 * Papierkorb. Seitenleiste, Titel, Papierkorb, Quick Find nach Titel und Links brauchen nur sie. Die SQL-Fassung
 * steht in `packages/sync/src/persistence.ts` (`SKELETON_SQL`); ein Test hält beide gleich.
 */
export const SKELETON_TYPES = ["page", "databasePage", "databaseInline"] as const;
export const isSkeletonBlock = (b: Block): boolean => (SKELETON_TYPES as readonly string[]).includes(b.type) || b.trashedAt !== undefined;

export class MemoryPersistence implements Persistence {
  private records = new Map<RecordKeyString, WireRecord>();
  private tombs = new Map<RecordKeyString, Stamp | undefined>();
  constructor(initial: WireRecord[] = []) {
    for (const r of initial) this.records.set(recordKey(r), cloneRecord(r));
  }
  loadAll(): WireRecord[] {
    return [...this.records.values()].map((r) => cloneRecord(r));
  }
  write(upserts: WireRecord[], deletions: RecordKeyString[], tombstones: Map<RecordKeyString, Stamp>): void {
    for (const r of upserts) {
      const k = recordKey(r);
      this.records.set(k, cloneRecord(r));
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
  private *storedBlocks(): Iterable<Block> {
    for (const r of this.records.values()) if (r.kind === "block") yield r.data;
  }
  /** Laden nach Bedarf über denselben Speicher (für Tests des Stores ohne SQLite). */
  readonly lazy: LazyPersistence = {
    loadSkeleton: () => [...this.records.values()].filter((r) => r.kind !== "block" || isSkeletonBlock(r.data)).map((r) => cloneRecord(r)),
    loadBlocks: (ids) => ids.flatMap((id) => { const r = this.records.get(keyOf("block", id)); return r?.kind === "block" ? [cloneRecord(r.data)] : []; }),
    loadChildren: (parents) => { const set = new Set(parents); return [...this.storedBlocks()].filter((b) => set.has(b.parent)).map((b) => cloneRecord(b)); },
    loadRemaining: (skip) => [...this.storedBlocks()].filter((b) => !skip(b.id)).map((b) => cloneRecord(b)),
    countBlocks: () => { let n = 0; for (const _ of this.storedBlocks()) n += 1; return n; },
    scanBlocks: (containing, each, opts) => {
      const fold = (s: string) => (opts?.ignoreCase ? s.toLowerCase() : s);
      const needles = containing.map(fold);
      for (const b of this.storedBlocks()) { const json = fold(JSON.stringify(b)); if (needles.length === 0 || needles.some((c) => json.includes(c))) each(cloneRecord(b)); }
    },
    clockFloor: (maxMillis) => {
      let max: Stamp | undefined;
      for (const r of this.records.values()) { const s = r.data.stamp as Stamp | undefined; if (s && s.millis <= maxMillis && (!max || compareStamps(s, max) > 0)) max = s; }
      return max;
    },
  };
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
  /** Name der Transaktion (z. B. „New block“, beim Undo der des rückgängig gemachten Schritts) – für die Diagnose. */
  name?: string;
  /**
   * Blöcke aus `keys`, die den Elternteil gewechselt haben (ADR 0017 Stufe B: wer die Struktur verfolgt, muss dafür
   * nicht mehr die Eltern aller Blöcke im Speicher halten). Fehlt, wenn keiner umgezogen ist.
   */
  moved?: RecordKeyString[];
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
    this.store._set(cloneRecord(r));
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
    const copy = cloneRecord(b);
    f(copy);
    this.put({ kind: "block", data: copy });
  }
  restamp(key: RecordKeyString) {
    if (!this.store.record(key)) return;
    this.touch(key);
    this.forced.add(key);
  }
}

/** Was `BlockMap` vom Store braucht, solange nicht alles geladen ist. */
interface BlockSource {
  fault(id: string): Block | undefined;
  total(): number;
  everything(why: string): void;
}

/**
 * Die Blöcke des Stores. Mit „Laden nach Bedarf“ (ADR 0017 Stufe B) liegen nur Gerüst und Benutztes im Speicher;
 * die Karte verhält sich trotzdem wie der ganze Workspace: `get`/`has` holen einen fehlenden Block aus der Datei,
 * `size` zählt alle, und jeder Durchlauf (`values`, `keys`, `entries`, `forEach`, `for…of`) lädt zuerst den Rest.
 * Wer nur Seiten braucht, nimmt `WorkspaceStore.skeletonBlocks()` – das lädt nichts nach.
 */
export class BlockMap extends Map<string, Block> {
  /** @internal Gesetzt, solange nicht alles geladen ist. */
  source: BlockSource | undefined;
  /** Nur was im Speicher liegt – ohne Nachladen. */
  peek(id: string): Block | undefined {
    return super.get(id);
  }
  /** Nur was im Speicher liegt – ohne Nachladen. */
  loaded(): IterableIterator<Block> {
    return super.values();
  }
  get loadedSize(): number {
    return super.size;
  }
  override get(id: string): Block | undefined {
    const b = super.get(id);
    return b !== undefined || !this.source ? b : this.source.fault(id);
  }
  override has(id: string): boolean {
    return super.has(id) || (this.source !== undefined && this.source.fault(id) !== undefined);
  }
  override get size(): number {
    return this.source ? this.source.total() : super.size;
  }
  override values() {
    this.source?.everything("values");
    return super.values();
  }
  override keys() {
    this.source?.everything("keys");
    return super.keys();
  }
  override entries() {
    this.source?.everything("entries");
    return super.entries();
  }
  override forEach(fn: (value: Block, key: string, map: Map<string, Block>) => void, thisArg?: unknown): void {
    this.source?.everything("forEach");
    super.forEach(fn, thisArg);
  }
  override [Symbol.iterator]() {
    this.source?.everything("iterate");
    return super[Symbol.iterator]();
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
  /**
   * ADR 0017 Stufe B: nur das Gerüst laden, Inhaltsblöcke bei Bedarf (braucht `persistence.lazy`). Standard:
   * `WorkspaceStore.lazyByDefault`. Ohne dies lädt der Store wie bisher alles.
   */
  lazy?: boolean;
}

export class WorkspaceStore {
  readonly blocks = new BlockMap();
  /**
   * ADR 0017 Stufe B: Vorgabe für Stores ohne ausdrückliche Angabe. BASED_LAZY_STORE=1 schaltet sie ein – so läuft
   * die Testsuite auch mit Laden nach Bedarf (ci/typecheck/run-ts.sh).
   */
  static lazyByDefault = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.BASED_LAZY_STORE === "1";
  /** Nur für die Testsuite (BASED_LAZY_STORE=1): auch eine leere Datei nach Bedarf öffnen, damit jeder Test den Weg nimmt. */
  static lazyEvenWhenEmpty = WorkspaceStore.lazyByDefault;
  /** Quelle für Laden nach Bedarf; `undefined`, sobald alles im Speicher liegt (dann verhält sich der Store wie immer). */
  private lazySource: LazyPersistence | undefined;
  /** Eltern, deren Kinder vollständig im Speicher und in `childIndex` sind. Eine Kinderliste ist ganz da oder gar nicht. */
  private loadedParents = new Set<string>();
  /** Blöcke im Speicher, deren Geschwister noch nicht geladen sind – je Elternteil. */
  private strays = new Map<string, Set<string>>();
  /** In dieser Sitzung entfernte Blöcke: nicht aus der Datei zurückholen (dort stehen sie bis zum Commit noch). */
  private gone = new Set<string>();
  private blockTotal = 0;
  private resume = true;
  /** Wie oft doch alles geladen wurde (Messpunkt: nach dem Start soll das für Alltagswege 0 bleiben). */
  fullLoads = 0;
  /** Wird gerufen, wenn alles geladen wird, mit dem Auslöser (`values`, `allRecords`, …). */
  onFullLoad: ((why: string) => void) | undefined;
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
    const resume = (this.resume = opts.resumeClock !== false);
    this.composing = false;
    let source = (opts.lazy ?? WorkspaceStore.lazyByDefault) ? opts.persistence?.lazy : undefined;
    let initial: WireRecord[] | undefined;
    if (source) {
      try {
        initial = source.loadSkeleton();
      } catch {
        // Gerüst nicht lesbar (z. B. Indizes lassen sich nicht anlegen): wie bisher alles laden.
        source = undefined;
      }
    }
    for (const r of initial ?? opts.persistence?.loadAll() ?? []) {
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
    // Eine leere Datei ist vollständig geladen (erster Sync, Import: keine Rückfragen an die Datei je neuem Block).
    if (source && source.countBlocks() === 0 && !WorkspaceStore.lazyEvenWhenEmpty) source = undefined;
    if (source) {
      // Ab hier nach Bedarf: Was geladen ist, wartet je Elternteil, bis dessen Kinder vollständig geholt werden.
      this.lazySource = source;
      this.blockTotal = source.countBlocks();
      const floor = resume ? source.clockFloor(this.clock.wallClock() + StampClock.maxDrift) : undefined;
      if (floor) this.clock.observe(floor);
      this.childIndex.clear();
      for (const b of this.blocks.loaded()) this.stray(b);
      this.blocks.source = {
        fault: (id) => this.fault(id),
        total: () => this.blockTotal,
        everything: (why) => this.loadEverything(why),
      };
    } else this.rebuildChildIndex();
    if (this.propertyRecords) this.migrateToPropertyRecords();
  }

  // MARK: Laden nach Bedarf (ADR 0017 Stufe B)

  /** Lädt der Store noch nach Bedarf? `false`, sobald alles im Speicher liegt (oder von Anfang an alles geladen wurde). */
  get isPartial(): boolean {
    return this.lazySource !== undefined;
  }

  /**
   * Alle Gerüst-Blöcke (Seiten, Datenbanken, Zeilen, Papierkorb) – ohne Inhalt nachzuladen. Für alles, was über
   * „alle Seiten“ läuft: Seitenleiste, Titel, Papierkorb, Quick Find nach Titel.
   */
  *skeletonBlocks(): IterableIterator<Block> {
    for (const b of this.blocks.loaded()) if (isSkeletonBlock(b)) yield b;
  }

  private stray(b: Block) {
    let set = this.strays.get(b.parent);
    if (!set) this.strays.set(b.parent, (set = new Set()));
    set.add(b.id);
  }

  /** Einen aus der Datei gelesenen Block übernehmen, falls er nicht schon (neuer) im Speicher liegt oder entfernt wurde. */
  private adopt(b: Block): boolean {
    if (this.blocks.peek(b.id) !== undefined || this.gone.has(b.id)) return false;
    this.blocks.set(b.id, b);
    // Die Uhr setzt hinter allem fort, was sie gesehen hat (siehe Konstruktor) – auch hinter Nachgeladenem.
    if (this.resume) this.clock.observe(b.stamp ?? ZERO_STAMP);
    return true;
  }

  private fault(id: string): Block | undefined {
    const source = this.lazySource;
    if (!source || this.gone.has(id)) return undefined;
    const [b] = source.loadBlocks([id]);
    if (!b || !this.adopt(b)) return this.blocks.peek(id);
    this.stray(b);
    return b;
  }

  /** Mehrere Blöcke in einem Zug holen (vor großen Merges), statt einzeln beim ersten Zugriff. */
  prefetchBlocks(ids: readonly string[]): void {
    const source = this.lazySource;
    if (!source) return;
    const missing = ids.filter((id) => this.blocks.peek(id) === undefined && !this.gone.has(id));
    if (missing.length === 0) return;
    for (const b of source.loadBlocks(missing)) if (this.adopt(b)) this.stray(b);
  }

  /** Kinderlisten dieser Eltern vollständig machen (eine Abfrage für alle, die noch fehlen). */
  private loadGroups(parents: readonly string[]): void {
    const source = this.lazySource;
    if (!source) return;
    const missing = [...new Set(parents)].filter((p) => !this.loadedParents.has(p));
    if (missing.length === 0) return;
    const lists = new Map<string, Set<string>>(missing.map((p) => [p, new Set(this.strays.get(p) ?? [])]));
    for (const b of source.loadChildren(missing)) {
      this.adopt(b);
      // Maßgeblich ist der Stand im Speicher: ein dort schon verschobener Block gehört nicht mehr hierher.
      const cur = this.blocks.peek(b.id);
      if (cur) lists.get(cur.parent)?.add(cur.id);
    }
    for (const [parent, ids] of lists) {
      const list = [...ids].filter((id) => this.blocks.peek(id)?.parent === parent);
      list.sort((x, y) => this.compareSiblings(x, y));
      if (list.length > 0) this.childIndex.set(parent, list);
      else this.childIndex.delete(parent);
      this.loadedParents.add(parent);
      this.strays.delete(parent);
    }
  }

  /** Doch alles laden: danach verhält sich der Store wie ohne Laden nach Bedarf. */
  private loadEverything(why: string): void {
    const source = this.lazySource;
    if (!source) return;
    for (const b of source.loadRemaining((id) => this.blocks.peek(id) !== undefined || this.gone.has(id))) this.adopt(b);
    this.lazySource = undefined;
    this.blocks.source = undefined;
    this.loadedParents.clear();
    this.strays.clear();
    this.gone.clear();
    this.rebuildChildIndex();
    this.fullLoads += 1;
    this.onFullLoad?.(why);
  }

  /**
   * Über alle Blöcke laufen, deren gespeichertes JSON einen der Texte enthält – ohne den Workspace dafür in den
   * Speicher zu holen. `each` darf den Store lesen, aber nicht schreiben. Voll geladen: ein Durchlauf im Speicher
   * (dann ohne Vorfilter – `each` muss selbst prüfen).
   */
  scanBlocks(containing: readonly string[], each: (b: Block) => void, opts?: { ignoreCase?: boolean }): void {
    if (this.lazySource) this.lazySource.scanBlocks(containing, each, opts);
    else for (const b of this.blocks.loaded()) each(b);
  }

  /** Alles in den Speicher holen (für Vorgänge über den ganzen Workspace: Export, Voll-Abgleich, Suche über Inhalt). */
  ensureComplete(why = "ensureComplete"): void {
    this.loadEverything(why);
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
    this.loadEverything("exportRecords");
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
    this.loadEverything("allRecords");
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
    if (this.lazySource && !this.loadedParents.has(parent)) this.loadGroups([parent]);
    return this.childIndex.get(parent) ?? [];
  }

  descendants(id: string): string[] {
    if (this.lazySource) {
      // Ebene für Ebene in je einer Abfrage holen statt je Block einzeln.
      let level = ["b:" + id];
      while (level.length > 0 && this.lazySource) {
        this.loadGroups(level);
        level = level.flatMap((p) => (this.childIndex.get(p) ?? []).map((c) => "b:" + c));
      }
    }
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
        if (this.lazySource) {
          this.gone.delete(r.data.id);
          if (!old) this.blockTotal += 1;
        }
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
      if (this.lazySource) {
        this.gone.add(id);
        if (old) this.blockTotal -= 1;
      }
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
    if (this.lazySource && !this.loadedParents.has(b.parent)) return this.stray(b);
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
    if (this.lazySource && !this.loadedParents.has(b.parent)) {
      this.strays.get(b.parent)?.delete(b.id);
      return;
    }
    const list = this.childIndex.get(b.parent);
    if (!list) return;
    const i = list.indexOf(b.id);
    if (i >= 0) list.splice(i, 1);
  }
  private compareSiblings(x: string, y: string) {
    const a = this.blocks.peek(x)!.sk, b = this.blocks.peek(y)!.sk;
    if (a !== b) return a < b ? -1 : 1;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  private rebuildChildIndex() {
    this.childIndex.clear();
    for (const b of this.blocks.loaded()) {
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
    // Flache Kopie reicht: Records im Store werden nie an Ort und Stelle geändert (Tx.put legt eine tiefe Kopie ab,
    // Tx.update ändert eine Kopie); hier ändern sich nur Felder der obersten Ebene.
    const c = { kind: r.kind, data: { ...r.data } } as WireRecord;
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
      // Gleiches Objekt = nicht angefasst (Tx.put ersetzt immer durch eine Kopie; der Schnappschuss teilt `data`).
      // Spart den Vergleich als Text bei Records, die nur neu gestempelt werden (Wiederherstellen von 8.000 Seiten).
      const unchanged = prev !== undefined && (prev.data === cur.data || same(cur, prev));
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
      const change: StoreChange = notified.length > 0 ? { keys, origin, notified, name } : { keys, origin, name };
      const moved: RecordKeyString[] = [];
      for (const [k, cur] of after) {
        const prev = before.get(k);
        if (cur?.kind === "block" && prev?.kind === "block" && cur.data.parent !== prev.data.parent) moved.push(k);
      }
      if (moved.length > 0) change.moved = moved;
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
    if (this.lazySource) {
      // Die betroffenen Blöcke in einem Zug holen (Stempelvergleich), statt je Record einzeln nachzufragen.
      const ids: string[] = [];
      for (const r of records) if (r.kind === "block") ids.push(r.data.id);
      for (const k of deletions) if (k.startsWith("block:")) ids.push(k.slice(6));
      this.prefetchBlocks(ids);
    }
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
    this.transact("Delete", (tx) => this.deleteBlocksIn(tx, ids));
  }

  /** Wie `deleteBlocks`, aber in einer laufenden Transaktion (Editor-Befehle, BSD-382). */
  deleteBlocksIn(tx: Tx, ids: readonly string[]) {
    const now = this.now();
    for (const id of ids) {
      const b = tx.block(id);
      if (!b) continue;
      if (this.isTrashable(b)) tx.update(id, (x) => { x.trashedAt = now; });
      else this.removeSubtreeKeepingPages(id, now, tx);
    }
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
