// BSD-220 Teil 3: Geräte-Seite von `/collab` (Echtzeit-Text). Entscheidet je Dokument-Wurzel, ob der Editor auf einem
// mit dem Server abgeglichenen Y.Doc arbeitet, und hält die Verbindung (eine je Wurzel, geteilt wie die Sitzung).
//
// Abstammung (docs/server.md, „Nur der Server füllt“): Ein Y.Doc darf nur dann mit dem Server abgeglichen werden,
// wenn es vom Server abstammt (`based.origin = "server"`). Ein lokal aus Records gefüllter Stand hätte andere
// Yjs-Items für denselben Text – beim Zusammenführen stünde alles doppelt da. Deshalb:
// - gespeicherter Stand vom Server → sofort damit öffnen und verbinden (geht auch offline weiter);
// - sonst leer verbinden und auf den ersten Abgleich warten; klappt der nicht rechtzeitig (offline, kein Zugriff),
//   arbeitet der Editor wie ohne /collab (Records + Sync v2) und versucht es beim nächsten Öffnen wieder.
// Die Verbindung selbst (Hocuspocus-Provider, Token) baut die Hülle (`connect`); hier liegt nur die Regel.
import * as Y from "yjs";
import { LOAD_ORIGIN, type YDocStore } from "./session.js";

/** Y.Map mit Metadaten im Dokument (wie apps/server/src/collab.ts). */
export const COLLAB_META_MAP = "based";
export const COLLAB_META_ORIGIN = "origin";
/** Dokumentname auf dem Server. */
export const collabDocName = (rootID: string) => `page:${rootID}`;

/** Eine offene Verbindung eines Y.Doc mit dem Server. */
export interface CollabConnection {
  /** Erfüllt nach dem ersten vollständigen Abgleich. */
  synced: Promise<void>;
  destroy(): void;
}

export interface CollabHandle {
  readonly doc: Y.Doc;
  release(): void;
}

/** Was der Editor braucht: ein abgeglichenes Y.Doc für eine Wurzel – oder `undefined` (ohne /collab arbeiten). */
export interface CollabSource {
  open(rootID: string): Promise<CollabHandle | undefined>;
}

export interface CollabBinderOptions {
  /** Verbindung aufbauen; `undefined` = gerade kein Echtzeit-Text (aus, kein Server). */
  connect: (name: string, doc: Y.Doc) => CollabConnection | undefined;
  /** Gespeicherte Y-Zustände (dieselbe Ablage wie der Editor). */
  docStore: YDocStore;
  /** Nur diese Wurzeln (der Server kennt nur Seiten). Standard: alle. */
  accepts?: (rootID: string) => boolean;
  /** So lange auf den ersten Abgleich warten, wenn es keinen Stand vom Server gibt (Standard 4000 ms). */
  syncTimeoutMs?: number;
  /** Offline und kein Stand vom Server: gar nicht erst verbinden (sofort ohne /collab öffnen). */
  online?: () => boolean;
  /**
   * BSD-252: Hat diese Wurzel lokale Änderungen, die der Server über Sync v2 noch nicht hat? Dann (ohne Stand vom
   * Server) diesmal ohne /collab öffnen – das Y.Doc des Servers würde sie beim Ableiten der Records überschreiben.
   * Sobald der Push durch ist, verbindet das nächste Öffnen.
   */
  unsynced?: (rootID: string) => Promise<boolean>;
}

export function fromServer(doc: Y.Doc): boolean {
  return doc.getMap(COLLAB_META_MAP).get(COLLAB_META_ORIGIN) === "server";
}

export class CollabBinder implements CollabSource {
  private readonly open_ = new Map<string, { doc: Y.Doc; conn: CollabConnection; refs: number }>();
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: CollabBinderOptions) {}

  async open(rootID: string): Promise<CollabHandle | undefined> {
    // Gleichzeitiges Öffnen derselben Wurzel (zwei Editoren): eine Verbindung, nicht zwei.
    for (let p = this.pending.get(rootID); p; p = this.pending.get(rootID)) await p.catch(() => undefined);
    const run = this.openNow(rootID);
    this.pending.set(rootID, run);
    try {
      return await run;
    } finally {
      if (this.pending.get(rootID) === run) this.pending.delete(rootID);
    }
  }

  private async openNow(rootID: string): Promise<CollabHandle | undefined> {
    const have = this.open_.get(rootID);
    if (have) {
      have.refs++;
      return this.handle(rootID, have);
    }
    if (this.opts.accepts && !this.opts.accepts(rootID)) return undefined;
    const name = collabDocName(rootID);
    try {
      await this.opts.docStore.prepare?.(rootID);
    } catch {
      // kein gespeicherter Stand
    }
    const saved = this.opts.docStore.load(rootID);
    const doc = new Y.Doc();
    if (saved && saved.length) {
      try {
        const probe = new Y.Doc();
        Y.applyUpdate(probe, saved);
        if (fromServer(probe)) Y.applyUpdate(doc, saved, LOAD_ORIGIN);
        probe.destroy();
      } catch {
        // kaputt: wie kein Stand
      }
    }
    if (!fromServer(doc) && this.opts.online && !this.opts.online()) {
      doc.destroy();
      return undefined;
    }
    if (!fromServer(doc) && this.opts.unsynced) {
      let pending = true;
      try { pending = await this.opts.unsynced(rootID); } catch { pending = true; }
      if (pending) {
        doc.destroy();
        return undefined;
      }
    }
    const conn = this.opts.connect(name, doc);
    if (!conn) {
      doc.destroy();
      return undefined;
    }
    if (!fromServer(doc)) {
      const ok = await Promise.race([
        conn.synced.then(() => true, () => false),
        new Promise<boolean>((r) => setTimeout(() => r(false), this.opts.syncTimeoutMs ?? 4000)),
      ]);
      if (!ok || !fromServer(doc)) {
        conn.destroy();
        doc.destroy();
        return undefined;
      }
    }
    const entry = { doc, conn, refs: 1 };
    this.open_.set(rootID, entry);
    return this.handle(rootID, entry);
  }

  /** Offene Verbindungen (Tests, Diagnose). */
  get openRoots(): string[] {
    return [...this.open_.keys()];
  }

  private handle(rootID: string, entry: { doc: Y.Doc; conn: CollabConnection; refs: number }): CollabHandle {
    let released = false;
    return {
      doc: entry.doc,
      release: () => {
        if (released) return;
        released = true;
        if (--entry.refs > 0) return;
        if (this.open_.get(rootID) === entry) this.open_.delete(rootID);
        entry.conn.destroy();
      },
    };
  }
}
