// Echtzeit-Text (BSD-158, erster Schnitt): Hocuspocus (Yjs) unter `GET /collab` (WebSocket). Ein Y.Doc je Seite,
// Dokumentname `page:<id>`, XML-Fragment „blocks“ wie packages/editor (DocSession/FRAGMENT). Der Server leitet
// Yjs-Updates zwischen Geräten weiter und speichert den Zustand in SQLite (eigene Datei neben dem Workspace, das
// Workspace-Format bleibt unverändert). Die Brücke Y.Doc ↔ Records machen bisher die Clients (DocSession); der
// Server materialisiert noch nicht selbst (offener Punkt, docs/server.md).
// Auth: Bearer-Token im Hocuspocus-Auth-Nachricht (Provider-Option `token`), nie in der URL.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { Hocuspocus } from "@hocuspocus/server";
import { isPageLike, type WorkspaceStore } from "@based/core";
import type { SqlDatabase } from "@based/sync";
import { WebSocketServer, type WebSocket } from "ws";
import * as Y from "yjs";
import type { Logger } from "./log.js";
import { tokenEquals } from "./router.js";

export const COLLAB_PATH = "/collab";
export const DOC_PREFIX = "page:";
/** Größte WebSocket-Nachricht (ein Yjs-Update). */
export const MAX_MESSAGE = 16 << 20;

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
}

export class Collab {
  readonly hocuspocus: Hocuspocus;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });

  constructor(readonly opts: CollabOptions) {
    const { store, states, token, log } = opts;
    this.hocuspocus = new Hocuspocus({
      name: "based-collab",
      quiet: true,
      debounce: opts.debounce ?? 2000,
      maxDebounce: 10_000,
      async onAuthenticate({ token: given, documentName }) {
        if (!tokenEquals(given, token)) throw new Error("unauthorized");
        const id = documentName.startsWith(DOC_PREFIX) ? documentName.slice(DOC_PREFIX.length) : "";
        if (!isPageLike(store.blocks.get(id))) throw new Error("no such page");
        return { page: id };
      },
      async onLoadDocument({ document, documentName }) {
        const state = states.load(documentName);
        if (state) Y.applyUpdate(document, state);
        return document;
      },
      async onStoreDocument({ document, documentName }) {
        states.save(documentName, Y.encodeStateAsUpdate(document));
        log.debug("collab stored", { doc: documentName.length });
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
    this.hocuspocus.flushPendingStores();
    this.hocuspocus.closeConnections();
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
    // Gespeicherte Zustände sind synchron geschrieben; kurz warten, bis Hocuspocus seine Hooks beendet hat.
    await new Promise((r) => setTimeout(r, 10));
  }
}
