// BSD-152 Punkt 3: Sync-v2-Client nach docs/sync-protocol.md, Ablauf wie ServerSync.syncV2 in
// BasedBrain/Sync/SyncServer.swift. Push aus dem persistenten Change-Log (überlebt Neustarts), Pull in Seiten
// mit Server-Sequenz als Cursor, Long-Poll auf /sync/v2/wait, Push 1,5 s nach der letzten lokalen Änderung.
// Nur Protokoll v2 (der TS-Client kommt nach v2; ein Server ohne v2 ist ein Fehler, kein Rückfall auf v1).
import {
  keyOf,
  safeParseRecord,
  StoreReadOnlyError,
  type RecordKeyString,
  type RecordKind,
  type Stamp,
  type WireRecord,
  type WorkspaceStore,
} from "@based/core";
import type { SqlitePersistence } from "./persistence.js";

export const PUSHED_KEY = "sync.v2.pushed";
export const PULLED_KEY = "sync.v2.pulled";

export interface WireDeletion {
  kind: RecordKind;
  id: string;
  stamp?: Stamp;
}

export class SyncHTTPError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    super(`HTTP ${status} on ${path}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "SyncHTTPError";
  }
}

export type SyncLog = (level: "info" | "warning" | "error", message: string) => void;

export interface SyncClientOptions {
  /** z. B. https://based.example.com (ohne /sync). */
  baseURL: string;
  token: string;
  fetch?: typeof fetch;
  /** Records/Löschungen pro Anfrage. */
  pageSize?: number;
  onStatus?: (status: string) => void;
  log?: SyncLog;
  /**
   * Läuft vor dem Push jeder Runde (BSD-78: Dateien hochladen, bevor die Records ankommen, die sie nennen).
   * Ein Fehler hier hält die Runde nicht auf.
   */
  beforePush?: () => Promise<void>;
}

export interface SyncRoundResult {
  pushed: number;
  received: number;
  fullPull: boolean;
}

const KINDS = new Set(["workspace", "block", "database", "view"]);

/** Liest Record-Listen Eintrag für Eintrag: ein unlesbarer wird übersprungen und gemeldet, der Rest angewendet. */
export function decodeRecords(list: unknown, log?: SyncLog): WireRecord[] {
  if (!Array.isArray(list)) return [];
  const out: WireRecord[] = [];
  for (const item of list) {
    const parsed = safeParseRecord(item);
    if (parsed.ok) out.push(parsed.record);
    else log?.("warning", `Sync: skipped an unreadable record (${parsed.error.issues[0]?.message ?? "invalid"})`);
  }
  return out;
}

export function decodeDeletions(list: unknown, log?: SyncLog): { keys: RecordKeyString[]; stamps: Map<RecordKeyString, Stamp> } {
  const keys: RecordKeyString[] = [];
  const stamps = new Map<RecordKeyString, Stamp>();
  if (!Array.isArray(list)) return { keys, stamps };
  for (const d of list as Partial<WireDeletion>[]) {
    if (!d || typeof d.id !== "string" || !KINDS.has(d.kind as string)) {
      log?.("warning", "Sync: skipped an unreadable deletion");
      continue;
    }
    const key = keyOf(d.kind as RecordKind, d.id);
    keys.push(key);
    const s = d.stamp;
    if (s && typeof s.millis === "number" && typeof s.counter === "number" && typeof s.node === "string") stamps.set(key, s);
  }
  return { keys, stamps };
}

export class SyncClient {
  readonly baseURL: string;
  pageSize: number;
  lastError: string | undefined;
  /** Zeit der letzten erfolgreichen Runde (ms seit 1970). */
  lastSync: number | undefined;
  private readonly fetcher: typeof fetch;
  private syncing: Promise<void> | undefined;
  private rerun = false;
  private stopped = true;
  private unobserve: (() => void) | undefined;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private tickTimer: ReturnType<typeof setTimeout> | undefined;
  private waitAbort: AbortController | undefined;

  constructor(
    readonly store: WorkspaceStore,
    readonly persistence: SqlitePersistence,
    private readonly opts: SyncClientOptions,
  ) {
    this.baseURL = opts.baseURL.replace(/\/+$/, "");
    this.pageSize = opts.pageSize ?? 500;
    this.fetcher = opts.fetch ?? ((...a) => fetch(...a));
  }

  // MARK: HTTP

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${this.opts.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (signal) init.signal = signal;
    const res = await this.fetcher(`${this.baseURL}/${path}`, init);
    if (!res.ok) throw new SyncHTTPError(res.status, path.split("?")[0] ?? path, await res.text().catch(() => ""));
    return (await res.json()) as T;
  }

  // MARK: Runden

  /** Eine Sync-Runde; läuft schon eine, geht diese danach noch einmal herum (BSD-72). */
  async syncNow(): Promise<void> {
    if (this.syncing) {
      this.rerun = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        let rounds = 0;
        do {
          this.rerun = false;
          rounds += 1;
          await this.syncOnceReporting();
        } while (this.rerun && rounds < 4 && !this.store.isReadOnly);
      } finally {
        this.syncing = undefined;
      }
    })();
    return this.syncing;
  }

  private async syncOnceReporting() {
    // Ohne Speichern keine Pulls: der Cursor würde an nie gespeicherten Änderungen vorbeiziehen.
    if (this.store.isReadOnly) {
      this.lastError = "read-only";
      this.opts.onStatus?.("Sync paused: Based can't save changes on this device");
      return;
    }
    try {
      const r = await this.syncOnce();
      this.lastError = undefined;
      this.lastSync = Date.now();
      this.opts.onStatus?.(`Synced · live (protocol v2)${r.received > 0 ? ` · ${r.received} changes` : ""}`);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.opts.log?.("error", `Sync error: ${this.lastError}`);
      this.opts.onStatus?.(e instanceof StoreReadOnlyError ? "Sync paused: Based can't save changes on this device" : `Sync error: ${this.lastError}`);
    }
  }

  /** Push, dann Pull. Wirft bei Netz-, Server- oder Speicherfehlern (Cursor bleiben dann stehen). */
  async syncOnce(): Promise<SyncRoundResult> {
    const result: SyncRoundResult = { pushed: 0, received: 0, fullPull: false };
    const log = this.opts.log;

    try {
      await this.opts.beforePush?.();
    } catch {
      log?.("warning", "Sync: step before push failed");
    }

    // Push: jede lokale Änderung nach `pushed`.
    let pushed = this.persistence.metaInt(PUSHED_KEY);
    for (;;) {
      const entries = this.persistence.changes(pushed, this.pageSize);
      const last = entries[entries.length - 1];
      if (!last) break;
      const records: WireRecord[] = [];
      const deletions: WireDeletion[] = [];
      let skipped = 0;
      for (const e of entries) {
        if (!e.local) continue;
        const i = e.key.indexOf(":");
        const kind = e.key.slice(0, i) as RecordKind, id = e.key.slice(i + 1);
        // Nur eine echte Löschung ist eine Löschung. Ein Eintrag ohne Record im Speicher ist eine Zeile, die diese
        // Version nicht lesen kann: nie als Löschung pushen (BSD-16).
        if (e.deleted) deletions.push(e.deletedStamp ? { kind, id, stamp: e.deletedStamp } : { kind, id });
        else {
          const r = this.store.record(e.key);
          if (r) records.push(r);
          else skipped += 1;
        }
      }
      if (skipped > 0) log?.("warning", `Sync: ${skipped} undecodable records not pushed`);
      if (records.length > 0 || deletions.length > 0) {
        const reply = await this.request<{ newer?: unknown; deleted?: unknown; seq?: number }>("POST", "sync/v2/push", { records, deletions });
        const newer = decodeRecords(reply.newer, log);
        const deleted = decodeDeletions(reply.deleted, log);
        // Neuere Server-Kopien gewinnen; was der Server gelöscht hält (neuerer Tombstone), wird auch hier gelöscht.
        if (newer.length > 0 || deleted.keys.length > 0) this.store.applyRemote(newer, deleted.keys, deleted.stamps);
        result.pushed += records.length + deletions.length;
      }
      pushed = last.seq;
      this.persistence.setMeta(PUSHED_KEY, String(pushed));
      if (entries.length < this.pageSize) break;
    }

    // Pull. Hat der Server Tombstones jenseits unseres Cursors entfernt (BSD-104), alles neu holen und
    // löschen, was der Server nicht mehr hat.
    let after = this.persistence.metaInt(PULLED_KEY);
    const oldest = await this.serverOldestSeq();
    const fullPull = after > 0 && after < oldest;
    result.fullPull = fullPull;
    if (fullPull) {
      log?.("info", `Sync: pulled ${after} < server oldestSeq ${oldest}: full pull`);
      after = 0;
    }
    const seen = new Set<RecordKeyString>();
    for (;;) {
      const page = await this.request<{ records?: unknown; deletions?: unknown; next: number; more: boolean }>(
        "GET",
        `sync/v2/pull?after=${after}&limit=${this.pageSize}`,
      );
      const records = decodeRecords(page.records, log);
      const deletions = decodeDeletions(page.deletions, log);
      if (records.length > 0 || deletions.keys.length > 0) {
        // Angekommenes wird als nicht-lokal geloggt und deshalb nie zurückgepusht.
        this.store.applyRemote(records, deletions.keys, deletions.stamps);
        result.received += records.length + deletions.keys.length;
      }
      if (fullPull) for (const r of records) seen.add(keyOf(r.kind, r.data.id));
      if (typeof page.next !== "number") throw new Error("sync/v2/pull: reply without next");
      after = page.next;
      if (!fullPull) this.persistence.setMeta(PULLED_KEY, String(after));
      if (!page.more) break;
    }
    if (fullPull) {
      // Lokale Änderungen, die während dieser Runde entstanden (nach dem Push), hat der Server noch nicht: behalten.
      // BSD-220: abgeleitete Änderungen (Echtzeit-Text) kommen über /collab zum Server, nicht über Push: auch behalten.
      const unpushed = new Set<RecordKeyString>(this.persistence.derivedKeys());
      for (let cur = pushed, batch = this.persistence.changes(cur, 5000); batch.length > 0; batch = this.persistence.changes(cur, 5000)) {
        for (const e of batch) if (e.local) unpushed.add(e.key);
        cur = batch[batch.length - 1]!.seq;
      }
      const gone = this.store
        .allRecords()
        .map((r) => keyOf(r.kind, r.data.id))
        .filter((k) => !k.startsWith("workspace:") && !seen.has(k) && !unpushed.has(k));
      if (gone.length > 0) {
        this.store.applyRemote([], gone);
        result.received += gone.length;
      }
      this.persistence.setMeta(PULLED_KEY, String(after));
    }
    return result;
  }

  /** `oldestSeq` aus /sync/v2/info; 0, wenn der Server ihn nicht schickt oder die Anfrage scheitert. */
  private async serverOldestSeq(): Promise<number> {
    try {
      const info = await this.request<{ oldestSeq?: number }>("GET", "sync/v2/info");
      return typeof info.oldestSeq === "number" ? info.oldestSeq : 0;
    } catch {
      return 0;
    }
  }

  // MARK: Laufen

  /** Regelmäßige Runden, Long-Poll und Push nach lokalen Änderungen. */
  start(opts: { intervalMs?: number; waitTimeoutSeconds?: number; pushDelayMs?: number } = {}) {
    if (!this.stopped) return;
    this.stopped = false;
    const interval = opts.intervalMs ?? 20_000;
    const pushDelay = opts.pushDelayMs ?? 1_500;
    this.unobserve = this.store.observe((change) => {
      if (change.origin === "remote" || change.origin === "load" || change.origin === "derived") return;
      clearTimeout(this.pushTimer);
      this.pushTimer = setTimeout(() => void this.syncNow(), pushDelay);
    });
    const tick = async () => {
      if (this.stopped) return;
      await this.syncNow();
      if (!this.stopped) this.tickTimer = setTimeout(() => void tick(), interval);
    };
    void tick();
    void this.listen(opts.waitTimeoutSeconds ?? 25);
  }

  stop() {
    this.stopped = true;
    this.unobserve?.();
    this.unobserve = undefined;
    clearTimeout(this.pushTimer);
    clearTimeout(this.tickTimer);
    this.waitAbort?.abort();
  }

  /** Long-Poll: sobald der Server eine Änderung nach `pulled` hat, eine Runde starten. */
  private async listen(timeoutSeconds: number) {
    let backoff = 2_000;
    while (!this.stopped) {
      this.waitAbort = new AbortController();
      try {
        const pulled = this.persistence.metaInt(PULLED_KEY);
        const started = Date.now();
        const r = await this.request<{ seq: number }>("GET", `sync/v2/wait?after=${pulled}&timeout=${timeoutSeconds}`, undefined, this.waitAbort.signal);
        backoff = 2_000;
        if (r.seq > this.persistence.metaInt(PULLED_KEY)) await this.syncNow();
        // Ein Server/Proxy, der sofort ohne Änderung antwortet, darf keine Endlosschleife auslösen.
        else if (Date.now() - started < 1_000) await new Promise((res) => setTimeout(res, 1_000));
      } catch {
        if (this.stopped) return;
        await new Promise((res) => setTimeout(res, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }
}
