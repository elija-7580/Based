// Echtzeit-Text (BSD-158, BSD-220, ADR 0016 E7): Hocuspocus (Yjs) unter `GET /collab` (WebSocket). Ein Y.Doc je Seite,
// Dokumentname `text:<id>`, Y.Map „texts“ mit einem Y.Text je Textblock (TextSession aus @based/editor/headless).
// Der Server leitet Yjs-Updates zwischen Geräten weiter und speichert den Zustand in SQLite (eigene Datei neben dem
// Workspace, das Workspace-Format bleibt unverändert).
// BSD-220: Der Server ist die Brücke Y.Doc ↔ Records: Beim ersten Laden füllt er das Y.Doc aus den Records (nur der
// Server füllt – zwei Geräte, die jeweils selbst füllten, hätten doppelten Inhalt), markiert es mit `based.origin =
// "server"` und schreibt Y-Änderungen der Geräte als Records (Sync v2 → Swift-Client). Record-Änderungen von außen
// (Sync-Push, MCP) übernimmt er per Diff ins Y.Doc; die Geräte bekommen sie über Yjs.
// BSD-407 Teil 4c: Die alten Seiten-Dokumente `page:<id>` (BlockNote/y-prosemirror) nimmt der Server nicht mehr an –
// seit 15.11. gibt es keinen Client mehr dafür. Ihr Inhalt steht in den Records (die alte Brücke schrieb jede Änderung
// nach 120 ms und beim Entladen, und beim Laden gewannen ohnehin die Records); die gespeicherten Y-Zustände bleiben in
// der Datenbank unangetastet.
// Auth: Bearer-Token im Hocuspocus-Auth-Nachricht (Provider-Option `token`), nie in der URL.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { Hocuspocus } from "@hocuspocus/server";
import { isPageLike, type WorkspaceStore } from "@based/core";
import { TEXT_STORE_ORIGIN, TextSession } from "@based/editor/headless";
import type { SqlDatabase } from "@based/sync";
import { WebSocketServer, type WebSocket } from "ws";
import * as Y from "yjs";
import type { Logger } from "./log.js";
import { tokenEquals } from "./router.js";

export const COLLAB_PATH = "/collab";
/** Alte Seiten-Dokumente (BlockNote) – abgewiesen seit BSD-407 Teil 4c. */
export const DOC_PREFIX = "page:";
export const RETIRED_DOC_MESSAGE = "This page document format is no longer supported. Update Based.";
/** ADR 0016 (E7): Dokumente des neuen Block-Editors – ein Y.Text je Textblock (TextSession), Name `text:<seite>`. */
export const TEXT_DOC_PREFIX = "text:";
/** Größte WebSocket-Nachricht (ein Yjs-Update). */
export const MAX_MESSAGE = 16 << 20;
/** Y.Map mit Metadaten im Dokument; `origin: "server"` = vom Server aus den Records gefüllt (Abstammung). */
export const META_MAP = "based";
export const META_ORIGIN = "origin";

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
  /** BSD-315: weitere gültige Tokens (Geräte des Besitzers); ohne: nur `token`. */
  acceptToken?: (token: string) => boolean;
}

export class Collab {
  readonly hocuspocus: Hocuspocus;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });

  /** Geladene Dokumente mit ihrer Brücke zum Store. */
  readonly sessions = new Map<string, TextSession>();

  constructor(readonly opts: CollabOptions) {
    const { store, states, token, log } = opts;
    const sessions = this.sessions;
    this.hocuspocus = new Hocuspocus({
      name: "based-collab",
      quiet: true,
      debounce: opts.debounce ?? 2000,
      maxDebounce: 10_000,
      async onAuthenticate({ token: given, documentName }) {
        if (!(opts.acceptToken ? opts.acceptToken(given) : tokenEquals(given, token))) throw new Error("unauthorized");
        if (documentName.startsWith(DOC_PREFIX)) throw new Error(RETIRED_DOC_MESSAGE);
        const id = documentName.startsWith(TEXT_DOC_PREFIX) ? documentName.slice(TEXT_DOC_PREFIX.length) : "";
        if (!isPageLike(store.blocks.get(id))) throw new Error("no such page");
        return { page: id };
      },
      async onLoadDocument({ document, documentName }) {
        const state = states.load(documentName);
        if (state) Y.applyUpdate(document, state);
        const save = () => states.save(documentName, Y.encodeStateAsUpdate(document));
        // Nur `text:`-Dokumente kommen bis hierher (onAuthenticate).
        const pageID = documentName.slice(TEXT_DOC_PREFIX.length);
        document.on("update", (_u: Uint8Array, origin: unknown) => {
          if (origin === TEXT_STORE_ORIGIN) save();
        });
        const session = new TextSession(store, pageID, {
          doc: document,
          role: "server",
          debounceMs: opts.materializeDelay ?? 120,
          // Geräte, die an diesem Dokument hängen (Awareness `node`): ihr Text kommt über Yjs, nicht über Records.
          participants: () => participantNodes(document),
          onError: (e) => log.warning("collab text materialize failed", { error: e instanceof Error ? e.name : "unknown" }),
        });
        if (!state) document.transact(() => document.getMap(META_MAP).set(META_ORIGIN, "server"), TEXT_STORE_ORIGIN);
        save();
        sessions.set(documentName, session);
        return document;
      },
      async onStoreDocument({ document, documentName }) {
        states.save(documentName, Y.encodeStateAsUpdate(document));
        log.debug("collab stored", { doc: documentName.length });
      },
      async beforeUnloadDocument({ documentName, document }) {
        // Ausstehende Änderungen als Records schreiben, Zustand sichern.
        const session = sessions.get(documentName);
        session?.flush();
        if (session) states.save(documentName, Y.encodeStateAsUpdate(document));
      },
      async afterUnloadDocument({ documentName }) {
        const session = sessions.get(documentName);
        sessions.delete(documentName);
        session?.close();
      },
    });
  }

  /**
   * WebSocket-Upgrades auf /collab annehmen; `other` darf andere Pfade übernehmen (BSD-314: Terminal), alles
   * Übrige wird geschlossen.
   */
  attach(server: Server, other?: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean) {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path !== COLLAB_PATH && other?.(req, socket, head)) return;
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

/** Knoten der Geräte an einem Dokument (Awareness-Feld `node`, gesetzt vom Editor). */
function participantNodes(doc: Y.Doc): Set<string> {
  const out = new Set<string>();
  const aw = (doc as Y.Doc & { awareness?: { getStates(): Map<number, Record<string, unknown>> } }).awareness;
  for (const st of aw?.getStates().values() ?? []) if (typeof st.node === "string") out.add(st.node);
  return out;
}
