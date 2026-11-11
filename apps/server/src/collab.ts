// Echtzeit-Text (BSD-158, BSD-220): Hocuspocus (Yjs) unter `GET /collab` (WebSocket). Ein Y.Doc je Seite,
// Dokumentname `page:<id>`, XML-Fragment „blocks“ wie packages/editor (DocSession/FRAGMENT). Der Server leitet
// Yjs-Updates zwischen Geräten weiter und speichert den Zustand in SQLite (eigene Datei neben dem Workspace, das
// Workspace-Format bleibt unverändert).
// BSD-220: Der Server ist die Brücke Y.Doc ↔ Records. Je geladenem Dokument läuft eine DocSession (kopfloser
// Konverter aus @based/editor/headless): Beim ersten Laden füllt sie das Y.Doc aus den Records (nur der Server
// füllt – zwei Geräte, die jeweils selbst füllten, hätten doppelten Inhalt), markiert es mit `based.origin =
// "server"` und schreibt Y-Änderungen der Geräte als eine Store-Transaktion (Records → Sync v2 → Swift-Client).
// Record-Änderungen von außen (Sync-Push, MCP) übernimmt sie per Diff ins Y.Doc; die Geräte bekommen sie über Yjs.
// Damit kein Y-Zustand verloren geht, den Geräte schon kennen, speichert der Server nach jedem Diff sofort.
// Auth: Bearer-Token im Hocuspocus-Auth-Nachricht (Provider-Option `token`), nie in der URL.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { Hocuspocus } from "@hocuspocus/server";
import { isPageLike, type WorkspaceStore } from "@based/core";
import { createConverter, DocSession, STORE_ORIGIN, type BlockConverter } from "@based/editor/headless";
import type { SqlDatabase } from "@based/sync";
import { WebSocketServer, type WebSocket } from "ws";
import * as Y from "yjs";
import type { Logger } from "./log.js";
import { tokenEquals } from "./router.js";

export const COLLAB_PATH = "/collab";
export const DOC_PREFIX = "page:";
/** Größte WebSocket-Nachricht (ein Yjs-Update). */
export const MAX_MESSAGE = 16 << 20;
/** Y.Map mit Metadaten im Dokument; `origin: "server"` = vom Server aus den Records gefüllt (Abstammung). */
export const META_MAP = "based";
export const META_ORIGIN = "origin";

let converter: BlockConverter | undefined;
/** Ein Konverter je Prozess (erzeugt ein unsichtbares BlockNote-Schema, ~50 ms). */
export function sharedConverter(): BlockConverter {
  return (converter ??= createConverter());
}

/** Y-Zustände je Dokument (`yjs_documents(name, state, updated)`). */
export class YStateStore {
  constructor(readonly db: SqlDatabase) {
    db.exec("CREATE TABLE IF NOT EXISTS yjs_documents (name TEXT PRIMARY KEY, state BLOB NOT NULL, updated REAL NOT NULL)");
  }
  load(name: string): Uint8Array | undefined {
    const v = this.db.all("SELECT state FROM yjs_documents WHERE name = ?", [name])[0]?.state;
    return v instanceof Uint8Array ? v : undefined;
  }
  save(name: string, state: Uint8Array) {
    this.db.run("INSERT OR REPLACE INTO yjs_documents(name, state, updated) VALUES(?, ?, ?)", [name, state, Date.now() / 1000]);
  }
}

export interface CollabOptions {
  store: WorkspaceStore;
  states: YStateStore;
  token: string;
  log: Logger;
  /** Speichern nach so vielen ms Ruhe (Standard 2 s), spätestens nach maxDebounce (10 s). */
  debounce?: number;
  /** Sammelzeit, bevor Y-Änderungen der Geräte als Records geschrieben werden (Standard 120 ms). */
  materializeDelay?: number;
  /** Konverter BlockNote ⇄ Y-XML (Standard: `sharedConverter()`). */
  converter?: BlockConverter;
}

export class Collab {
  readonly hocuspocus: Hocuspocus;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });

  /** Geladene Dokumente mit ihrer Brücke zum Store. */
  readonly sessions = new Map<string, DocSession>();

  constructor(readonly opts: CollabOptions) {
    const { store, states, token, log } = opts;
    const sessions = this.sessions;
    this.hocuspocus = new Hocuspocus({
      name: "based-collab",
      quiet: true,
      debounce: opts.debounce ?? 2000,
      maxDebounce: 10_000,
      async onAuthenticate({ token: given, documentName }) {
        if (!tokenEquals(given, token)) throw new Error("unauthorized");
        const id = documentName.startsWith(DOC_PREFIX) ? documentName.slice(DOC_PREFIX.length) : "";
        const root = store.blocks.get(id);
        // Seiten und (BSD-252) Synced-Block-Originale sind eigene Dokument-Wurzeln; Kopien zeigen nur aufs Original.
        const syncedOriginal = root?.type === "syncedBlock" && !root.props?.syncSource;
        if (!isPageLike(root) && !syncedOriginal) throw new Error("no such page");
        return { page: id };
      },
      async onLoadDocument({ document, documentName }) {
        const state = states.load(documentName);
        if (state) Y.applyUpdate(document, state);
        const save = () => states.save(documentName, Y.encodeStateAsUpdate(document));
        // Diffs aus dem Store sofort sichern (vor dem Verteilen an die Geräte): ginge so ein Zustand verloren,
        // erzeugte der nächste Diff denselben Text mit neuen Items, und Geräte hätten ihn doppelt.
        document.on("update", (_u: Uint8Array, origin: unknown) => {
          if (origin === STORE_ORIGIN) save();
        });
        const session = new DocSession(store, documentName.slice(DOC_PREFIX.length), {
          converter: opts.converter ?? sharedConverter(),
          doc: document,
          debounceMs: opts.materializeDelay ?? 120,
          // Y-Zustand vor dem Materialisieren sichern (sonst nach einem Absturz: Records neuer als der Y-Zustand).
          docStore: { load: () => undefined, save: () => save() },
          saveDelayMs: 0,
          // Ein Update, das nicht zum Schema passt, darf den Server nicht beenden; die Records bleiben dann stehen.
          onError: (e) => log.warning("collab materialize failed", { error: e instanceof Error ? e.name : "unknown" }),
        });
        if (!state) document.transact(() => document.getMap(META_MAP).set(META_ORIGIN, "server"), STORE_ORIGIN);
        save();
        sessions.set(documentName, session);
        return document;
      },
      async onStoreDocument({ document, documentName }) {
        states.save(documentName, Y.encodeStateAsUpdate(document));
        log.debug("collab stored", { doc: documentName.length });
      },
      async beforeUnloadDocument({ documentName }) {
        // Ausstehende Änderungen als Records schreiben, Zustand sichern.
        const session = sessions.get(documentName);
        session?.flush();
        session?.save();
      },
      async afterUnloadDocument({ documentName }) {
        const session = sessions.get(documentName);
        sessions.delete(documentName);
        session?.close();
      },
    });
  }

  /** WebSocket-Upgrades auf /collab annehmen; alles andere schließen. */
  attach(server: Server) {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path !== COLLAB_PATH) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws, req));
    });
  }

  private connect(ws: WebSocket, req: IncomingMessage) {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const request = new Request(`http://localhost${req.url ?? "/"}`, { headers });
    const conn = this.hocuspocus.handleConnection(ws, request);
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) conn.handleMessage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    });
    ws.on("close", (code: number, reason: Buffer) => conn.handleClose({ code, reason: reason.toString() }));
    ws.on("pong", () => conn.touch());
  }

  /** Offene Dokumente speichern, Verbindungen schließen. */
  async close() {
    // Brücken zuerst schließen (schreibt Ausstehendes als Records, sichert den Y-Zustand): die Entlade-Hooks laufen
    // danach asynchron weiter und dürfen die Datenbank nicht mehr brauchen.
    for (const s of this.sessions.values()) {
      try {
        s.close();
      } catch (e) {
        this.opts.log.warning("collab close failed", { error: e instanceof Error ? e.name : "unknown" });
      }
    }
    this.sessions.clear();
    this.hocuspocus.flushPendingStores();
    this.hocuspocus.closeConnections();
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
    // Gespeicherte Zustände sind synchron geschrieben; kurz warten, bis Hocuspocus seine Hooks beendet hat.
    await new Promise((r) => setTimeout(r, 10));
  }
}
