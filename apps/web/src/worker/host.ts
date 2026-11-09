// BSD-153: der Store-Host im Worker. Hält WorkspaceStore + SqlitePersistence (+ optional SyncClient), führt Befehle
// als Transaktionen aus und schickt der UI nur, was sie braucht: Seitenleisten-Struktur (nur bei Strukturänderungen),
// Titel (nur geänderte), Status und die Records offener Seiten. Ohne Worker-Globals, damit er in Node testbar ist
// (die Worker-Datei `store.worker.ts` verbindet ihn nur mit `self`).
import {
  buildOutline,
  createPage,
  deleteForever,
  dropPages,
  emptyTrash,
  insertPage,
  isDescendant,
  isPageLike,
  keysBetween,
  movePages,
  pageAncestors,
  parseKey,
  PRIVATE_SECTION,
  recordKey,
  renamePage,
  restorePages,
  SearchCorpus,
  setFavorite,
  subtree,
  structureSignature,
  titleOf,
  trashPages,
  type Block,
  type RecordKeyString,
  type StoreChange,
  type WireRecord,
  type WorkspaceStore,
} from "@based/core";
import { SyncClient, type DeviceNodeStore, type SqlitePersistence } from "@based/sync";
import type { Command, Event, InitResult, QuickFindHit, RequestMessage, SearchResult, StatusInfo, SyncConfig, SyncState } from "./protocol.js";

export interface OpenedWorkspace {
  store: WorkspaceStore;
  persistence: SqlitePersistence;
  /** Daten liegen dauerhaft (OPFS); sonst nur im Speicher. */
  persistent: boolean;
  /** Warum nicht dauerhaft (für den Status). */
  note?: string;
}

export interface HostOptions {
  open: (opts: { device: DeviceNodeStore; opfs?: string }) => Promise<OpenedWorkspace>;
  post: (e: Event) => void;
  fetch?: typeof fetch;
  online?: () => boolean;
  /** Sync-Takt (Tests: kurz). */
  syncTiming?: { intervalMs?: number; waitTimeoutSeconds?: number; pushDelayMs?: number };
  /** Aufschub für Quick Find, damit neuere Eingaben ältere abbrechen (Tests: synchron über 0). */
  defer?: (fn: () => void) => void;
}

const WELCOME = "Welcome to Based";

export class StoreHost {
  ws: OpenedWorkspace | undefined;
  private device: string | undefined;
  private sync: SyncClient | undefined;
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
  private corpus: { revision: number; corpus: SearchCorpus } | undefined;
  private pendingSearch: { id: number; query: string; limit: number } | undefined;
  private lastStatus = "";

  constructor(private readonly opts: HostOptions) {}

  private get store(): WorkspaceStore {
    if (!this.ws) throw new Error("not initialised");
    return this.ws.store;
  }

  /** Eine Anfrage der UI. Antworten gehen als `reply` mit derselben ID zurück. */
  async handle(msg: RequestMessage): Promise<void> {
    const reply = (result: unknown) => this.opts.post({ type: "reply", id: msg.id, ok: true, result });
    try {
      switch (msg.type) {
        case "init": reply(await this.init(msg.device, msg.sync, msg.opfs)); break;
        case "command": reply(this.command(msg.command)); break;
        case "search": this.queueSearch(msg.id, msg.query, msg.limit ?? 30); break;
        case "warmSearch": this.corpusNow(); reply(true); break;
        case "openPage": reply(this.openPage(msg.pageID)); break;
        case "closePage": this.openPages.delete(msg.pageID); this.pageDelta.delete(msg.pageID); reply(true); break;
        case "applyLocal": this.applyLocal(msg.upserts, msg.deletions); reply(true); break;
        case "setSync": this.startSync(msg.sync); reply(true); break;
        case "syncNow": await this.sync?.syncNow(); reply(true); break;
      }
    } catch (e) {
      this.opts.post({ type: "reply", id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    this.flush();
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
    store.onWriteFailureChanged = () => this.postStatus();
    this.rebuildTracking();
    this.opts.post({ type: "outline", outline: buildOutline(store) });
    this.opts.post({ type: "titles", titles: Object.fromEntries(this.titles), full: true });
    this.syncState = this.ws.persistent ? "local" : "memory";
    this.syncDetail = this.ws.note;
    this.startSync(sync);
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
      case "rename": return renamePage(store, c.id, c.title);
      case "trash": return trashPages(store, c.ids);
      case "restore": return restorePages(store, c.ids);
      case "deleteForever": return deleteForever(store, c.ids);
      case "emptyTrash": return emptyTrash(store);
      case "drop": return dropPages(store, c.ids, c.target, c.zone);
      case "moveToSection":
        return movePages(store, c.ids, { kind: "top", section: c.section === PRIVATE_SECTION ? { kind: "private" } : { kind: "teamspace", id: c.section } });
      case "favorite": return setFavorite(store, c.ids, c.on);
      case "undo": return store.undo().name;
      case "redo": return store.redo().name;
      case "seed": return this.seed(c.count, c.prefix ?? "Page");
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
      if (kind === "workspace") this.structureDirty = true;
      else if (kind === "block") this.trackBlock(id);
      else if (kind === "database") {
        const owner = store.databases.get(id)?.blockID;
        if (owner) this.trackTitle(owner);
        else for (const [pid] of this.titles) if (store.blocks.get(pid)?.props?.databaseID === id) this.trackTitle(pid);
      }
      for (const [pageID, keys] of this.openPages) if (keys.has(key) || this.belongsTo(key, pageID)) this.notePageChange(pageID, key);
    }
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
    for (const [pageID, d] of this.pageDelta) {
      if (d.upserts.size || d.deletions.size) this.opts.post({ type: "pageChanges", pageID, upserts: [...d.upserts.values()], deletions: [...d.deletions] });
    }
    this.pageDelta.clear();
    this.postStatus();
  }

  // MARK: Offene Seiten (Repliken im Hauptthread)

  private belongsTo(key: RecordKeyString, pageID: string): boolean {
    const store = this.store;
    const { kind, id } = parseKey(key);
    let blockID: string | undefined;
    if (kind === "block") blockID = id;
    else if (kind === "database") blockID = store.databases.get(id)?.blockID;
    else if (kind === "view") blockID = store.views.get(id)?.blockID;
    if (!blockID) return false;
    return blockID === pageID || isDescendant(store, blockID, pageID);
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
    if (page) {
      const ids = [pageID, ...subtree(store, pageID)];
      const blockSet = new Set(ids);
      for (const id of ids) {
        const b = store.blocks.get(id)!;
        records.push({ kind: "block", data: b });
        const db = b.props?.databaseID;
        if (db && store.databases.get(db)?.blockID === id) records.push({ kind: "database", data: store.databases.get(db)! });
      }
      for (const v of store.views.values()) if (blockSet.has(v.blockID)) records.push({ kind: "view", data: v });
      for (const r of records) if (r.kind !== "workspace") keys.add(recordKey(r));
    }
    this.openPages.set(pageID, keys);
    return { pageID, node: store.clock.node, records };
  }

  /** Änderungen aus einer Replik: als lokale Transaktion speichern (neu gestempelt, wird gepusht). */
  applyLocal(upserts: WireRecord[], deletions: RecordKeyString[]) {
    const store = this.store;
    for (const r of upserts) if (r.data.stamp) store.clock.observe(r.data.stamp as never);
    store.transact("Edit", (tx) => {
      for (const r of upserts) tx.put(r);
      for (const k of deletions) tx.remove(k);
    }, { undoable: false });
    if (store.isReadOnly) throw new Error("read-only: " + (store.writeFailure?.message ?? ""));
  }

  // MARK: Quick Find

  private corpusNow(): SearchCorpus {
    const store = this.store;
    if (!this.corpus || this.corpus.revision !== store.revision) this.corpus = { revision: store.revision, corpus: new SearchCorpus(store) };
    return this.corpus.corpus;
  }

  /** Neuere Suchen brechen ältere ab, die noch nicht liefen (Tippen). */
  private queueSearch(id: number, query: string, limit: number) {
    const prev = this.pendingSearch;
    if (prev) this.opts.post({ type: "reply", id: prev.id, ok: false, error: "cancelled", cancelled: true });
    this.pendingSearch = { id, query, limit };
    const run = () => {
      const p = this.pendingSearch;
      if (!p) return;
      this.pendingSearch = undefined;
      this.opts.post({ type: "reply", id: p.id, ok: true, result: this.search(p.query, p.limit) });
    };
    (this.opts.defer ?? ((fn) => setTimeout(fn, 0)))(run);
  }

  search(query: string, limit = 30): SearchResult {
    const t0 = performance.now();
    const store = this.store;
    const hits: QuickFindHit[] = query.trim() ? this.corpusNow().search(query, {}, "bestMatch", limit).map((h) => {
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
    }) : [];
    return { query, hits, took: performance.now() - t0 };
  }

  // MARK: Sync und Status

  startSync(cfg: SyncConfig | undefined) {
    this.sync?.stop();
    this.sync = undefined;
    const ws = this.ws;
    if (!ws) return;
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
    });
    this.sync = sync;
    sync.start(this.opts.syncTiming);
    this.postStatus();
  }

  stop() {
    this.sync?.stop();
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
    if (store?.isReadOnly) {
      state = "readonly";
      detail = store.writeFailure?.message;
    }
    const s: StatusInfo = { state, persistent: this.ws?.persistent ?? false, canUndo: store?.canUndo ?? false, canRedo: store?.canRedo ?? false };
    if (detail) s.detail = detail;
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
