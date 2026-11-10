// BSD-171 (Phase 1, Teil 2): der Datenspeicher des TS-Kerns, portiert aus BasedCore Store/WorkspaceStore.swift.
// Transaktionen mit Undo/Redo (prüft Remote-Änderungen, BSD-27), Last-Writer-Wins-Merge mit gestempelten
// Tombstones (ADR 0002, BSD-24) und einer austauschbaren Persistenz. Verifiziert über fixtures/merge und
// fixtures/undo-remote. Kein UI, keine Plattform-APIs.
import { canonicalStringify } from "../json.js";
import { compareStamps, StampClock, ZERO_STAMP, type Stamp } from "../hlc.js";
import { keyBetween, keysBetween } from "../sortkeys.js";
import type { Block, Database, DatabaseView, RecordKind, WireRecord, Workspace } from "../model/records.js";

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

export type ChangeOrigin = "local" | "undo" | "redo" | "remote" | "load" | "import";
const isLocalWrite = (o: ChangeOrigin) => o === "local" || o === "undo" || o === "redo" || o === "import";

/** Speicher unter dem Store (SQLite auf dem Gerät, Speicher in Tests). */
export interface Persistence {
  loadAll(): WireRecord[];
  write(upserts: WireRecord[], deletions: RecordKeyString[], tombstones: Map<RecordKeyString, Stamp>, local: boolean): void;
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
    this.touch(recordKey(r));
    this.store._set(structuredClone(r));
  }
  remove(key: RecordKeyString) {
    if (!this.store.record(key)) return;
    this.touch(key);
    this.store._remove(key);
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
}

export class WorkspaceStore {
  readonly blocks = new Map<string, Block>();
  readonly databases = new Map<string, Database>();
  readonly views = new Map<string, DatabaseView>();
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
    let ws: Workspace | undefined;
    for (const r of opts.persistence?.loadAll() ?? []) {
      if (r.kind === "workspace") {
        if (!ws || r.data.id === WORKSPACE_ID) ws = r.data;
      } else this._set(r);
    }
    const t = this.now();
    this.workspace = ws ?? { id: WORKSPACE_ID, name: "My Workspace", favorites: [], createdAt: t, updatedAt: t, stamp: { ...ZERO_STAMP } };
    this.rebuildChildIndex();
  }

  // MARK: Lesen

  record(key: RecordKeyString): WireRecord | undefined {
    const { kind, id } = parseKey(key);
    switch (kind) {
      case "block": { const d = this.blocks.get(id); return d && { kind, data: d }; }
      case "database": { const d = this.databases.get(id); return d && { kind, data: d }; }
      case "view": { const d = this.views.get(id); return d && { kind, data: d }; }
      case "workspace": return this.workspace.id === id ? { kind, data: this.workspace } : undefined;
    }
  }

  allRecords(): WireRecord[] {
    return [
      { kind: "workspace", data: this.workspace },
      ...[...this.blocks.values()].map((data) => ({ kind: "block", data }) as const),
      ...[...this.databases.values()].map((data) => ({ kind: "database", data }) as const),
      ...[...this.views.values()].map((data) => ({ kind: "view", data }) as const),
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
      case "database": this.databases.set(r.data.id, r.data); break;
      case "view": this.views.set(r.data.id, r.data); break;
      case "workspace": this.workspace = r.data; break;
    }
  }

  /** @internal */
  _remove(key: RecordKeyString) {
    const { kind, id } = parseKey(key);
    if (kind === "block") {
      const old = this.blocks.get(id);
      if (old) this.unindex(old);
      this.blocks.delete(id);
    } else if (kind === "database") this.databases.delete(id);
    else if (kind === "view") this.views.delete(id);
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
  transact<T>(name: string, body: (tx: Tx) => T, opts: { coalesce?: string; undoable?: boolean; keepStamps?: boolean } = {}): T {
    const tx = new Tx(this);
    try {
      const result = body(tx);
      this.commit(tx, name, opts.coalesce, opts.keepStamps ? "import" : "local", opts.keepStamps ? false : opts.undoable ?? true);
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
    } else c.data.updatedAt = now;
    return c;
  }

  /** `false`: nicht gespeichert (schreibgeschützt oder Schreiben gescheitert); die Änderungen sind im Speicher zurückgedreht. */
  private commit(tx: Tx, name: string, coalesce: string | undefined, origin: ChangeOrigin, undoable: boolean): boolean {
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
    const restamp = origin !== "remote" && origin !== "load" && origin !== "import";
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
      this.persistence?.write(upserts, deletions, tombstones, isLocalWrite(origin));
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
      const change: StoreChange = { keys: [...upserts.map(recordKey), ...deletions], origin };
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
  applyRemote(records: WireRecord[], deletions: RecordKeyString[] = [], deletionStamps = new Map<RecordKeyString, Stamp>()): RemoteMergeResult {
    const tx = new Tx(this);
    const stale: RecordKeyString[] = [];
    const tombstoned = new Map<RecordKeyString, Stamp>();
    for (const r of records) {
      if (r.kind === "workspace" && r.data.id !== this.workspace.id) continue; // ein Workspace pro Store (BSD-23)
      const key = recordKey(r);
      this.clock.observe(stampOf(r));
      const local = this.record(key);
      if (local) {
        if (same(local, r)) continue;
        if (compareStamps(stampOf(local), stampOf(r)) > 0) {
          stale.push(key);
          continue;
        }
      } else {
        const ts = this.persistence?.tombstone(key);
        if (ts && compareStamps(ts, stampOf(r)) >= 0) {
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
