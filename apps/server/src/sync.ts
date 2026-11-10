// Sync v2 (docs/sync-protocol.md) auf dem TS-Server. Gleicher Aufbau wie BasedBrain `SyncServer`: ein
// WorkspaceStore auf einer SqlitePersistence mit Change-Log (dasselbe Dateiformat wie Swift `based-server`),
// eingehende Änderungen werden als „remote“ geloggt, `pull` liest das Change-Log nach `seq`.
import {
  keyOf,
  parseKey,
  safeParseRecord,
  WorkspaceStore,
  type RecordKeyString,
  type RecordKind,
  type Stamp,
  type WireRecord,
} from "@based/core";
import { asInt, asText, decodeStamp, openWorkspace, SqlitePersistence, type SqlDatabase } from "@based/sync";

export const PROTOCOL = 2;
/** Tombstones bleiben so lange (Swift `SyncServer.tombstoneRetentionDays`). */
export const TOMBSTONE_RETENTION_DAYS = 90;
export const OLDEST_SEQ_KEY = "sync.oldestSeq";
export const MAX_PAGE = 5_000;
export const DEFAULT_PAGE = 500;
export const MAX_WAIT_SECONDS = 55;

const KINDS = new Set<RecordKind>(["workspace", "block", "database", "view"]);

/** Löschung auf dem Draht: `{kind, id, stamp?}`. */
export interface WireDeletion {
  kind: RecordKind;
  id: string;
  stamp?: Stamp;
}

export interface PushReply {
  newer: WireRecord[];
  seq: number;
  deleted: WireDeletion[];
}

export interface PullPage {
  records: WireRecord[];
  deletions: WireDeletion[];
  next: number;
  more: boolean;
}

/** Ungültige Anfrage (→ 400). Die Meldung enthält nie Nutzerinhalte. */
export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequest";
  }
}

const isStamp = (v: unknown): v is Stamp =>
  typeof v === "object" && v !== null &&
  typeof (v as Stamp).millis === "number" && typeof (v as Stamp).counter === "number" && typeof (v as Stamp).node === "string";

/**
 * Push-Body streng dekodieren (wie Swift `SyncPush`: ein Server verwirft nie still, was ein Client schickte).
 * Ein Record, der nicht passt, macht den ganzen Push ungültig (400) – der Client versucht es dann erneut.
 */
export interface DecodedPush {
  records: WireRecord[];
  deletions: RecordKeyString[];
  stamps: Map<RecordKeyString, Stamp>;
}

export function decodePush(body: unknown): DecodedPush {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("bad push: body must be an object");
  const b = body as { records?: unknown; deletions?: unknown };
  if (!Array.isArray(b.records)) throw new BadRequest("bad push: records must be an array");
  const rawDeletions = b.deletions ?? [];
  if (!Array.isArray(rawDeletions)) throw new BadRequest("bad push: deletions must be an array");
  const records: WireRecord[] = [];
  b.records.forEach((raw, i) => {
    const parsed = safeParseRecord(raw);
    if (!parsed.ok) throw new BadRequest(`bad push: record ${i} is invalid`);
    records.push(parsed.record);
  });
  const deletions: RecordKeyString[] = [];
  const stamps = new Map<RecordKeyString, Stamp>();
  rawDeletions.forEach((raw: unknown, i) => {
    const d = raw as Partial<WireDeletion> | null;
    if (!d || typeof d !== "object" || !KINDS.has(d.kind as RecordKind) || typeof d.id !== "string") {
      throw new BadRequest(`bad push: deletion ${i} is invalid`);
    }
    if (d.stamp !== undefined && d.stamp !== null && !isStamp(d.stamp)) throw new BadRequest(`bad push: deletion ${i} has an invalid stamp`);
    const key = keyOf(d.kind as RecordKind, d.id);
    deletions.push(key);
    if (d.stamp) stamps.set(key, { millis: d.stamp.millis, counter: d.stamp.counter, node: d.stamp.node });
  });
  return { records, deletions, stamps };
}

const wireDeletion = (key: RecordKeyString, stamp: Stamp | undefined): WireDeletion => {
  const { kind, id } = parseKey(key);
  return stamp ? { kind, id, stamp } : { kind, id };
};

export interface SyncServiceOptions {
  /** HLC-Kennung der Server-Stempel (Swift `--node`, Standard „server“). */
  node?: string;
  /** Uhr für Tombstone-GC (ms seit 1970); für Tests austauschbar. */
  nowMillis?: () => number;
  /** BSD-75: höchstens so viele offene Long-Polls je Client (Standard 16) … */
  maxWaitsPerClient?: number;
  /** … und insgesamt (Standard 1024). Darüber: `WaitLimit` (HTTP 429 mit Retry-After). */
  maxWaits?: number;
}

/** BSD-75: zu viele offene Long-Polls (je Client oder gesamt). */
export class WaitLimit extends Error {
  constructor(readonly scope: "client" | "server") {
    super(scope === "client" ? "too many open waits for this client" : "too many open waits");
    this.name = "WaitLimit";
  }
}

export class SyncService {
  readonly store: WorkspaceStore;
  readonly persistence: SqlitePersistence;
  private readonly waiters = new Set<() => void>();
  private readonly perClient = new Map<string, number>();
  private readonly maxWaitsPerClient: number;
  private readonly maxWaits: number;
  private readonly unobserve: () => void;
  private readonly nowMillis: () => number;
  private closed = false;

  constructor(readonly db: SqlDatabase, opts: SyncServiceOptions = {}) {
    const ws = openWorkspace(db, { node: opts.node ?? "server" });
    this.store = ws.store;
    this.persistence = ws.persistence;
    this.nowMillis = opts.nowMillis ?? Date.now;
    this.maxWaitsPerClient = opts.maxWaitsPerClient ?? 16;
    this.maxWaits = opts.maxWaits ?? 1024;
    // Jede gespeicherte Änderung (Push, MCP, …) weckt wartende Long-Polls – ohne Abfrageschleife.
    this.unobserve = this.store.observe(() => this.wake());
  }

  close() {
    this.closed = true;
    this.unobserve();
    this.wake();
  }

  /** Höchste vergebene Änderungsnummer. Nie kleiner als `oldestSeq` (nach der GC kann die oberste Zeile fehlen). */
  get seq(): number {
    return Math.max(this.persistence.maxSeq(), this.oldestSeq);
  }

  /** Tombstones bis zu dieser Nummer können entfernt sein (0 = nichts kompaktiert). */
  get oldestSeq(): number {
    return this.persistence.metaInt(OLDEST_SEQ_KEY);
  }

  info() {
    return { protocol: PROTOCOL, seq: this.seq, oldestSeq: this.oldestSeq };
  }

  /** Push zusammenführen (Last-Writer-Wins). Ungestempelte Löschungen stempelt der Server beim Empfang. */
  push(body: unknown): PushReply {
    return this.pushDecoded(decodePush(body));
  }

  /** Push nach dem Dekodieren (Teilen: die Freigabeprüfung filtert dazwischen). */
  pushDecoded(p: DecodedPush): PushReply {
    for (const k of p.deletions) if (!p.stamps.has(k)) p.stamps.set(k, this.store.clock.now());
    this.adoptDeviceWorkspace(p.records);
    const merge = this.store.applyRemote(p.records, p.deletions, p.stamps);
    const newer: WireRecord[] = [];
    // `stale` enthält auch Löschungen, die gegen einen neueren Stand verloren: der Record existiert noch → newer.
    for (const k of merge.stale) {
      const r = this.store.record(k);
      if (r) newer.push(r);
    }
    const deleted = [...merge.tombstoned.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, s]) => wireDeletion(k, s));
    this.wake();
    return { newer, seq: this.seq, deleted };
  }

  /**
   * BSD-179: Der Swift-based-server legt beim ersten Start einen eigenen Workspace-Record an („My Workspace“,
   * Stempel = Startzeit, node des Servers). Gegen den verliert per Last-Writer-Wins jeder ältere Record eines
   * Geräts – Name, Icon, Favoriten, Home-Seite und Teamspaces wären weg. Dieser Server legt keinen an, kann aber
   * eine solche Datei übernehmen. Deshalb: solange der Workspace-Record hier der unberührte, vom Server selbst
   * gestempelte Standard ist, gewinnt der gepushte Record eines Geräts. Er bekommt einen frischen Server-Stempel,
   * damit er auch Geräte erreicht, die den Standard schon geholt haben (gleiches Wire-Format, nur ein neuerer
   * Stempel). Ein von einem Gerät geschriebener Stand ist nie „unberührt“ (anderer node) und bleibt bei LWW.
   */
  private adoptDeviceWorkspace(records: WireRecord[]) {
    const mine = this.store.workspace;
    if (!isUntouchedServerDefault(mine, this.store.clock.node)) return;
    const i = records.findIndex((r) => r.kind === "workspace" && r.data.id === mine.id);
    const pushed = records[i];
    if (!pushed || pushed.kind !== "workspace") return;
    if (compare(pushed.data.stamp, mine.stamp) >= 0) return; // gewinnt ohnehin
    if (isDefaultContent(pushed.data)) return; // nichts zu retten
    records[i] = { ...pushed, data: { ...pushed.data, stamp: this.store.clock.now() } };
  }

  /** Änderungen nach `after`, älteste zuerst, höchstens `limit` Einträge pro Seite. */
  pull(after: number, limit = DEFAULT_PAGE): PullPage {
    const n = Math.max(1, Math.min(Math.floor(limit), MAX_PAGE));
    const entries = this.persistence.changes(after, n + 1);
    const page = entries.slice(0, n);
    const records: WireRecord[] = [];
    const deletions: WireDeletion[] = [];
    for (const e of page) {
      // Nur eine ausdrückliche Löschung ist eine Löschung; eine nicht lesbare Zeile wird übersprungen (BSD-16).
      if (e.deleted) deletions.push(wireDeletion(e.key, e.deletedStamp));
      else {
        const r = this.store.record(e.key);
        if (r) records.push(r);
      }
    }
    return { records, deletions, next: page.length > 0 ? page[page.length - 1]!.seq : after, more: entries.length > n };
  }

  /**
   * Long-Poll: antwortet, sobald es eine Änderung nach `after` gibt, spätestens nach `timeoutSeconds` (1…55).
   * Ereignisgesteuert (Store-Beobachter), kein Abfragen. `signal` bricht ab (Verbindung geschlossen).
   */
  wait(after: number, timeoutSeconds = 25, signal?: AbortSignal, client = "anonymous"): Promise<number> {
    const timeout = Math.min(Math.max(timeoutSeconds, 1), MAX_WAIT_SECONDS) * 1000;
    return new Promise((resolve, reject) => {
      if (this.seq > after || signal?.aborted || this.closed) return resolve(this.seq);
      // BSD-75: Grenzen je Client und gesamt (ein Client mit vielen Tabs/Fehlern blockiert sonst alle).
      const mine = this.perClient.get(client) ?? 0;
      if (mine >= this.maxWaitsPerClient) return reject(new WaitLimit("client"));
      if (this.waiters.size >= this.maxWaits) return reject(new WaitLimit("server"));
      this.perClient.set(client, mine + 1);
      const done = () => {
        if (this.seq <= after && !signal?.aborted && !timedOut && !this.closed) return; // noch nichts Neues: weiter warten
        this.waiters.delete(done);
        const n = (this.perClient.get(client) ?? 1) - 1;
        if (n <= 0) this.perClient.delete(client); else this.perClient.set(client, n);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(this.seq);
      };
      let timedOut = false;
      const onAbort = () => done();
      const timer = setTimeout(() => {
        timedOut = true;
        done();
      }, timeout);
      signal?.addEventListener("abort", onAbort);
      this.waiters.add(done);
    });
  }

  /** Alle wartenden Long-Polls prüfen lassen. */
  wake() {
    for (const w of [...this.waiters]) w();
  }

  /** Anzahl offener Long-Polls (Diagnose, Tests). */
  get waiting(): number {
    return this.waiters.size;
  }

  /**
   * Tombstone-GC (BSD-104, wie Swift `SyncServer.compactTombstones`): Löschzeilen des Change-Logs, deren Stempel
   * älter als `days` ist, entfernen; Records bleiben unberührt, ungestempelte Zeilen (vor v3) auch. Hebt
   * `oldestSeq` auf die höchste entfernte Nummer. Gibt die Anzahl entfernter Tombstones zurück.
   */
  compactTombstones(days = TOMBSTONE_RETENTION_DAYS, nowMillis = this.nowMillis()): number {
    const cutoff = nowMillis - days * 86_400_000;
    const db = this.persistence.db;
    const old: number[] = [];
    for (const r of db.all("SELECT seq, deleted_stamp FROM changes WHERE deleted = 1 AND deleted_stamp IS NOT NULL")) {
      const s = decodeStamp(asText(r.deleted_stamp));
      if (s && s.millis < cutoff) old.push(asInt(r.seq));
    }
    if (old.length === 0) return 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const seq of old) db.run("DELETE FROM changes WHERE seq = ? AND deleted = 1", [seq]);
      const max = Math.max(...old);
      if (max > this.oldestSeq) db.run("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)", [OLDEST_SEQ_KEY, new TextEncoder().encode(String(max))]);
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // nichts offen
      }
      throw e;
    }
    // `seq` bleibt monoton: oldestSeq deckt eine entfernte oberste Zeile ab.
    return old.length;
  }

  // MARK: v1 (nur für sehr alte Apps; aktuelle Clients fallen nur bei 404 auf v1 zurück)

  /** v1 `GET /sync/pull?since=<stamp-json>`: alles mit neuerem Stempel plus Tombstones, Cursor = höchster Stempel. */
  pullV1(since: Stamp | undefined) {
    const newerThan = (s: Stamp) => !since || compare(s, since) > 0;
    let cursor: Stamp = since ?? { millis: 0, counter: 0, node: "" };
    const records: WireRecord[] = [];
    for (const r of this.store.allRecords()) {
      const s = (r.data.stamp as Stamp | undefined) ?? { millis: 0, counter: 0, node: "" };
      if (newerThan(s)) records.push(r);
      if (compare(s, cursor) > 0) cursor = s;
    }
    const deletions: { kind: RecordKind; id: string }[] = [];
    for (const r of this.persistence.db.all("SELECT kind, id, deleted_stamp FROM changes WHERE deleted = 1")) {
      const s = decodeStamp(asText(r.deleted_stamp));
      if (since && (!s || compare(s, since) <= 0)) continue;
      deletions.push({ kind: asText(r.kind) as RecordKind, id: asText(r.id) ?? "" });
      if (s && compare(s, cursor) > 0) cursor = s;
    }
    return { records, deletions, cursor };
  }

  /** v1 `POST /sync/push`: zusammenführen, neuere Server-Stände zurück. */
  pushV1(body: unknown) {
    const b = body as { records?: unknown; deletions?: unknown; cursor?: unknown } | null;
    // v1-Löschungen haben keinen Stempel; der Server stempelt sie beim Empfang (wie v2 ohne Stempel).
    const reply = this.push({ records: b?.records, deletions: b?.deletions ?? [] });
    return { records: reply.newer, deletions: [], cursor: this.store.clock.current };
  }
}

type WorkspaceData = Extract<WireRecord, { kind: "workspace" }>["data"];

/** Inhalt wie ein neu angelegter Workspace: Standardname, keine Favoriten, Teamspaces, Icon oder Home-Seite. */
function isDefaultContent(w: WorkspaceData): boolean {
  return w.name === "My Workspace" && w.favorites.length === 0 && (w.teamspaces?.length ?? 0) === 0 && w.icon === undefined && w.homePageID === undefined;
}

/** Der Standard-Record, den ein Server (node = `node`) selbst angelegt hat und den niemand geändert hat. */
export function isUntouchedServerDefault(w: WorkspaceData, node: string): boolean {
  return w.stamp.node === node && w.stamp.millis > 0 && isDefaultContent(w);
}

function compare(a: Stamp, b: Stamp): number {
  if (a.millis !== b.millis) return a.millis < b.millis ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
}
