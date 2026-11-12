// BSD-153: Gegenstück zum Store-Host im Hauptthread. Anfragen mit Antwort (Promise), Ereignisse als Zustand für
// React (`subscribe`/`getState`, passend zu useSyncExternalStore) und Seiten-Repliken: ein kleiner WorkspaceStore
// pro offener Seite, auf dem Editor und Lese-Ansicht arbeiten. Lokale Änderungen der Replik gehen an den Worker
// (der sie speichert und synct), Änderungen aus dem Worker kommen als `pageChanges` zurück.
import {
  recordKey,
  WorkspaceStore,
  type GraphFilter,
  type LibraryItem,
  type Outline,
  type Persistence,
  type RecordKeyString,
  type WireRecord,
} from "@based/core";
import type { ImportPayload } from "./importer.js";
import type { ExportFile, PageExportFormat, HTMLExportChoice, ImportSummary, PrintDocument, WorkspaceExportFormat } from "./interop.js";
import type { DueItem } from "@based/brain/home";
import type { MeetingListItem, UnlinkedMentionInfo } from "./protocol.js";
import type { AgentSnapshot, ChatInfo, ChatMeta, StoredChatEvent, ToolResult } from "@based/brain";
import type { AgentAction } from "./agents.js";
import type { JSONValue, SearchFilters, SearchSort } from "@based/core";
import type { ChatLoaded, ToolCatalog } from "./chat.js";
import type { AssetGetResult, AssetInfo, Command, DatabaseInfo, Endpoint, Event, GraphResult, HistoryContent, HistoryList, HistoryRestoreResult, InitResult, PageInfo, PageRecords, Request, RequestMessage, SearchResult, StatusInfo, SyncConfig, SyncedRecords } from "./protocol.js";

export interface ShellState {
  ready: boolean;
  outline: Outline | undefined;
  titles: ReadonlyMap<string, string>;
  status: StatusInfo;
  error?: string;
  /** Chats, zuletzt geänderte zuerst (`undefined`: noch nicht geladen). */
  chats?: readonly ChatInfo[];
  /** Aufträge, Runs, Projekte, Zeitpläne (`undefined`: noch nicht geladen). */
  agents?: AgentSnapshot;
  /** BSD-163: letzter Hinweis aus dem Worker (`id` zählt hoch, damit derselbe Text erneut erscheint). */
  notice?: { id: number; message: string };
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
    this.checkSettled();
  }

  private settleWaiters: { upTo: number; resolve: () => void }[] = [];

  /**
   * BSD-335: Erfüllt, sobald jede bis jetzt abgeschickte Anfrage beantwortet ist. Der Store-Tab antwortet erst nach dem
   * (synchronen) Schreiben in SQLite/OPFS – danach übersteht die Änderung ein Neuladen. Vorher nicht: ein Befehl, der
   * beim Abbau der Seite noch in der Warteschlange des Workers liegt, geht mit dem Worker verloren (z. B. „Move to
   * Trash“ und sofort danach neu laden). Für Tests und für Stellen, die vor dem Verlassen auf den Speicherstand warten.
   */
  settled(): Promise<void> {
    const upTo = this.nextID - 1;
    if (![...this.pending.keys()].some((id) => id <= upTo)) return Promise.resolve();
    return new Promise((resolve) => this.settleWaiters.push({ upTo, resolve }));
  }

  private checkSettled() {
    if (!this.settleWaiters.length) return;
    const oldest = Math.min(Infinity, ...this.pending.keys());
    this.settleWaiters = this.settleWaiters.filter((w) => {
      if (oldest <= w.upTo) return true;
      w.resolve();
      return false;
    });
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

  /** Hinweis schließen. */
  dismissNotice = () => { if (this.state.notice) { const { notice: _n, ...rest } = this.state; this.state = rest; for (const fn of this.listeners) fn(); } };

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
        this.checkSettled();
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
      case "chats": this.set({ chats: ev.chats }); return;
      case "agents": this.set({ agents: ev.snapshot }); return;
      case "notice": this.set({ notice: { id: (this.state.notice?.id ?? 0) + 1, message: ev.message } }); return;
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
  async search(query: string, limit?: number, opts: { filters?: SearchFilters; sort?: SearchSort } = {}): Promise<SearchResult | undefined> {
    const req: Request = limit === undefined ? { type: "search", query } : { type: "search", query, limit };
    if (req.type === "search") {
      if (opts.filters && Object.keys(opts.filters).length) req.filters = opts.filters;
      if (opts.sort && opts.sort !== "bestMatch") req.sort = opts.sort;
    }
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

  /** Versionsverlauf einer Seite (BSD-73): Liste (neueste zuerst), Inhalt einer Version, Wiederherstellen. */
  historyList(pageID: string): Promise<HistoryList> {
    return this.request<HistoryList>({ type: "history", action: { op: "list", pageID } });
  }

  historyContent(pageID: string, versionID: number): Promise<HistoryContent> {
    return this.request<HistoryContent>({ type: "history", action: { op: "content", pageID, versionID } });
  }

  historyRestore(pageID: string, versionID: number): Promise<HistoryRestoreResult> {
    return this.request<HistoryRestoreResult>({ type: "history", action: { op: "restore", pageID, versionID } });
  }

  /** Angaben zu Seiten für Erwähnungen (`null` = gibt es nicht). */
  pageInfo(ids: string[]): Promise<Record<string, PageInfo | null>> {
    return this.request({ type: "pageInfo", ids });
  }

  /** Seitensuche fürs @-Menü (nur Titel, im Worker). */
  findPages(query: string, limit?: number): Promise<PageInfo[]> {
    return this.request(limit === undefined ? { type: "findPages", query } : { type: "findPages", query, limit });
  }

  backlinks(pageID: string): Promise<PageInfo[]> {
    return this.request({ type: "backlinks", pageID });
  }

  /** Ein Synced-Block-Original in die offene Replik von `pageID` holen (für „Paste synced block“). */
  async includeSynced(pageID: string, source: string): Promise<boolean> {
    const r = await this.request<SyncedRecords>({ type: "includeSynced", pageID, source });
    if (r.records.length) this.replicas.get(pageID)?.receive(r.records, []);
    return r.found;
  }

  /** BSD-212: Datenbank für „Linked view of database“ in die Replik von `pageID` holen. */
  async includeDatabase(pageID: string, databaseID: string): Promise<boolean> {
    const r = await this.request<SyncedRecords>({ type: "includeDatabase", pageID, databaseID });
    if (r.records.length) this.replicas.get(pageID)?.receive(r.records, []);
    return r.found;
  }

  /** BSD-212: Datenbanken nach Titel (Auswahl „Linked view of database“). */
  listDatabases(query: string): Promise<DatabaseInfo[]> {
    return this.request({ type: "listDatabases", query });
  }

  /** BSD-90: unverlinkte Erwähnungen einer Seite. */
  unlinkedMentions(pageID: string): Promise<UnlinkedMentionInfo[]> {
    return this.request({ type: "unlinkedMentions", pageID });
  }

  /** BSD-281: alle Meetings (Library-Reiter „Meetings“). */
  meetings(): Promise<MeetingListItem[]> {
    return this.request({ type: "meetings" });
  }

  /** BSD-278: fällige Aufgaben aus den Datenbanken für den rechten Bogen der Startseite. */
  dueItems(fromMs: number, toMs: number): Promise<DueItem[]> {
    return this.request({ type: "dueItems", fromMs, toMs });
  }

  // MARK: Agenten (BSD-195/196/160)

  /** Eine Anfrage an die Agenten-Records im Worker (worker/agents.ts). */
  agents<T>(action: AgentAction): Promise<T> {
    return this.request<T>({ type: "agents", action });
  }

  /** Stand laden; danach hält der Worker ihn über `agents`-Ereignisse aktuell. */
  async agentSnapshot(): Promise<AgentSnapshot> {
    const snapshot = await this.agents<AgentSnapshot>({ op: "snapshot" });
    this.set({ agents: snapshot });
    return snapshot;
  }

  // MARK: Chats (BSD-159)

  /** Chat-Liste laden; danach hält der Worker sie über `chats`-Ereignisse aktuell. */
  async chatList(): Promise<ChatInfo[]> {
    const chats = await this.request<ChatInfo[]>({ type: "chat", action: { op: "list" } });
    this.set({ chats });
    return chats;
  }

  chatCreate(title?: string): Promise<ChatInfo> {
    return this.request<ChatInfo>({ type: "chat", action: title ? { op: "create", title } : { op: "create" } });
  }

  chatLoad(id: string): Promise<ChatLoaded> {
    return this.request<ChatLoaded>({ type: "chat", action: { op: "load", id } });
  }

  chatSave(id: string, base: number, events: StoredChatEvent[], meta?: ChatMeta): Promise<{ events: number }> {
    return this.request<{ events: number }>({ type: "chat", action: meta ? { op: "save", id, base, events, meta } : { op: "save", id, base, events } });
  }

  chatRename(id: string, title: string): Promise<void> {
    return this.request<void>({ type: "chat", action: { op: "rename", id, title } });
  }

  chatDelete(id: string): Promise<void> {
    return this.request<void>({ type: "chat", action: { op: "delete", id } });
  }

  chatToolSpecs(): Promise<ToolCatalog> {
    return this.request<ToolCatalog>({ type: "chat", action: { op: "toolSpecs" } });
  }

  /** Ein Agent-Werkzeug im Worker ausführen (eine Transaktion auf dem echten Store). */
  chatTool(name: string, input: JSONValue): Promise<ToolResult> {
    return this.request<ToolResult>({ type: "chat", action: { op: "tool", name, input } });
  }

  /** BSD-245: Pfade einer Seite für Pfad-Regeln (worker/chat.ts). */
  chatPagePaths(id: string): Promise<string[]> {
    return this.request<string[]>({ type: "chat", action: { op: "pagePaths", id } });
  }

  chatImportLegacy(): Promise<ChatInfo[]> {
    return this.request<ChatInfo[]>({ type: "chat", action: { op: "importLegacy" } });
  }

  syncNow(): Promise<boolean> {
    return this.request<boolean>({ type: "syncNow" });
  }

  /** Vorbereiteten Import (Import-Worker) im Store schreiben. */
  /** BSD-254: eine Datei eines laufenden Imports ablegen (vor `commitImport`). */
  importAsset(a: { id: string; name: string; mime?: string; data: Uint8Array }): Promise<boolean> {
    return this.request<boolean>(a.mime ? { type: "importAsset", assetID: a.id, name: a.name, mime: a.mime, bytes: a.data } : { type: "importAsset", assetID: a.id, name: a.name, bytes: a.data });
  }

  /** BSD-283: abgebrochener Import – schon abgelegte, unbenutzte Dateien wieder entfernen. */
  discardImport(): Promise<number> {
    return this.request<number>({ type: "discardImport" });
  }

  commitImport(payload: ImportPayload, parent?: string): Promise<ImportSummary> {
    return this.request<ImportSummary>(parent ? { type: "commitImport", payload, parent } : { type: "commitImport", payload });
  }

  exportPage(pageID: string, format: PageExportFormat, html?: HTMLExportChoice): Promise<ExportFile> {
    return this.request<ExportFile>({ type: "exportPage", pageID, format, ...(html ? { html } : {}) });
  }

  exportWorkspace(format: WorkspaceExportFormat, html?: HTMLExportChoice): Promise<ExportFile> {
    return this.request<ExportFile>({ type: "exportWorkspace", format, ...(html ? { html } : {}) });
  }

  /** Druckansicht einer Seite (HTML mit eingebetteten Bildern und Druck-Regeln). */
  printPage(pageID: string, css?: string): Promise<PrintDocument> {
    return this.request<PrintDocument>({ type: "printPage", pageID, ...(css ? { css } : {}) });
  }

  /** Alle Einträge für die Library (Seiten, Datenbanken, Zeilen). */
  library(): Promise<LibraryItem[]> {
    return this.request<LibraryItem[]>({ type: "library" });
  }

  /** Seitengraph, im Worker gebaut und zugeschnitten. */
  graph(filter?: GraphFilter): Promise<GraphResult> {
    return this.request<GraphResult>({ type: "graph", ...(filter ? { filter } : {}) });
  }

  /** Datei speichern (BSD-78): liegt danach auf diesem Gerät und wird zum Sync-Server hochgeladen. */
  /** BSD-220: gespeicherter Y-Zustand einer Dokument-Wurzel (Editor). */
  /** BSD-252: hat die Seite lokale Änderungen, die noch nicht beim Server sind? */
  pendingLocal(rootID: string): Promise<boolean> {
    return this.request<boolean>({ type: "pendingLocal", rootID });
  }

  async ydocLoad(rootID: string): Promise<Uint8Array | undefined> {
    return (await this.request<Uint8Array | null>({ type: "ydocLoad", rootID })) ?? undefined;
  }

  ydocSave(rootID: string, state: Uint8Array): Promise<boolean> {
    return this.request<boolean>({ type: "ydocSave", rootID, state });
  }

  assetPut(name: string, bytes: ArrayBuffer, mime?: string): Promise<AssetInfo> {
    return this.request<AssetInfo>(mime ? { type: "assetPut", name, mime, bytes } : { type: "assetPut", name, bytes });
  }

  /** Bytes einer Datei: lokal, sonst vom Sync-Server geholt. */
  assetGet(id: string): Promise<AssetGetResult> {
    return this.request<AssetGetResult>({ type: "assetGet", asset: id });
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

  /**
   * Nach einem Wechsel des Store-Tabs (tabs.ts): der neue Host kennt die offenen Seiten nicht. Jede Replik holt sich
   * ihre Seite neu; offene Anfragen schickt die Verbindung selbst noch einmal.
   */
  async resync(): Promise<void> {
    await Promise.all([...this.replicas.values()].map(async (r) => {
      try {
        const data = await this.request<PageRecords>({ type: "openPage", pageID: r.pageID });
        if (this.replicas.get(r.pageID) === r) r.reset(data.records);
      } catch {
        // Seite weg oder Store nicht bereit: die Replik behält ihren Stand
      }
    }));
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
    // BSD-30: gleiche Form wie der Worker – so schickt eine Schema-Änderung nur die geänderte Property zurück
    this.store = new WorkspaceStore({ node: data.node, persistence: new ReplicaPersistence(data.records), propertyRecords: data.propertyRecords === true, resumeClock: false });
    this.unobserve = this.store.observe((c) => {
      if (c.origin !== "local" && c.origin !== "undo" && c.origin !== "redo" && c.origin !== "derived") return;
      const upserts: WireRecord[] = [];
      const deletions: RecordKeyString[] = [];
      // BSD-30: nur was wirklich geschrieben wurde (nicht die bloß benachrichtigte Datenbank einer Property)
      const sent = c.notified?.length ? c.keys.filter((k) => !c.notified!.includes(k)) : c.keys;
      for (const key of sent) {
        const r = this.store.record(key);
        if (r) upserts.push(structuredClone(r));
        else deletions.push(key);
        this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1);
      }
      const done = () => {
        for (const key of sent) {
          const n = (this.inflight.get(key) ?? 1) - 1;
          if (n <= 0) this.inflight.delete(key);
          else this.inflight.set(key, n);
        }
      };
      const req: Request = { type: "applyLocal", pageID: this.pageID, upserts, deletions };
      if (c.origin === "derived") req.derived = true;
      this.client.request(req).then(
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

  /** Vollständiger Stand der Seite (nach einem Wechsel des Store-Tabs): übernehmen, Fehlendes entfernen. */
  reset(records: WireRecord[]) {
    const have = new Set(records.map(recordKey));
    const gone: RecordKeyString[] = [];
    const s = this.store;
    for (const b of s.blocks.values()) gone.push(recordKey({ kind: "block", data: b }));
    for (const d of s.databases.values()) gone.push(recordKey({ kind: "database", data: d }));
    for (const v of s.views.values()) gone.push(recordKey({ kind: "view", data: v }));
    for (const p of s.properties.values()) gone.push(recordKey({ kind: "property", data: p }));
    this.receive(records, gone.filter((k) => !have.has(k)));
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
