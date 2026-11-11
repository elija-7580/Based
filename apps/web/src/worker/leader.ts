// Mehrere Browser-Tabs auf einem Workspace. Die SQLite-Datei liegt in der OPFS-SAH-Pool-VFS, und die erlaubt genau
// einen Zugriff: Nur ein Tab („Store-Tab“) startet den Store-Worker, alle anderen reden über einen BroadcastChannel
// mit ihm. Wer der Store-Tab ist, entscheidet ein Web Lock: Der Browser gibt es frei, sobald der Tab geschlossen oder
// neu geladen wird, und der nächste wartende Tab bekommt es und startet seinen eigenen Worker.
//
// Warum nicht ein SharedWorker? Der wäre der natürliche Ort für den Store, aber
//  – `createSyncAccessHandle` (OPFS, von der SAH-Pool-VFS gebraucht) gibt es nur in Dedicated Workern, nicht in
//    SharedWorkern; ein SharedWorker müsste also selbst wieder einen Dedicated Worker starten, und verschachtelte
//    Worker in SharedWorkern kann Chromium nicht;
//  – Chrome auf Android kennt gar keine SharedWorker.
// Web Locks und BroadcastChannel gibt es dagegen in Chromium und WebKit (Safari 15.4+) gleichermaßen.
//
// Ohne Datenverlust bei der Übernahme: Jeder Tab merkt sich seine unbeantworteten Anfragen und schickt sie dem neuen
// Store-Tab noch einmal. `applyLocal` (Editor-Änderungen) ist dabei idempotent – die Records tragen ihre Stempel, ein
// zweites Mal Anwenden ändert nichts. Befehle wie „Seite anlegen“ können im seltenen Fall „ausgeführt, aber die
// Antwort ging mit dem Tab unter“ doppelt laufen; das ist sichtbar und rückgängig zu machen, verliert aber nichts.
// Danach holt sich jede offene Seiten-Replik ihren Stand neu (StoreClient.resync).
import type { Outline } from "@based/core";
import type { Endpoint, Event, InitResult, Request, RequestMessage, StatusInfo, SyncConfig } from "./protocol.js";

/** Teil der Web Locks API, den wir brauchen (Tests: simuliert). */
export interface LockManagerLike {
  request(name: string, callback: (lock: unknown) => Promise<unknown>): Promise<unknown>;
}

/** Teil von BroadcastChannel, den wir brauchen (Tests: simuliert). */
export interface ChannelLike {
  postMessage(msg: unknown): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  removeEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  close(): void;
}

export interface StartedStore {
  endpoint: Endpoint<Event, RequestMessage>;
  terminate(): void;
}

export interface InitParams {
  device?: string;
  sync?: SyncConfig;
  opfs?: string;
}

export interface StoreLinkOptions {
  /** Fehlt (alter Browser), ist jeder Tab sein eigener Store-Tab (wie früher: der zweite läuft nur im Speicher). */
  locks?: LockManagerLike | undefined;
  channel?: (() => ChannelLike) | undefined;
  /** Den Store-Worker starten (nur im Store-Tab). */
  startStore: () => StartedStore;
  /** Startwerte für den Store; im Store-Tab bei jeder Übernahme frisch gelesen (Sync-Server kann sich geändert haben). */
  initParams: () => Promise<InitParams>;
  id?: string;
  lockName?: string;
}

export type LinkRole = "connecting" | "follower" | "leader";

/** Nachrichten auf dem BroadcastChannel. */
type Wire =
  | { k: "hello"; from: string }
  | { k: "bye"; from: string }
  | { k: "leader"; leader: string }
  | { k: "welcome"; to: string; leader: string }
  | { k: "req"; from: string; to: string; msg: RequestMessage }
  | { k: "evt"; leader: string; to?: string; ev: Event };

const LOCAL = "local";
const RELAY = "#relay";

/**
 * Im Store-Tab: verteilt Anfragen aller Tabs an den einen Worker (eigene IDs, damit sich die Zähler der Tabs nicht in
 * die Quere kommen) und Ereignisse an alle Tabs. Merkt sich Struktur, Titel und Status für Tabs, die später kommen.
 */
export class Relay {
  private outline: Outline | undefined;
  private titles = new Map<string, string>();
  private status: StatusInfo | undefined;
  private ids = new Map<number, { client: string; id: number }>();
  private pages = new Map<string, Set<string>>();
  private nextID = 1;
  private init: Promise<InitResult> | undefined;
  private initResolve: ((r: InitResult) => void) | undefined;
  private initReject: ((e: Error) => void) | undefined;
  private createdAnswered = false;

  constructor(
    private readonly worker: Endpoint<Event, RequestMessage>,
    /** An einen Tab (LOCAL = dieser) oder an alle (`undefined`). */
    private readonly deliver: (client: string | undefined, ev: Event) => void,
  ) {
    worker.addEventListener("message", this.onWorker);
  }

  start(params: InitParams): Promise<InitResult> {
    if (!this.init) {
      this.init = new Promise<InitResult>((resolve, reject) => {
        this.initResolve = resolve;
        this.initReject = reject;
      });
      const req: Request = { type: "init" };
      if (params.device) req.device = params.device;
      if (params.sync) req.sync = params.sync;
      if (params.opfs) req.opfs = params.opfs;
      this.forward(RELAY, { ...req, id: 0 } as RequestMessage);
    }
    return this.init;
  }

  dispose() {
    this.worker.removeEventListener("message", this.onWorker);
  }

  /** Was ein neu verbundener Tab braucht, bevor er loslegt. */
  private snapshot(client: string) {
    if (this.outline) this.deliver(client, { type: "outline", outline: this.outline });
    this.deliver(client, { type: "titles", titles: Object.fromEntries(this.titles), full: true });
    if (this.status) this.deliver(client, { type: "status", status: this.status });
  }

  async handle(client: string, msg: RequestMessage): Promise<void> {
    switch (msg.type) {
      case "init": {
        // Der Store ist schon offen (der Relay hat ihn gestartet): nur Stand und Ergebnis an diesen Tab.
        try {
          const r = await this.start({});
          if (client !== LOCAL) this.snapshot(client);
          const created = r.created && !this.createdAnswered;
          this.createdAnswered = true;
          this.deliver(client, { type: "reply", id: msg.id, ok: true, result: { ...r, created } });
        } catch (e) {
          this.deliver(client, { type: "reply", id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      case "openPage": {
        let set = this.pages.get(msg.pageID);
        if (!set) this.pages.set(msg.pageID, (set = new Set()));
        set.add(client);
        break;
      }
      case "closePage": {
        const set = this.pages.get(msg.pageID);
        set?.delete(client);
        if (set && set.size > 0) {
          // ein anderer Tab hat die Seite noch offen: der Host soll sie weiter verfolgen
          this.deliver(client, { type: "reply", id: msg.id, ok: true, result: true });
          return;
        }
        this.pages.delete(msg.pageID);
        break;
      }
    }
    this.forward(client, msg);
  }

  /** Ein Tab ist weg: seine offenen Seiten freigeben. */
  drop(client: string) {
    for (const [pageID, set] of this.pages) {
      if (!set.delete(client) || set.size > 0) continue;
      this.pages.delete(pageID);
      this.forward(RELAY, { type: "closePage", pageID, id: 0 });
    }
  }

  private forward(client: string, msg: RequestMessage) {
    const id = this.nextID++;
    this.ids.set(id, { client, id: msg.id });
    this.worker.postMessage({ ...msg, id });
  }

  private onWorker = (e: { data: Event }) => {
    const ev = e.data;
    if (ev.type === "reply") {
      const to = this.ids.get(ev.id);
      if (!to) return;
      this.ids.delete(ev.id);
      if (to.client === RELAY) {
        if (to.id === 0 && this.initResolve) {
          if (ev.ok) this.initResolve(ev.result as InitResult);
          else this.initReject?.(new Error(ev.error));
          this.initResolve = this.initReject = undefined;
        }
        return;
      }
      this.deliver(to.client, { ...ev, id: to.id });
      return;
    }
    if (ev.type === "outline") this.outline = ev.outline;
    else if (ev.type === "status") this.status = ev.status;
    else if (ev.type === "titles") {
      if (ev.full) this.titles.clear();
      for (const [id, t] of Object.entries(ev.titles)) {
        if (t) this.titles.set(id, t);
        else this.titles.delete(id);
      }
    }
    this.deliver(undefined, ev);
  };
}

/**
 * Verbindung des StoreClient zum Store – egal, ob dieser Tab der Store-Tab ist oder nicht. Für den Client sieht das
 * aus wie der Worker selbst (Endpoint); wechselt der Store-Tab, ruft er `onReconnect` (→ StoreClient.resync).
 */
export class StoreLink implements Endpoint<Event, RequestMessage> {
  readonly id: string;
  role: LinkRole = "connecting";
  /** Anderer Store-Tab als vorher (oder dieser hat übernommen): offene Seiten neu holen. */
  onReconnect: (() => void) | undefined;
  onRole: ((role: LinkRole) => void) | undefined;

  private listeners = new Set<(e: { data: Event }) => void>();
  private unacked = new Map<number, RequestMessage>();
  private leader: string | undefined;
  private bc: ChannelLike | undefined;
  private relay: Relay | undefined;
  private store: StartedStore | undefined;
  private relayReady = false;
  private closed = false;
  private release: (() => void) | undefined;

  constructor(private readonly opts: StoreLinkOptions) {
    this.id = opts.id ?? crypto.randomUUID();
    if (!opts.locks || !opts.channel) {
      void this.becomeLeader();
      return;
    }
    this.bc = opts.channel();
    this.bc.addEventListener("message", this.onWire);
    this.wire({ k: "hello", from: this.id });
    const held = new Promise<void>((resolve) => (this.release = resolve));
    void opts.locks.request(opts.lockName ?? "based-store", async () => {
      if (this.closed) return;
      await this.becomeLeader();
      await held; // bis der Tab geht (im Browser: nie – das Schließen gibt das Lock frei)
    });
  }

  // MARK: Endpoint (für StoreClient)

  postMessage(msg: RequestMessage): void {
    this.unacked.set(msg.id, msg);
    this.send(msg);
  }

  addEventListener(_type: "message", fn: (e: { data: Event }) => void): void {
    this.listeners.add(fn);
  }

  removeEventListener(_type: "message", fn: (e: { data: Event }) => void): void {
    this.listeners.delete(fn);
  }

  /**
   * Tab geht (pagehide): der Store-Tab soll seine offenen Seiten freigeben. Als Store-Tab nichts tun – der Browser
   * beendet den Worker und gibt das Lock frei, sobald er die Seite abbaut; früher abzubrechen könnte Nachrichten
   * verlieren, die der Worker noch abarbeitet.
   */
  leave() {
    if (this.role !== "leader") this.wire({ k: "bye", from: this.id });
  }

  /** Tests (Tab geschlossen): Lock und Worker freigeben. */
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.role !== "leader") this.wire({ k: "bye", from: this.id });
    this.relay?.dispose();
    this.store?.terminate();
    this.bc?.removeEventListener("message", this.onWire);
    this.bc?.close();
    this.release?.();
  }

  // MARK: intern

  private emit(ev: Event) {
    if (ev.type === "reply") this.unacked.delete(ev.id);
    // wie postMessage: nie synchron im Aufruf
    queueMicrotask(() => {
      for (const fn of this.listeners) fn({ data: ev });
    });
  }

  private wire(w: Wire) {
    if (!this.closed || w.k === "bye") this.bc?.postMessage(w);
  }

  private send(msg: RequestMessage) {
    if (this.closed) return;
    if (this.role === "leader") {
      if (this.relayReady) void this.relay!.handle(LOCAL, msg);
    } else if (this.leader) {
      this.wire({ k: "req", from: this.id, to: this.leader, msg });
    }
  }

  private setRole(role: LinkRole) {
    this.role = role;
    this.onRole?.(role);
  }

  /** Ein (neuer) Store-Tab ist da. */
  private connect(leader: string) {
    if (leader === this.leader || this.role === "leader") return;
    const had = this.leader !== undefined;
    this.leader = leader;
    this.setRole("follower");
    for (const msg of [...this.unacked.values()].sort((a, b) => a.id - b.id)) this.send(msg);
    if (had) this.onReconnect?.();
  }

  private async becomeLeader() {
    if (this.closed) return;
    const had = this.leader !== undefined;
    this.setRole("leader");
    this.store = this.opts.startStore();
    this.relay = new Relay(this.store.endpoint, (client, ev) => {
      if (client === LOCAL) this.emit(ev);
      else if (client === undefined) {
        this.emit(ev);
        this.wire({ k: "evt", leader: this.id, ev });
      } else this.wire({ k: "evt", leader: this.id, to: client, ev });
    });
    try {
      await this.relay.start(await this.opts.initParams());
    } catch {
      // Fehler bekommt der Client als Antwort auf sein `init`
    }
    if (this.closed) return;
    this.leader = this.id;
    this.relayReady = true;
    for (const msg of [...this.unacked.values()].sort((a, b) => a.id - b.id)) this.send(msg);
    if (had) this.onReconnect?.();
    this.wire({ k: "leader", leader: this.id });
  }

  private onWire = (e: { data: unknown }) => {
    const w = e.data as Wire;
    if (this.closed) return;
    if (this.role === "leader") {
      if (!this.relayReady) return; // Anfragen kommen nach der Ankündigung noch einmal
      if (w.k === "hello") this.wire({ k: "welcome", to: w.from, leader: this.id });
      else if (w.k === "req" && w.to === this.id) void this.relay!.handle(w.from, w.msg);
      else if (w.k === "bye") this.relay!.drop(w.from);
      return;
    }
    switch (w.k) {
      case "leader": this.connect(w.leader); return;
      case "welcome": if (w.to === this.id) this.connect(w.leader); return;
      case "evt":
        if (w.to !== undefined && w.to !== this.id) return;
        if (w.leader !== this.leader) {
          // Antworten eines alten Store-Tabs zählen noch (sonst ginge die Anfrage zweimal raus); den Rest liefert der neue
          if (w.ev.type !== "reply" || !this.unacked.has(w.ev.id)) return;
        }
        this.emit(w.ev);
        return;
    }
  };
}

/** Im Browser: Web Locks + BroadcastChannel, wenn vorhanden. */
export function browserLinkOptions(name = "based-store"): Pick<StoreLinkOptions, "locks" | "channel"> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks as LockManagerLike | undefined;
  // BSD-235: ein Gast-Tab hat eigenen Kanal und Lock (sonst redete er mit dem Store-Tab des Besitzers).
  const channel = typeof BroadcastChannel === "function" ? () => new BroadcastChannel(name) as unknown as ChannelLike : undefined;
  return { locks, channel };
}
