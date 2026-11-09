// BSD-153: Gegenstück zum Store-Host im Hauptthread. Anfragen mit Antwort (Promise), Ereignisse als Zustand für
// React (`subscribe`/`getState`, passend zu useSyncExternalStore) und Seiten-Repliken: ein kleiner WorkspaceStore
// pro offener Seite, auf dem Editor und Lese-Ansicht arbeiten. Lokale Änderungen der Replik gehen an den Worker
// (der sie speichert und synct), Änderungen aus dem Worker kommen als `pageChanges` zurück.
import {
  recordKey,
  WorkspaceStore,
  type Outline,
  type Persistence,
  type RecordKeyString,
  type WireRecord,
} from "@based/core";
import type { Command, Endpoint, Event, InitResult, PageRecords, Request, RequestMessage, SearchResult, StatusInfo, SyncConfig } from "./protocol.js";

export interface ShellState {
  ready: boolean;
  outline: Outline | undefined;
  titles: ReadonlyMap<string, string>;
  status: StatusInfo;
  error?: string;
}

const INITIAL: ShellState = { ready: false, outline: undefined, titles: new Map(), status: { state: "starting", persistent: false, canUndo: false, canRedo: false } };

export class RequestCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "RequestCancelled";
  }
}

export class StoreClient {
  private nextID = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<() => void>();
  private state: ShellState = INITIAL;
  private replicas = new Map<string, PageReplica>();
  private lastSearch: number | undefined;
  /** Neue Gerätekennung (der Hauptthread speichert sie). */
  onDevice: ((node: string) => void) | undefined;

  constructor(private readonly endpoint: Endpoint<Event, RequestMessage>) {
    endpoint.addEventListener("message", this.onMessage);
  }

  dispose() {
    this.endpoint.removeEventListener("message", this.onMessage);
    for (const p of this.pending.values()) p.reject(new RequestCancelled());
    this.pending.clear();
  }

  // MARK: Zustand für React

  getState = (): ShellState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<ShellState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  title(id: string): string {
    return this.state.titles.get(id) ?? "Untitled";
  }

  // MARK: Nachrichten

  private onMessage = (e: { data: Event }) => {
    const ev = e.data;
    switch (ev.type) {
      case "reply": {
        const p = this.pending.get(ev.id);
        if (!p) return;
        this.pending.delete(ev.id);
        if (ev.ok) p.resolve(ev.result);
        else p.reject(ev.cancelled ? new RequestCancelled() : new Error(ev.error));
        return;
      }
      case "outline": this.set({ outline: ev.outline }); return;
      case "titles": {
        const titles = new Map(ev.full ? [] : this.state.titles);
        for (const [id, t] of Object.entries(ev.titles)) {
          if (t) titles.set(id, t);
          else titles.delete(id);
        }
        this.set({ titles });
        return;
      }
      case "status": this.set({ status: ev.status }); return;
      case "device": this.onDevice?.(ev.node); return;
      case "pageChanges": this.replicas.get(ev.pageID)?.receive(ev.upserts, ev.deletions); return;
    }
  };

  request<T>(req: Request): Promise<T> {
    const id = this.nextID++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.endpoint.postMessage({ ...req, id } as RequestMessage);
    });
  }

  // MARK: API

  async init(opts: { device?: string; sync?: SyncConfig; opfs?: string } = {}): Promise<InitResult> {
    const req: Request = { type: "init" };
    if (opts.device) req.device = opts.device;
    if (opts.sync) req.sync = opts.sync;
    if (opts.opfs) req.opfs = opts.opfs;
    try {
      const r = await this.request<InitResult>(req);
      this.set({ ready: true });
      return r;
    } catch (e) {
      this.set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  command<T = unknown>(command: Command): Promise<T> {
    return this.request<T>({ type: "command", command });
  }

  /** Quick Find. Eine neuere Suche bricht die vorige ab (`undefined`). */
  async search(query: string, limit?: number): Promise<SearchResult | undefined> {
    const req: Request = limit === undefined ? { type: "search", query } : { type: "search", query, limit };
    const id = this.nextID;
    this.lastSearch = id;
    try {
      const r = await this.request<SearchResult>(req);
      return this.lastSearch === id ? r : undefined;
    } catch (e) {
      if (e instanceof RequestCancelled) return undefined;
      throw e;
    }
  }

  /** Laufende Suche abbrechen (Quick Find geschlossen). */
  cancelSearch() {
    this.lastSearch = undefined;
    void this.search("").catch(() => undefined);
  }

  warmSearch(): Promise<boolean> {
    return this.request<boolean>({ type: "warmSearch" });
  }

  setSync(sync: SyncConfig | undefined): Promise<boolean> {
    return this.request<boolean>(sync ? { type: "setSync", sync } : { type: "setSync" });
  }

  syncNow(): Promise<boolean> {
    return this.request<boolean>({ type: "syncNow" });
  }

  /** Replik einer Seite öffnen; mehrfaches Öffnen teilt dieselbe Replik (Referenzzählung). */
  async openPage(pageID: string): Promise<PageReplica> {
    const existing = this.replicas.get(pageID);
    if (existing) {
      existing.refs += 1;
      return existing;
    }
    const data = await this.request<PageRecords>({ type: "openPage", pageID });
    const again = this.replicas.get(pageID);
    if (again) {
      again.refs += 1;
      return again;
    }
    const r = new PageReplica(this, data);
    this.replicas.set(pageID, r);
    return r;
  }

  /** @internal */
  _release(r: PageReplica) {
    if (this.replicas.get(r.pageID) !== r) return;
    this.replicas.delete(r.pageID);
    void this.request({ type: "closePage", pageID: r.pageID }).catch(() => undefined);
  }
}

/** Speicher der Replik: lädt die Records der Seite, schreibt nichts (der Worker speichert). */
class ReplicaPersistence implements Persistence {
  constructor(private records: WireRecord[]) {}
  loadAll(): WireRecord[] {
    const r = this.records;
    this.records = [];
    return r;
  }
  write(): void {}
  tombstone(): undefined {
    return undefined;
  }
}

/**
 * Replik einer Seite im Hauptthread: ein WorkspaceStore mit der Seite und allem darin (Zeilen, Datenbanken,
 * Ansichten). Editor und Datenbank-Ansicht arbeiten darauf wie auf dem echten Store; der Worker ist die Quelle.
 */
export class PageReplica {
  readonly pageID: string;
  readonly store: WorkspaceStore;
  refs = 1;
  /** Gesendet, aber noch nicht bestätigt: Echos davon überschreiben neuere Eingaben nicht. */
  private inflight = new Map<RecordKeyString, number>();
  private unobserve: () => void;
  /** Letzter Fehler beim Speichern (z. B. schreibgeschützt). */
  lastError: string | undefined;

  constructor(private readonly client: StoreClient, data: PageRecords) {
    this.pageID = data.pageID;
    this.store = new WorkspaceStore({ node: data.node, persistence: new ReplicaPersistence(data.records) });
    this.unobserve = this.store.observe((c) => {
      if (c.origin !== "local" && c.origin !== "undo" && c.origin !== "redo") return;
      const upserts: WireRecord[] = [];
      const deletions: RecordKeyString[] = [];
      for (const key of c.keys) {
        const r = this.store.record(key);
        if (r) upserts.push(structuredClone(r));
        else deletions.push(key);
        this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1);
      }
      const done = () => {
        for (const key of c.keys) {
          const n = (this.inflight.get(key) ?? 1) - 1;
          if (n <= 0) this.inflight.delete(key);
          else this.inflight.set(key, n);
        }
      };
      this.client.request({ type: "applyLocal", pageID: this.pageID, upserts, deletions }).then(
        () => {
          this.lastError = undefined;
          done();
        },
        (e: Error) => {
          this.lastError = e.message;
          done();
        },
      );
    });
  }

  /** Änderungen aus dem Worker übernehmen (Sync, Seitenleiste, Bestätigung eigener Änderungen). */
  receive(upserts: WireRecord[], deletions: RecordKeyString[]) {
    const take = upserts.filter((r) => {
      const key = recordKey(r);
      if (!this.inflight.has(key)) return true;
      // eigenes Echo: nur den Stempel übernehmen, wenn der Inhalt schon stimmt; sonst kommt unsere neuere Fassung noch
      return WorkspaceStore.sameContent(this.store.record(key), r);
    });
    const del = deletions.filter((k) => !this.inflight.has(k));
    if (take.length || del.length) this.store.applyRemote(take, del);
  }

  close() {
    this.refs -= 1;
    if (this.refs > 0) return;
    // Erst nach dem aktuellen Abbau freigeben: React räumt die Seite vor dem Editor auf, und der Editor schreibt beim
    // Schließen seine gesammelten Änderungen (DocSession.close → flush). Ohne Aufschub gingen die verloren.
    setTimeout(() => {
      if (this.refs > 0) return;
      this.unobserve();
      this.client._release(this);
    }, 0);
  }
}
