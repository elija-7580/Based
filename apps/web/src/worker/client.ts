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
import type { ExportFile, ExportFormat, HTMLExportChoice, ImportSummary, PrintDocument, WorkspaceExportFormat } from "./interop.js";
import type { AgentSnapshot, ChatInfo, ChatMeta, StoredChatEvent, ToolResult } from "@based/brain";
import type { AgentAction } from "./agents.js";
import type { JSONValue } from "@based/core";
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
      case "chats": this.set({ chats: ev.chats }); return;
      case "agents": this.set({ agents: ev.snapshot }); return;
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
  commitImport(payload: ImportPayload, parent?: string): Promise<ImportSummary> {
    return this.request<ImportSummary>(parent ? { type: "commitImport", payload, parent } : { type: "commitImport", payload });
  }

  exportPage(pageID: string, format: ExportFormat, html?: HTMLExportChoice): Promise<ExportFile> {
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

  /** Vollständiger Stand der Seite (nach einem Wechsel des Store-Tabs): übernehmen, Fehlendes entfernen. */
  reset(records: WireRecord[]) {
    const have = new Set(records.map(recordKey));
    const gone: RecordKeyString[] = [];
    const s = this.store;
    for (const b of s.blocks.values()) gone.push(recordKey({ kind: "block", data: b }));
    for (const d of s.databases.values()) gone.push(recordKey({ kind: "database", data: d }));
    for (const v of s.views.values()) gone.push(recordKey({ kind: "view", data: v }));
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
