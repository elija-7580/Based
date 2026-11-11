// BSD-153: der Store-Host im Worker. Hält WorkspaceStore + SqlitePersistence (+ optional SyncClient), führt Befehle
// als Transaktionen aus und schickt der UI nur, was sie braucht: Seitenleisten-Struktur (nur bei Strukturänderungen),
// Titel (nur geänderte), Status und die Records offener Seiten. Ohne Worker-Globals, damit er in Node testbar ist
// (die Worker-Datei `store.worker.ts` verbindet ihn nur mit `self`).
import {
  buildOutline,
  buildPageGraph,
  createPage,
  createTeamspace,
  deleteForever,
  deleteTeamspace,
  duplicatePages,
  filterGraph,
  libraryItems,
  renameTeamspace,
  setTeamspaceIcon,
  dropPages,
  emptyTrash,
  insertPage,
  isDescendant,
  isPageLike,
  isTrashed,
  iconText,
  keysBetween,
  LinkIndex,
  syncedDependencies,
  syncedOriginal,
  movePages,
  pageAncestors,
  parseKey,
  PRIVATE_SECTION,
  recordKey,
  renamePage,
  renameWorkspace,
  setWorkspaceIcon,
  linkUnlinkedMention,
  unlinkedMentions,
  restorePages,
  SearchIndex,
  setFavorite,
  subtree,
  structureSignature,
  titleOf,
  trashPages,
  trashedPages,
  createDatabase,
  createMeeting,
  meetingTitleFor,
  dbops,
  plainText,
  MemoryHistoryStorage,
  VersionHistory,
  type Block,
  type GraphFilter,
  type HistoryStorage,
  type PageGraph,
  type RecordKeyString,
  type StoreChange,
  type WireRecord,
  type WorkspaceStore,
  assetIDsInStore,
  remapAssetRefs,
  remapStoreAssets,
  type SearchFilters,
  type SearchOptions,
  type SearchSort,
} from "@based/core";
import { AssetError, AssetSync, MemoryAssetBlobStore, MemoryYDocStorage, PUSHED_KEY, SyncClient, type AssetBlobStore, type DeviceNodeStore, type SqlitePersistence, type YDocStorage } from "@based/sync";
import type { AssetStore, StoredAsset } from "./assets.js";
import { commitImportPayload, exportPage, exportWorkspace, printPage, type ImportSummary } from "./interop.js";
import type { ImportPayload } from "./importer.js";
import { PageHistory } from "./history.js";
import { ChatHost } from "./chat.js";
import { AgentHost } from "./agents.js";
import { BrainHost } from "./brain.js";
import { dueItems } from "@based/brain/home";
import type { MeetingListItem } from "./protocol.js";
import type { AssetGetResult, AssetInfo, Command, DatabaseInfo, Event, GraphResult, HistoryAction, InitResult, PageInfo, QuickFindHit, RequestMessage, SearchResult, StatusInfo, SyncConfig, SyncState, SyncedRecords } from "./protocol.js";

export interface OpenedWorkspace {
  store: WorkspaceStore;
  persistence: SqlitePersistence;
  /** Daten liegen dauerhaft (OPFS); sonst nur im Speicher. */
  persistent: boolean;
  /** Warum nicht dauerhaft (für den Status). */
  note?: string;
  /** Ablage des Versionsverlaufs (history.sqlite); ohne: im Speicher. */
  history?: HistoryStorage;
  /** Ablage der Dateien (BSD-78; OPFS); ohne: im Speicher. */
  assets?: AssetBlobStore;
  /** BSD-220: Y-Zustände der Editor-Dokumente (ydocs.sqlite); ohne: im Speicher. */
  ydocs?: YDocStorage;
}

export interface HostOptions {
  open: (opts: { device: DeviceNodeStore; opfs?: string }) => Promise<OpenedWorkspace>;
  post: (e: Event) => void;
  fetch?: typeof fetch;
  online?: () => boolean;
  /** Sync-Takt (Tests: kurz). */
  syncTiming?: { intervalMs?: number; waitTimeoutSeconds?: number; pushDelayMs?: number };
  /** Datei-Übertragung (Tests: kleine Stücke, kurze Wartezeiten). */
  assetTiming?: { chunkSize?: number; backoff?: { minMs: number; maxMs: number } };
  /** Dateien aus Importen (IndexedDB, Schlüssel = Asset-ID der Records). Anzeige und Exporte lesen hier zuerst, dann im
   *  Blob-Speicher des Syncs (BSD-78). Ohne: nur der Blob-Speicher. */
  importedAssets?: AssetStore;
  /** BSD-230: Verzögerung der Migration alter Import-Dateien nach dem Start (Tests: 0). */
  migrateDelayMs?: number;
  /** Aufschub für Quick Find, damit neuere Eingaben ältere abbrechen (Tests: synchron über 0). */
  defer?: (fn: () => void) => void;
}

const WELCOME = "Welcome to Based";

export class StoreHost {
  ws: OpenedWorkspace | undefined;
  private device: string | undefined;
  private sync: SyncClient | undefined;
  /** Dateien (BSD-78): lokaler Blob-Speicher + Upload-Warteschlange. */
  assets: AssetSync | undefined;
  private syncState: SyncState = "starting";
  private syncDetail: string | undefined;
  private signatures = new Map<string, string>();
  private parents = new Map<string, string>();
  private titles = new Map<string, string>();
  private structureDirty = false;
  private titleDelta = new Map<string, string>();
  private flushQueued = false;
  private openPages = new Map<string, Set<RecordKeyString>>();
  private pageDelta = new Map<string, { upserts: Map<RecordKeyString, WireRecord>; deletions: Set<RecordKeyString> }>();
  /** Volltextindex für Quick Find: einmal gebaut, danach inkrementell (geänderte Records vor der nächsten Suche). */
  private index: SearchIndex | undefined;
  private indexDirty = new Set<RecordKeyString>();
  private pendingSearch: { id: number; query: string; limit: number; filters?: SearchFilters | undefined; sort?: SearchSort | undefined } | undefined;
  /** Backlink-Index: beim ersten Gebrauch gebaut, danach inkrementell (wie der Volltextindex). */
  private links: LinkIndex | undefined;
  private linksDirty = new Set<RecordKeyString>();
  /** Je offener Seite: Synced-Originale von anderen Seiten (samt Inhalt) und deren Vorfahren, die die Replik mitführt. */
  private syncedDeps = new Map<string, { roots: Set<string>; ancestors: Set<string>; databases: Set<string> }>();
  private syncedDirty = new Set<string>();
  private lastStatus = "";
  /** Versionsverlauf (BSD-73). */
  history: PageHistory | undefined;
  private historyTimer: ReturnType<typeof setInterval> | undefined;
  /** Chats und Agent-Werkzeuge (BSD-159). */
  private chatHost: ChatHost | undefined;
  /** Aufträge und Runs des Hauptagenten (BSD-195/196/160). */
  private agentHost: AgentHost | undefined;
  /** Agent Brain: Skills, Memories, lokaler Index, Löschschutz (BSD-163, worker/brain.ts). */
  private brainHost: BrainHost | undefined;

  constructor(private readonly opts: HostOptions) {}

  private get store(): WorkspaceStore {
    if (!this.ws) throw new Error("not initialised");
    return this.ws.store;
  }

  private get chat(): ChatHost {
    return (this.chatHost ??= new ChatHost(this.store, () => this.searchIndex()));
  }

  private get agents(): AgentHost {
    return (this.agentHost ??= new AgentHost(this.store));
  }

  private memoryYDocs: YDocStorage | undefined;
  /** BSD-220: Y-Zustände (ein Cache neben den Records; fehlt die Datei, im Speicher bis zum Neuladen). */
  get ydocs(): YDocStorage {
    if (!this.ws) throw new Error("not initialised");
    return this.ws.ydocs ?? (this.memoryYDocs ??= new MemoryYDocStorage());
  }

  private get brain(): BrainHost {
    return (this.brainHost ??= new BrainHost(this.store));
  }

  /** Eine Anfrage der UI. Antworten gehen als `reply` mit derselben ID zurück. */
  async handle(msg: RequestMessage): Promise<void> {
    const reply = (result: unknown) => this.opts.post({ type: "reply", id: msg.id, ok: true, result });
    try {
      switch (msg.type) {
        case "init": reply(await this.init(msg.device, msg.sync, msg.opfs)); break;
        case "command": reply(this.command(msg.command)); break;
        case "search": this.queueSearch(msg.id, msg.query, msg.limit ?? 30, msg.filters, msg.sort); break;
        case "warmSearch": this.searchIndex(); reply(true); break;
        case "openPage": reply(this.openPage(msg.pageID)); break;
        case "closePage": this.openPages.delete(msg.pageID); this.pageDelta.delete(msg.pageID); this.syncedDeps.delete(msg.pageID); this.syncedDirty.delete(msg.pageID); this.history?.pageClosed(msg.pageID); reply(true); break;
        case "pageInfo": reply(this.pageInfos(msg.ids)); break;
        case "findPages": reply(this.findPages(msg.query, msg.limit ?? 8)); break;
        case "backlinks": reply(this.backlinks(msg.pageID)); break;
        case "includeSynced": reply(this.includeSynced(msg.pageID, msg.source)); break;
        case "includeDatabase": reply(this.includeDatabase(msg.pageID, msg.databaseID)); break;
        case "listDatabases": reply(this.listDatabases(msg.query)); break;
        case "dueItems": reply(dueItems(this.store, msg.fromMs, msg.toMs)); break;
        case "meetings": reply(this.meetings()); break;
        case "unlinkedMentions": reply(unlinkedMentions(this.store, msg.pageID).map((m) => ({ ...m, pageTitle: titleOf(this.store, m.pageID) || "Untitled" }))); break;
        case "applyLocal": this.applyLocal(msg.upserts, msg.deletions, msg.derived === true); reply(true); break;
        case "setSync": this.startSync(msg.sync); reply(true); break;
        case "syncNow": await this.sync?.syncNow(); reply(true); break;
        case "commitImport": reply(await this.commitImport(msg.payload, msg.parent)); break;
        case "importAsset": reply(await this.importAsset(msg.assetID, msg.bytes, msg.name, msg.mime)); break;
        case "discardImport": reply(await this.discardImport()); break;
        case "exportPage": reply(await exportPage(this.store, msg.pageID, msg.format, this.exportAssets(), msg.html)); break;
        case "exportWorkspace": reply(await exportWorkspace(this.store, msg.format, this.exportAssets(), msg.html)); break;
        case "printPage": reply(await printPage(this.store, msg.pageID, this.exportAssets(), msg.css)); break;
        case "library": reply(libraryItems(this.store)); break;
        case "graph": reply(this.graph(msg.filter)); break;
        case "history": reply(this.historyAction(msg.action)); break;
        case "assetPut": reply(await this.assetPut(msg.bytes, msg.name, msg.mime)); break;
        // Nicht abwarten: ein Download darf die Nachrichten-Schlange des Workers nicht aufhalten.
        case "assetGet":
          void this.assetGet(msg.asset).then(
            (r) => this.opts.post({ type: "reply", id: msg.id, ok: true, result: r }),
            (e: unknown) => this.opts.post({ type: "reply", id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) }),
          );
          break;
        case "chat": reply(this.chat.handle(msg.action)); break;
        case "agents": reply(this.agents.handle(msg.action)); break;
        case "brain": reply(this.brain.handle(msg.action)); break;
        case "ydocLoad": reply(this.ydocs.get(msg.rootID) ?? null); break;
        case "pendingLocal": reply(this.pendingLocal(msg.rootID)); break;
        case "ydocSave": this.ydocs.put(msg.rootID, msg.state); reply(true); break;
      }
    } catch (e) {
      this.opts.post({ type: "reply", id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    this.flush();
  }

  /**
   * BSD-252: lokale Änderungen an Blöcken dieser Seite (oder ihr selbst), die der Sync noch nicht gepusht hat. Ohne
   * Server: keine (dann gibt es auch kein /collab). Sucht im Change-Log nach dem Push-Cursor.
   */
  private pendingLocal(rootID: string): boolean {
    const ws = this.ws;
    if (!ws || !this.sync) return false;
    const store = ws.store;
    const inRoot = (id: string): boolean => {
      let cur: string | undefined = id;
      for (let guard = 0; cur && guard < 256; guard++) {
        if (cur === rootID) return true;
        const b = store.blocks.get(cur);
        if (!b || (isPageLike(b) && cur !== id)) return false; // eine andere Seite dazwischen: eigene Wurzel
        cur = b.parent.startsWith("b:") ? b.parent.slice(2) : undefined;
      }
      return false;
    };
    let after = ws.persistence.metaInt(PUSHED_KEY);
    for (;;) {
      const page = ws.persistence.changes(after, 1000);
      for (const e of page) {
        if (!e.local || !e.key.startsWith("block:")) continue;
        const id = e.key.slice(6);
        if (e.deleted || inRoot(id)) return true;
      }
      if (page.length < 1000) return false;
      after = page[page.length - 1]!.seq;
    }
  }

  // MARK: Start

  async init(device: string | undefined, sync: SyncConfig | undefined, opfs: string | undefined): Promise<InitResult> {
    if (this.ws) return { node: this.store.clock.node, persistent: this.ws.persistent, created: false };
    this.device = device;
    const deviceStore: DeviceNodeStore = {
      get: () => this.device,
      set: (node) => {
        this.device = node;
        this.opts.post({ type: "device", node });
      },
    };
    this.ws = await this.opts.open(opfs === undefined ? { device: deviceStore } : { device: deviceStore, opfs });
    const store = this.ws.store;
    let homePageID: string | undefined;
    // Erststart ohne Daten und ohne Server: leerer Workspace mit einer Willkommensseite.
    const created = store.blocks.size === 0 && !sync?.url && !store.isReadOnly;
    if (created) homePageID = this.createWelcome();
    store.observe((c) => this.onChange(c));
    this.assets = new AssetSync(this.ws.assets ?? new MemoryAssetBlobStore(), this.ws.persistence, {
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      ...(this.opts.assetTiming ?? {}),
      onStatus: () => this.postStatus(),
    });
    this.startHistory();
    store.onWriteFailureChanged = () => this.postStatus();
    this.rebuildTracking();
    this.opts.post({ type: "outline", outline: buildOutline(store) });
    this.opts.post({ type: "titles", titles: Object.fromEntries(this.titles), full: true });
    this.syncState = this.ws.persistent ? "local" : "memory";
    this.syncDetail = this.ws.note;
    this.startSync(sync);
    // BSD-230: alte Import-Dateien in den synchronisierten Speicher (im Leerlauf, Fehler nur im Log).
    setTimeout(() => { void this.migrateImportedAssets().catch(() => undefined); }, this.opts.migrateDelayMs ?? 2000);
    const out: InitResult = { node: store.clock.node, persistent: this.ws.persistent, created };
    if (homePageID) out.homePageID = homePageID;
    return out;
  }

  private createWelcome(): string {
    const store = this.store;
    return store.transact("Welcome", (tx) => {
      const id = insertPage(store, tx, { title: WELCOME });
      const lines: [string, string, boolean?][] = [
        ["text", "This is your workspace. Everything you write is saved on this device; connect a sync server in Settings to use it on other devices too."],
        ["heading2", "Start here"],
        ["todo", "Create a page with + next to Private in the sidebar"],
        ["todo", "Press ⌘K (Ctrl+K) to find any page"],
        ["todo", "Drag pages in the sidebar to reorder or nest them"],
        ["todo", "Pages you delete wait in the Trash"],
      ];
      const keys = keysBetween(lines.length, undefined, undefined);
      const now = store.now();
      lines.forEach(([type, text], i) => {
        const b: Block = { id: crypto.randomUUID().toUpperCase(), type, parent: "b:" + id, sk: keys[i]!, text, createdAt: now, updatedAt: now };
        tx.put({ kind: "block", data: b });
      });
      return id;
    }, { undoable: false });
  }

  // MARK: Befehle

  command(c: Command): unknown {
    const store = this.store;
    switch (c.op) {
      case "createPage": {
        const opts: Parameters<typeof createPage>[1] = {};
        if (c.parent) opts.parent = c.parent;
        if (c.title) opts.title = c.title;
        if (c.section && c.section !== PRIVATE_SECTION) opts.section = { kind: "teamspace", id: c.section };
        if (c.after) opts.position = { kind: "after", id: c.after };
        const id = createPage(store, opts);
        return store.blocks.has(id) ? id : undefined;
      }
      case "createMeetingPage": {
        const id = createPage(store, { title: meetingTitleFor(new Date()) });
        createMeeting(store, { parent: "b:" + id });
        return store.blocks.has(id) ? id : undefined;
      }
      case "createDatabase": {
        // Ganze Datenbankseite (Tabelle) oben in Private bzw. unter `parent` (Phase 2, @based/database-ui).
        const parent = c.parent ? "b:" + c.parent : "w";
        const created = createDatabase(store, { parent, ...(c.title ? { title: c.title } : {}) });
        return store.blocks.has(created.blockID) ? created.blockID : undefined;
      }
      case "rename": return renamePage(store, c.id, c.title);
      case "trash": return trashPages(store, this.brain.guardDelete(c.ids).allowed);
      case "restore": return restorePages(store, c.ids);
      case "deleteForever": { const ids = this.brain.guardDelete(c.ids).allowed; this.history?.forget(ids); return deleteForever(store, ids); }
      case "emptyTrash": this.history?.forget(trashedPages(store).map((b) => b.id)); return emptyTrash(store);
      case "drop": return dropPages(store, c.ids, c.target, c.zone);
      case "moveToSection":
        return movePages(store, c.ids, { kind: "top", section: c.section === PRIVATE_SECTION ? { kind: "private" } : { kind: "teamspace", id: c.section } });
      case "favorite": return setFavorite(store, c.ids, c.on);
      case "moveInto": return movePages(store, c.ids, { kind: "page", id: c.parent });
      case "duplicate": return duplicatePages(store, c.ids);
      case "createTeamspace": return createTeamspace(store, c.name, c.icon);
      case "renameTeamspace": return renameTeamspace(store, c.id, c.name);
      case "renameWorkspace": return renameWorkspace(store, c.name);
      case "setWorkspaceIcon": return setWorkspaceIcon(store, c.icon);
      case "linkMention": return linkUnlinkedMention(store, c.blockID, c.start, c.length, c.pageID);
      case "setTeamspaceIcon": return setTeamspaceIcon(store, c.id, c.icon);
      case "deleteTeamspace": return deleteTeamspace(store, c.id);
      case "undo": return store.undo().name;
      case "redo": return store.redo().name;
      case "seed": return this.seed(c.count, c.prefix ?? "Page");
      case "seedDatabase": return this.seedDatabase(c.count);
      case "seedDueTasks": return this.seedDueTasks();
    }
  }

  // MARK: Seitengraph

  private graphCache: { revision: number; graph: PageGraph } | undefined;

  /** Graph des aktuellen Stands (je Revision einmal gebaut), zugeschnitten nach `filter`. */
  graph(filter: GraphFilter = {}): GraphResult {
    const t0 = performance.now();
    const store = this.store;
    if (this.graphCache?.revision !== store.revision) this.graphCache = { revision: store.revision, graph: buildPageGraph(store) };
    const all = this.graphCache.graph;
    return { graph: filterGraph(all, filter), totalNodes: all.nodes.length, totalEdges: all.edges.length, took: performance.now() - t0 };
  }

  // MARK: Versionsverlauf (BSD-73)

  private startHistory() {
    const ws = this.ws!;
    const history = new PageHistory(ws.store, new VersionHistory(ws.history ?? new MemoryHistoryStorage()));
    this.history = history;
    ws.store.observe((c) => history.onChange(c));
    this.historyTimer = setInterval(() => history.tick(), 20_000);
    // Alte Versionen ausdünnen, nicht beim Start selbst.
    setTimeout(() => history.maintain(), 30_000);
  }

  historyAction(a: HistoryAction): unknown {
    const h = this.history;
    if (!h) throw new Error("not initialised");
    switch (a.op) {
      case "list": return h.list(a.pageID);
      case "content": return h.content(a.pageID, a.versionID);
      case "restore": return h.restore(a.pageID, a.versionID);
    }
  }

  /** Testdaten: `count` Seiten oben in Private, je mit einem Absatz. Eine Transaktion. */
  private seed(count: number, prefix: string): number {
    const store = this.store;
    const last = store.children("w").at(-1);
    const keys = keysBetween(count, last ? store.blocks.get(last)?.sk : undefined, undefined);
    const width = String(count).length;
    store.transact("Seed", (tx) => {
      const now = store.now();
      for (let i = 0; i < count; i++) {
        const id = crypto.randomUUID().toUpperCase();
        const n = String(i + 1).padStart(width, "0");
        tx.put({ kind: "block", data: { id, type: "page", parent: "w", sk: keys[i]!, text: `${prefix} ${n}`, createdAt: now, updatedAt: now } });
        tx.put({ kind: "block", data: { id: id + "-T", type: "text", parent: "b:" + id, sk: "a0", text: `Notes on topic ${n}: confidence intervals, sample size ${i % 97}.`, createdAt: now, updatedAt: now } });
      }
    }, { undoable: false });
    return count;
  }

  /** BSD-215 (Tests): Datenbankseite mit `count` Zeilen in einem Schritt; liefert die Seiten-ID. */
  private seedDatabase(count: number): string {
    const store = this.store;
    const made = createDatabase(store, { parent: "w", title: `Big ${count}`, sampleRows: 0, undoable: false });
    const db = store.databases.get(made.databaseID)!;
    const keys = keysBetween(count, undefined, undefined);
    store.transact("Seed rows", (tx) => {
      const now = store.now();
      for (let i = 0; i < count; i++) {
        tx.put({ kind: "block", data: { id: crypto.randomUUID().toUpperCase(), type: "page", parent: "d:" + db.id, sk: keys[i]!, text: `Row ${i + 1}`, createdAt: now, updatedAt: now } });
      }
    }, { undoable: false });
    return made.blockID;
  }

  /** BSD-281: Meeting-Blöcke außerhalb des Papierkorbs mit ihrer Seite, neueste zuerst. */
  meetings(): MeetingListItem[] {
    const store = this.store;
    const out: MeetingListItem[] = [];
    for (const b of store.blocks.values()) {
      if (b.type !== "meeting" || isTrashed(store, b.id)) continue;
      const pageID = store.containingPage(b.id);
      if (!pageID) continue;
      const info = b.props?.meeting;
      const at = info?.startedAt ?? b.createdAt;
      const item: MeetingListItem = {
        meetingID: b.id, pageID, title: plainText(b.text) || "Meeting", pageTitle: titleOf(store, pageID) || "Untitled",
        status: info?.status ?? "ready", atMs: at * 1000 + 978_307_200_000,
      };
      if (info?.duration !== undefined) item.duration = info.duration;
      out.push(item);
    }
    return out.sort((a, b) => b.atMs - a.atMs);
  }

  private seedDueTasks(): string {
    const store = this.store;
    const made = createDatabase(store, { parent: "w", title: "Due tasks", viewType: "board", sampleRows: 0, undoable: false });
    const db = structuredClone(store.databases.get(made.databaseID)!);
    const status = db.properties.find((p) => p.type === "status")!;
    const date = { id: crypto.randomUUID(), name: "Due", type: "date" };
    db.properties.push(date);
    const [open, , done] = status.options!.map((o) => o.id);
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    const sw = (ms: number) => (ms - 978_307_200_000) / 1000;
    const rows: [string, number, boolean, string][] = [
      ["Pay rent", sw(day.getTime()), false, open!],
      ["Call the dentist", sw(day.getTime()), false, done!],
      ["Ship the release", sw(Date.now() + 2 * 3_600_000), true, open!],
    ];
    const keys = keysBetween(rows.length, undefined, undefined);
    store.transact("Seed due tasks", (tx) => {
      tx.put({ kind: "database", data: db });
      const now = store.now();
      rows.forEach(([text, start, includeTime, option], i) => {
        tx.put({ kind: "block", data: {
          id: crypto.randomUUID().toUpperCase(), type: "page", parent: "d:" + db.id, sk: keys[i]!, text, createdAt: now, updatedAt: now,
          values: { [status.id]: { status: { _0: option } }, [date.id]: { date: { _0: { start, includeTime } } } },
        } });
      });
    }, { undoable: false });
    return made.blockID;
  }

  // MARK: Änderungen → UI

  private rebuildTracking() {
    this.signatures.clear();
    this.parents.clear();
    this.titles.clear();
    for (const b of this.store.blocks.values()) {
      this.parents.set(b.id, b.parent);
      if (isPageLike(b)) {
        this.signatures.set(b.id, structureSignature(b));
        this.titles.set(b.id, titleOf(this.store, b.id));
      }
    }
  }

  private onChange(change: StoreChange) {
    const store = this.store;
    for (const key of change.keys) {
      const { kind, id } = parseKey(key);
      if (this.index && (kind === "block" || kind === "database")) this.indexDirty.add(key);
      if (this.links && kind === "block") this.linksDirty.add(key);
      if (kind === "workspace") this.structureDirty = true;
      else if (kind === "block") this.trackBlock(id);
      else if (kind === "database") {
        const owner = store.databases.get(id)?.blockID;
        if (owner) this.trackTitle(owner);
        else for (const [pid] of this.titles) if (store.blocks.get(pid)?.props?.databaseID === id) this.trackTitle(pid);
      }
      for (const [pageID, keys] of this.openPages) {
        if (!keys.has(key) && !this.belongsTo(key, pageID)) continue;
        this.notePageChange(pageID, key);
        // Eine Synced-Kopie ist dazugekommen oder zeigt woandershin: die Replik braucht das Original.
        if (kind === "block" && (store.blocks.get(id)?.props?.syncSource || store.blocks.get(id)?.props?.databaseID)) this.syncedDirty.add(pageID);
      }
    }
    this.chatHost?.noteChange(change);
    this.agentHost?.noteChange(change);
    this.brain.noteChange(change);
    this.scheduleFlush();
  }

  private trackBlock(id: string) {
    const store = this.store;
    const b = store.blocks.get(id);
    const oldParent = this.parents.get(id);
    if (b) this.parents.set(id, b.parent);
    else this.parents.delete(id);
    if (isPageLike(b) || this.signatures.has(id)) {
      const sig = structureSignature(b);
      if (sig !== (this.signatures.get(id) ?? "")) this.structureDirty = true;
      if (b && isPageLike(b)) this.signatures.set(id, sig);
      else this.signatures.delete(id);
      this.trackTitle(id);
    } else if ((oldParent !== undefined && b && oldParent !== b.parent) || (!b && store.children("b:" + id).length > 0)) {
      // ein Toggle o. Ä. mit Seiten darin ist umgezogen oder verschwunden
      this.structureDirty = true;
    }
  }

  private trackTitle(id: string) {
    const b = this.store.blocks.get(id);
    const t = b && isPageLike(b) ? titleOf(this.store, id) : "";
    if ((this.titles.get(id) ?? "") === t) return;
    if (t) this.titles.set(id, t);
    else this.titles.delete(id);
    this.titleDelta.set(id, t);
  }

  private scheduleFlush() {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => this.flush());
  }

  /** Gesammelte Änderungen schicken: Struktur nur wenn nötig, Titel nur die geänderten. */
  flush() {
    this.flushQueued = false;
    if (!this.ws) return;
    if (this.structureDirty) {
      this.structureDirty = false;
      this.opts.post({ type: "outline", outline: buildOutline(this.store) });
    }
    if (this.titleDelta.size) {
      this.opts.post({ type: "titles", titles: Object.fromEntries(this.titleDelta), full: false });
      this.titleDelta.clear();
    }
    for (const pageID of this.syncedDirty) this.refreshSyncedDeps(pageID);
    this.syncedDirty.clear();
    for (const [pageID, d] of this.pageDelta) {
      if (d.upserts.size || d.deletions.size) this.opts.post({ type: "pageChanges", pageID, upserts: [...d.upserts.values()], deletions: [...d.deletions] });
    }
    this.pageDelta.clear();
    const chats = this.chatHost?.takeList();
    if (chats) this.opts.post({ type: "chats", chats });
    const agents = this.agentHost?.takeSnapshot();
    if (agents) this.opts.post({ type: "agents", snapshot: agents });
    this.postStatus();
  }

  // MARK: Offene Seiten (Repliken im Hauptthread)

  private belongsTo(key: RecordKeyString, pageID: string): boolean {
    const store = this.store;
    const { kind, id } = parseKey(key);
    const deps = this.syncedDeps.get(pageID);
    // BSD-212: verknüpfte Datenbanken (Record und Zeilen samt Inhalt).
    if (deps?.databases.size) {
      if (kind === "database" && deps.databases.has(id)) return true;
      if (kind === "block" && dbops.enclosingDatabases(store, id).some((d) => deps.databases.has(d))) return true;
    }
    let blockID: string | undefined;
    if (kind === "block") blockID = id;
    else if (kind === "database") blockID = store.databases.get(id)?.blockID;
    else if (kind === "view") blockID = store.views.get(id)?.blockID;
    if (!blockID) return false;
    if (blockID === pageID || isDescendant(store, blockID, pageID)) return true;
    if (!deps) return false;
    if (deps.roots.has(blockID)) return true;
    if (kind === "block" && deps.ancestors.has(blockID)) return true;
    for (const root of deps.roots) if (isDescendant(store, blockID, root)) return true;
    return false;
  }

  /** Records für die Replik: die Blöcke `ids` samt eigenen Datenbanken und Ansichten. */
  private recordsFor(ids: readonly string[]): WireRecord[] {
    const store = this.store;
    const out: WireRecord[] = [];
    const blockSet = new Set(ids);
    for (const id of ids) {
      const b = store.blocks.get(id);
      if (!b) continue;
      out.push({ kind: "block", data: b });
      const db = b.props?.databaseID;
      if (db && store.databases.get(db)?.blockID === id) out.push({ kind: "database", data: store.databases.get(db)! });
    }
    for (const v of store.views.values()) if (blockSet.has(v.blockID)) out.push({ kind: "view", data: v });
    return out;
  }

  /** Records der Synced-Originale (samt Inhalt) und ihrer Vorfahren (nur die Blöcke selbst). */
  private syncedRecords(roots: Iterable<string>, ancestors: Iterable<string>): WireRecord[] {
    const store = this.store;
    const ids: string[] = [];
    for (const r of roots) ids.push(r, ...subtree(store, r));
    const out = this.recordsFor(ids);
    for (const a of ancestors) {
      const b = store.blocks.get(a);
      if (b) out.push({ kind: "block", data: b });
    }
    return out;
  }

  /** Nach einer Änderung an Synced-Kopien: neu dazugekommene Originale an die Replik schicken (es wird nur mehr, nie weniger). */
  private refreshSyncedDeps(pageID: string) {
    const keys = this.openPages.get(pageID);
    const deps = this.syncedDeps.get(pageID);
    if (!keys || !deps) return;
    const store = this.store;
    // Auch Kopien in schon mitgeführten Originalen zählen (verschachtelt).
    const next = syncedDependencies(store, pageID, (id) => subtree(store, id));
    const newRoots = [...next.roots].filter((r) => !deps.roots.has(r));
    const newAncestors = [...next.ancestors].filter((a) => !deps.ancestors.has(a));
    const newDatabases = [...this.linkedOf(pageID, next.roots)].filter((d) => !deps.databases.has(d));
    if (newRoots.length === 0 && newAncestors.length === 0 && newDatabases.length === 0) return;
    for (const r of newRoots) deps.roots.add(r);
    for (const a of newAncestors) deps.ancestors.add(a);
    for (const d of newDatabases) deps.databases.add(d);
    const records = [...this.syncedRecords(newRoots, newAncestors), ...this.databaseRecords(newDatabases)];
    for (const r of records) keys.add(recordKey(r));
    if (records.length) this.opts.post({ type: "pageChanges", pageID, upserts: records, deletions: [] });
  }

  /** BSD-212: Datenbanken, die die Seite (samt Synced-Originalen) nur verknüpft zeigt. */
  private linkedOf(pageID: string, roots: Iterable<string>): Set<string> {
    const store = this.store;
    const ids = [pageID, ...subtree(store, pageID)];
    for (const r of roots) ids.push(r, ...subtree(store, r));
    return dbops.linkedDatabases(store, ids);
  }

  /** Datenbank-Records samt Zeilen (mit Inhalt) für verknüpfte Ansichten. */
  private databaseRecords(databaseIDs: Iterable<string>): WireRecord[] {
    const store = this.store;
    const out: WireRecord[] = [];
    for (const d of databaseIDs) {
      const db = store.databases.get(d);
      if (!db) continue;
      out.push({ kind: "database", data: db });
      const ids: string[] = [];
      for (const row of store.children("d:" + d)) ids.push(row, ...subtree(store, row));
      out.push(...this.recordsFor(ids));
    }
    return out;
  }

  /** „Linked view of database“ auf einer offenen Seite: die Datenbank vorab in die Replik holen. */
  includeDatabase(pageID: string, databaseID: string): SyncedRecords {
    const keys = this.openPages.get(pageID);
    const deps = this.syncedDeps.get(pageID);
    if (!keys || !deps || !this.store.databases.has(databaseID)) return { found: false, records: [] };
    if (deps.databases.has(databaseID)) return { found: true, records: [] };
    deps.databases.add(databaseID);
    const records = this.databaseRecords([databaseID]);
    for (const r of records) keys.add(recordKey(r));
    return { found: true, records };
  }

  /** Alle Datenbanken (ohne Papierkorb) für die Auswahl „Linked view of database“, nach Titel gefiltert. */
  listDatabases(query: string, limit = 20): DatabaseInfo[] {
    const store = this.store;
    const q = query.trim().toLowerCase();
    const out: DatabaseInfo[] = [];
    for (const db of store.databases.values()) {
      const owner = store.blocks.get(db.blockID);
      if (!owner || isTrashed(store, db.blockID)) continue;
      const title = plainText(db.title) || "Untitled";
      if (q && !title.toLowerCase().includes(q)) continue;
      const info: DatabaseInfo = { id: db.id, title, inline: owner.type === "databaseInline" };
      const path = pageAncestors(store, db.blockID).map((id) => titleOf(store, id)).join(" / ");
      if (path) info.path = path;
      out.push(info);
    }
    out.sort((a, b) => a.title.localeCompare(b.title));
    return out.slice(0, limit);
  }

  /** „Paste synced block“ auf einer Seite, die das Original noch nicht kennt: Original in die Replik aufnehmen. */
  includeSynced(pageID: string, source: string): SyncedRecords {
    const store = this.store;
    const original = syncedOriginal(store, source);
    const keys = this.openPages.get(pageID);
    const deps = this.syncedDeps.get(pageID);
    if (!original || !store.blocks.has(original) || !keys || !deps) return { found: false, records: [] };
    if (original === pageID || isDescendant(store, original, pageID)) return { found: true, records: [] };
    const ancestors: string[] = [];
    for (let cur = store.blocks.get(original), n = 0; cur && n < 1000; n++) {
      const p = cur.parent;
      const next = p.startsWith("b:") ? p.slice(2) : p.startsWith("d:") ? store.databases.get(p.slice(2))?.blockID : undefined;
      if (!next || next === pageID) break;
      ancestors.push(next);
      cur = store.blocks.get(next);
    }
    deps.roots.add(original);
    for (const a of ancestors) deps.ancestors.add(a);
    const records = this.syncedRecords([original], ancestors);
    // Die Kopie, die `source` war, liegt ggf. selbst auf einer fremden Seite: ihr Record gehört dazu.
    const src = store.blocks.get(source);
    if (src && source !== original) records.push({ kind: "block", data: src });
    for (const r of records) keys.add(recordKey(r));
    return { found: true, records };
  }

  private notePageChange(pageID: string, key: RecordKeyString) {
    const keys = this.openPages.get(pageID)!;
    let d = this.pageDelta.get(pageID);
    if (!d) this.pageDelta.set(pageID, (d = { upserts: new Map(), deletions: new Set() }));
    const r = this.store.record(key);
    if (r) {
      keys.add(key);
      d.upserts.set(key, r);
      d.deletions.delete(key);
    } else {
      keys.delete(key);
      d.upserts.delete(key);
      d.deletions.add(key);
    }
  }

  /** Records einer Seite für die Replik im Hauptthread; danach kommen Änderungen als `pageChanges`. */
  openPage(pageID: string) {
    const store = this.store;
    const records: WireRecord[] = [{ kind: "workspace", data: store.workspace }];
    const keys = new Set<RecordKeyString>();
    const page = store.blocks.get(pageID);
    const deps = { roots: new Set<string>(), ancestors: new Set<string>(), databases: new Set<string>() };
    if (page) {
      records.push(...this.recordsFor([pageID, ...subtree(store, pageID)]));
      // Synced-Kopien zeigen den Inhalt eines Originals, das auf einer anderen Seite liegen kann.
      const d = syncedDependencies(store, pageID, (id) => subtree(store, id));
      deps.roots = d.roots;
      deps.ancestors = d.ancestors;
      records.push(...this.syncedRecords(d.roots, d.ancestors));
      deps.databases = this.linkedOf(pageID, d.roots);
      records.push(...this.databaseRecords(deps.databases));
      for (const r of records) if (r.kind !== "workspace") keys.add(recordKey(r));
    }
    this.openPages.set(pageID, keys);
    this.syncedDeps.set(pageID, deps);
    this.history?.pageOpened(pageID);
    return { pageID, node: store.clock.node, records };
  }

  // MARK: Seiten-Angaben, Seitensuche und Backlinks (Erwähnungen im Editor)

  private pageInfo(id: string): PageInfo | null {
    const store = this.store;
    const b = store.blocks.get(id);
    if (!b || !isPageLike(b)) return null;
    const info: PageInfo = {
      id, title: titleOf(store, id), trashed: isTrashed(store, id),
      kind: b.type === "databasePage" ? "database" : b.parent.startsWith("d:") ? "row" : "page",
    };
    const icon = iconText(b);
    if (icon) info.icon = icon;
    return info;
  }

  pageInfos(ids: readonly string[]): Record<string, PageInfo | null> {
    const out: Record<string, PageInfo | null> = {};
    for (const id of ids) out[id] = this.pageInfo(id);
    return out;
  }

  /** Seitensuche nur über Titel (das @-Menü sucht Seiten, nicht Inhalte). */
  findPages(query: string, limit = 8): PageInfo[] {
    const store = this.store;
    if (!query.trim()) return [];
    const found = this.searchIndex().run(query, { limit, filters: { titleOnly: true } }) ?? [];
    const out: PageInfo[] = [];
    for (const h of found) {
      const info = this.pageInfo(h.pageID);
      if (!info || info.trashed) continue;
      const path = pageAncestors(store, h.pageID).map((id) => titleOf(store, id)).join(" / ");
      if (path) info.path = path;
      out.push(info);
    }
    return out;
  }

  backlinks(pageID: string): PageInfo[] {
    const store = this.store;
    if (!this.links) {
      this.links = LinkIndex.fromStore(store);
      this.linksDirty.clear();
    } else if (this.linksDirty.size) {
      this.links.apply(store, this.linksDirty);
      this.linksDirty.clear();
    }
    return this.links.backlinks(store, pageID).map((id) => this.pageInfo(id)).filter((p): p is PageInfo => p !== null);
  }

  /** Änderungen aus einer Replik: als lokale Transaktion speichern (neu gestempelt, wird gepusht). */
  /** `derived` (BSD-220): Text aus einem /collab-Y.Doc – speichern, aber nicht pushen (der Server materialisiert ihn). */
  applyLocal(upserts: WireRecord[], deletions: RecordKeyString[], derived = false) {
    const store = this.store;
    for (const r of upserts) if (r.data.stamp) store.clock.observe(r.data.stamp as never);
    store.transact("Edit", (tx) => {
      for (const r of upserts) tx.put(r);
      for (const k of deletions) tx.remove(k);
    }, derived ? { undoable: false, keepStamps: true, derived: true } : { undoable: false, keepStamps: true });
    if (store.isReadOnly) throw new Error("read-only: " + (store.writeFailure?.message ?? ""));
  }

  // MARK: Quick Find

  /** Index auf dem Stand des Stores: beim ersten Mal gebaut, danach nur geänderte Blöcke/Datenbanken eingearbeitet. */
  searchIndex(): SearchIndex {
    const store = this.store;
    if (!this.index) {
      this.index = SearchIndex.fromSource(store);
      this.indexDirty.clear();
    } else if (this.indexDirty.size) {
      const upserts: WireRecord[] = [];
      const deletions: RecordKeyString[] = [];
      for (const key of this.indexDirty) {
        const r = store.record(key);
        if (r) upserts.push(r);
        else deletions.push(key);
      }
      this.indexDirty.clear();
      this.index.apply({ upserts, deletions });
    }
    return this.index;
  }

  /** Neuere Suchen brechen ältere ab, die noch nicht liefen (Tippen). */
  private queueSearch(id: number, query: string, limit: number, filters?: SearchFilters, sort?: SearchSort) {
    const prev = this.pendingSearch;
    if (prev) this.opts.post({ type: "reply", id: prev.id, ok: false, error: "cancelled", cancelled: true });
    this.pendingSearch = { id, query, limit, filters, sort };
    const run = () => {
      const p = this.pendingSearch;
      if (!p) return;
      this.pendingSearch = undefined;
      // Abbrechen, sobald eine neuere Suche ansteht (z. B. über `defer` eingereiht).
      const r = this.search(p.query, p.limit, () => this.pendingSearch !== undefined, p.filters, p.sort);
      if (r) this.opts.post({ type: "reply", id: p.id, ok: true, result: r });
      else this.opts.post({ type: "reply", id: p.id, ok: false, error: "cancelled", cancelled: true });
    };
    (this.opts.defer ?? ((fn) => setTimeout(fn, 0)))(run);
  }

  /** Quick Find über den Volltextindex (Titel, Inhalt mit Snippet, Zeilenwerte); `undefined` = abgebrochen. */
  search(query: string, limit = 30, isCancelled?: () => boolean, filters?: SearchFilters, sort?: SearchSort): SearchResult | undefined {
    const t0 = performance.now();
    const store = this.store;
    let found: ReturnType<SearchIndex["run"]> = [];
    if (query.trim()) {
      const opts: SearchOptions = { limit };
      if (isCancelled) opts.isCancelled = isCancelled;
      if (filters) opts.filters = filters;
      if (sort) opts.sort = sort;
      found = this.searchIndex().run(query, opts);
      if (!found) return undefined;
    }
    const hits = found.map((h) => {
      const b = store.blocks.get(h.pageID);
      const path = pageAncestors(store, h.pageID).map((id) => titleOf(store, id));
      if (b?.parent === "w" && b.props?.teamspace) {
        const t = store.workspace.teamspaces?.find((x) => x.id === b.props?.teamspace);
        if (t) path.unshift(t.name);
      }
      const hit: QuickFindHit = {
        pageID: h.pageID,
        title: titleOf(store, h.pageID),
        path: path.join(" / "),
        kind: b?.type === "databasePage" ? "database" : b?.parent.startsWith("d:") ? "row" : "page",
      };
      if (h.snippet) hit.snippet = h.snippet;
      return hit;
    });
    return { query, hits, took: performance.now() - t0 };
  }

  // MARK: Sync und Status

  startSync(cfg: SyncConfig | undefined) {
    this.sync?.stop();
    this.sync = undefined;
    const ws = this.ws;
    if (!ws) return;
    // BSD-220: ohne Echtzeit-Text gehen abgeleitete Text-Änderungen (nur über /collab gemeldet) doch per Push raus.
    if (!cfg?.url || !cfg.collab) {
      try {
        ws.persistence.promoteDerived();
      } catch {
        // schreibgeschützt: der Status meldet es
      }
    }
    this.assets?.configure(cfg?.url ? { baseURL: cfg.url, token: cfg.token } : undefined);
    if (!cfg?.url) {
      this.syncState = ws.persistent ? "local" : "memory";
      this.syncDetail = ws.note;
      this.postStatus();
      return;
    }
    this.syncState = "syncing";
    this.syncDetail = undefined;
    const sync = new SyncClient(ws.store, ws.persistence, {
      baseURL: cfg.url,
      token: cfg.token,
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      onStatus: (s) => this.onSyncStatus(s),
      onClockSkew: () => this.postStatus(),
      // Dateien vor den Records, die sie nennen (soweit das Netz mitspielt).
      beforePush: async () => {
        await this.assets?.flush();
      },
    });
    this.sync = sync;
    sync.start(this.opts.syncTiming);
    this.postStatus();
  }

  // MARK: Dateien (BSD-78)

  /**
   * BSD-230: Import schreiben – Dateien zuerst in den synchronisierten Speicher (SHA-256), dann die Verweise der
   * Records auf den Hash umschreiben. Was sich nicht ablegen lässt, fehlt und steht im Bericht.
   */
  /** BSD-254: Dateien laufender Importe, schon abgelegt (vorläufige ID → Hash). */
  private importedAssetIDs = new Map<string, string>();
  /** BSD-283: Hashes, die erst dieser Import auf das Gerät gebracht hat (nur die entfernt ein Abbruch). */
  private importCreatedHashes = new Set<string>();

  private async importAsset(id: string, bytes: Uint8Array, name: string, mime?: string): Promise<boolean> {
    if (!this.assets) throw new Error("not initialised");
    const { ref, created } = await this.assets.addTracked(bytes, name, mime);
    this.importedAssetIDs.set(id, ref.id);
    if (created) this.importCreatedHashes.add(ref.id);
    return true;
  }

  /**
   * BSD-283: Import abgebrochen oder gescheitert – die schon abgelegten Dateien wieder entfernen, soweit sie erst dieser
   * Import gebracht hat und kein Record auf sie zeigt. Gibt die Zahl der entfernten Dateien zurück.
   */
  private async discardImport(): Promise<number> {
    const created = this.importCreatedHashes;
    this.importCreatedHashes = new Set();
    this.importedAssetIDs.clear();
    if (!this.assets || created.size === 0) return 0;
    const used = assetIDsInStore(this.store);
    let removed = 0;
    for (const hash of created) {
      if (used.has(hash)) continue;
      await this.assets.discard(hash);
      removed += 1;
    }
    return removed;
  }

  private async commitImport(payload: ImportPayload, parent?: string): Promise<ImportSummary> {
    const map = new Map<string, string>(this.importedAssetIDs);
    this.importedAssetIDs.clear();
    this.importCreatedHashes.clear();
    let failed = 0;
    for (const f of payload.files ?? []) {
      try {
        if (!this.assets) throw new Error("not initialised");
        const ref = await this.assets.add(f.data, f.name, f.mime);
        map.set(f.id, ref.id);
      } catch {
        failed += 1;
      }
    }
    const rest: ImportPayload = { ...payload, notion: remapAssetRefs(payload.notion, map), archives: payload.archives.map((a) => ({ ...a, read: remapAssetRefs(a.read, map) })) };
    delete rest.files;
    const summary = commitImportPayload(this.store, rest, parent);
    if (failed > 0) summary.warnings.push(`${failed} attached file${failed === 1 ? "" : "s"} couldn't be saved (storage full or blocked) and will show as missing.`);
    return summary;
  }

  /**
   * BSD-230: Dateien früherer Importe lagen nur in IndexedDB dieses Geräts. Einmalig in den synchronisierten Speicher
   * übernehmen (hashen, hochladen), Verweise umschreiben, dann aus IndexedDB löschen. Läuft nach dem Start im Leerlauf.
   */
  async migrateImportedAssets(): Promise<number> {
    const imported = this.opts.importedAssets;
    if (!imported || !this.assets || !this.ws || this.store.isReadOnly) return 0;
    const map = new Map<string, string>();
    for (const id of assetIDsInStore(this.store)) {
      if (/^[0-9a-f]{64}$/.test(id)) continue;
      const a = await imported.get(id).catch(() => undefined);
      if (!a) continue;
      const ref = await this.assets.add(a.data, a.name, a.mime);
      map.set(id, ref.id);
    }
    if (map.size === 0) return 0;
    remapStoreAssets(this.store, map);
    for (const id of map.keys()) await imported.delete?.(id).catch(() => undefined);
    return map.size;
  }

  async assetPut(bytes: ArrayBuffer, name: string, mime?: string): Promise<AssetInfo> {
    if (!this.assets) throw new Error("not initialised");
    if (this.store.isReadOnly) throw new Error("read-only: " + (this.store.writeFailure?.message ?? ""));
    return this.assets.add(new Uint8Array(bytes), name, mime);
  }

  /** Dateien für Exporte: zuerst aus Importen, dann lokal aus dem Blob-Speicher des Syncs (ohne Netz). */
  private exportAssets(): AssetStore {
    const imported = this.opts.importedAssets;
    // BSD-230: der Blob-Speicher des Syncs (auch ohne OPFS, dann im Speicher).
    const blobs = this.assets?.blobs ?? this.ws?.assets;
    return {
      put: (id, asset) => (imported ? imported.put(id, asset) : Promise.reject(new Error("no asset store"))),
      has: async (id) => ((await imported?.has(id).catch(() => false)) ?? false) || ((await blobs?.has(id).catch(() => false)) ?? false),
      get: async (id): Promise<StoredAsset | undefined> => {
        const a = await imported?.get(id).catch(() => undefined);
        if (a) return a;
        const bytes = await blobs?.get(id).catch(() => undefined);
        return bytes ? { data: bytes, name: id } : undefined;
      },
    };
  }

  async assetGet(id: string): Promise<AssetGetResult> {
    if (!this.assets) throw new Error("not initialised");
    // Aus einem Import (nur auf diesem Gerät, BSD-78 überträgt sie noch nicht).
    const imported = await this.opts.importedAssets?.get(id).catch(() => undefined);
    if (imported) return { ok: true, bytes: imported.data.slice().buffer };
    try {
      const bytes = await this.assets.get(id);
      // Kopie: der Blob-Speicher behält seine Bytes (im Speicher-Fall dieselbe Instanz).
      return { ok: true, bytes: bytes.slice().buffer };
    } catch (e) {
      if (e instanceof AssetError) return { ok: false, code: e.code, message: e.message };
      throw e;
    }
  }

  stop() {
    this.assets?.stop();
    this.sync?.stop();
    if (this.historyTimer) clearInterval(this.historyTimer);
  }

  private onSyncStatus(s: string) {
    const online = this.opts.online?.() ?? true;
    if (s.startsWith("Synced")) {
      this.syncState = "synced";
      this.syncDetail = s;
    } else if (s.startsWith("Sync paused")) {
      this.syncState = "readonly";
      this.syncDetail = s;
    } else {
      const err = s.replace(/^Sync error:\s*/, "");
      const network = !online || /fetch|network|load failed|connection|ECONNREFUSED|abort/i.test(err);
      this.syncState = network ? "offline" : "error";
      this.syncDetail = err;
    }
    this.postStatus();
  }

  status(): StatusInfo {
    const store = this.ws?.store;
    let state = this.syncState;
    let detail = this.syncDetail;
    const syncState = state;
    if (store?.isReadOnly) {
      state = "readonly";
      detail = store.writeFailure?.message;
    } else if (this.ws && !this.ws.persistent && (state === "error" || state === "offline")) {
      // Sync-Fehler/Offline haben Vorrang im Text; „nur im Speicher“ steht im Detail (Tooltip) dahinter.
      detail = [detail, this.ws.note ?? "In memory only"].filter(Boolean).join(" · ");
    } else if (this.ws && !this.ws.persistent && state !== "starting") {
      // BSD-287 (Swift BSD-15): nur im Speicher bleibt sichtbar, auch wenn der Sync läuft – sonst stünde „Synced“
      // da, und Änderungen ohne Netz gingen beim Schließen still verloren. Der Sync-Zustand steht im Detail.
      const sync = state === "memory" ? undefined : state;
      state = "memory";
      detail = [this.ws.note ?? "In memory only", sync ? `sync: ${sync}${detail ? ` (${detail})` : ""}` : undefined].filter(Boolean).join(" · ");
    }
    const s: StatusInfo = { state, persistent: this.ws?.persistent ?? false, canUndo: store?.canUndo ?? false, canRedo: store?.canRedo ?? false };
    if (detail) s.detail = detail;
    if (state !== syncState) s.sync = syncState;
    if (this.sync?.clockSkew !== undefined) s.clockSkew = Math.round(this.sync.clockSkew / 1000);
    const a = this.assets?.status();
    if (a && (a.pending > 0 || a.downloading > 0 || a.failed > 0)) {
      s.assets = { uploads: a.pending, downloads: a.downloading, failed: a.failed };
      if (a.pending > 0 && a.lastError) s.assets.paused = a.lastError;
    }
    return s;
  }

  private postStatus() {
    const s = this.status();
    const key = JSON.stringify(s);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.opts.post({ type: "status", status: s });
  }
}
