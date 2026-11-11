// BSD-73: wann Seiten eine Version bekommen (Port von App/Shared/History/PageHistory.swift); die Ablage ist
// VersionHistory aus @based/core (git-artig, dedupliziert), im Worker auf history.sqlite (OPFS) bzw. im Speicher.
//
// * beim Öffnen einer Seite (der Stand vor deinen Änderungen ist immer da),
// * beim Bearbeiten: höchstens alle 10 Minuten und sobald du eine Minute pausierst, beim Schließen der Seite,
// * vor und nach dem Wiederherstellen, und bevor die Liste gezeigt wird.
//
// Nur lokale Änderungen zählen (Editor, Befehle, Undo/Redo); Sync-Änderungen erzeugen keine Versionen.
import {
  isPageLike,
  parseKey,
  restoreVersion,
  subtree,
  titleOf,
  versionBlocks,
  type HistoryStats,
  type HistoryVersion,
  type StoreChange,
  type VersionHistory,
  type WorkspaceStore,
} from "@based/core";
import type { HistoryContent, HistoryList, HistoryRestoreResult } from "./protocol.js";

export interface PageHistoryOptions {
  /** Unix-Millisekunden (Tests: fest). */
  now?: () => number;
  idleMs?: number;
  maxMs?: number;
}

export class PageHistory {
  /** Seite → Zeit der letzten Änderung, die noch in keiner Version steht. */
  private dirty = new Map<string, number>();
  /** Seite → wann ihre letzte Version entstand (diese Sitzung). */
  private lastVersion = new Map<string, number>();
  /** Block → Seite (für gelöschte Blöcke, die keinen Elternverweis mehr haben). */
  private pageOf = new Map<string, string>();
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly maxMs: number;
  /** Letzter Fehler beim Speichern einer Version (wird in der Liste gezeigt, nie verschluckt). */
  lastError: string | undefined;

  constructor(readonly store: WorkspaceStore, readonly history: VersionHistory, opts: PageHistoryOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? 60_000;
    this.maxMs = opts.maxMs ?? 10 * 60_000;
  }

  // MARK: Auslöser

  /** Nach jeder Transaktion des Stores. */
  onChange(change: StoreChange) {
    if (change.origin === "remote" || change.origin === "load") return;
    const t = this.now();
    for (const key of change.keys) {
      const { kind, id } = parseKey(key);
      if (kind !== "block") continue;
      const page = this.store.blocks.has(id) ? this.containingPage(id) : this.pageOf.get(id);
      if (page) this.dirty.set(page, t);
    }
  }

  private containingPage(id: string): string | undefined {
    // Eine Seite gehört zu ihrer Elternseite (dort ist sie ein Block wie ein Link) und hat ihren eigenen Verlauf.
    const b = this.store.blocks.get(id);
    if (!b) return undefined;
    const parent = b.parent.startsWith("b:") ? b.parent.slice(2) : undefined;
    let page: string | undefined;
    if (isPageLike(b)) {
      this.dirty.set(id, this.now());
      page = parent ? this.containingPage(parent) : undefined;
    } else page = this.store.containingPage(id);
    if (page) this.pageOf.set(id, page);
    return page;
  }

  /** Eine Seite wurde geöffnet: ihr aktueller Stand wird eine Version (ohne Änderung keine). */
  pageOpened(pageID: string) {
    const b = this.store.blocks.get(pageID);
    if (!b || !(b.type === "page" || b.parent.startsWith("d:"))) return;
    this.snapshot(pageID, "opened");
  }

  /** Seite geschlossen: was noch fehlt, wird jetzt eine Version. */
  pageClosed(pageID: string) {
    if (this.dirty.has(pageID)) this.snapshot(pageID, "edit");
  }

  /**
   * Alle ~20 s: Seiten nach einer Minute Pause oder spätestens alle 10 Minuten. Höchstens `maxPerTick` Seiten auf
   * einmal (nach Massenänderungen wie einem Import blockiert der Worker sonst spürbar); der Rest folgt im nächsten Takt.
   */
  tick(maxPerTick = 25) {
    const t = this.now();
    let n = 0;
    for (const [page, edited] of [...this.dirty]) {
      if (n >= maxPerTick) break;
      const since = this.lastVersion.get(page) ?? 0;
      if (t - edited >= this.idleMs || t - since >= this.maxMs) {
        this.snapshot(page, "edit");
        n += 1;
      }
    }
  }

  /** Alles, was noch in keiner Version steht. */
  flush() {
    for (const page of [...this.dirty.keys()]) this.snapshot(page, "edit");
  }

  private snapshot(pageID: string, reason: string): HistoryVersion | null {
    this.dirty.delete(pageID);
    const blocks = versionBlocks(this.store, pageID);
    if (blocks.length === 0 || blocks[0]!.trashedAt !== undefined) return null;
    for (const b of blocks) this.pageOf.set(b.id, pageID);
    this.lastVersion.set(pageID, this.now());
    try {
      const v = this.history.record(pageID, structuredClone(blocks), titleOf(this.store, pageID), reason, this.now() / 1000);
      this.lastError = undefined;
      return v;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.dirty.set(pageID, this.now()); // später noch einmal versuchen
      return null;
    }
  }

  // MARK: Lesen und Wiederherstellen

  list(pageID: string): HistoryList {
    if (this.dirty.has(pageID)) this.snapshot(pageID, "edit");
    const out: HistoryList = { versions: this.history.versions(pageID), stats: this.stats() };
    if (this.lastError) out.error = this.lastError;
    return out;
  }

  private stats(): HistoryStats | undefined {
    try {
      return this.history.stats();
    } catch {
      return undefined;
    }
  }

  private find(pageID: string, versionID: number): HistoryVersion {
    const v = this.history.versions(pageID).find((x) => x.id === versionID);
    if (!v) throw new Error("This version no longer exists.");
    return v;
  }

  content(pageID: string, versionID: number): HistoryContent {
    return this.history.blocksOf(this.find(pageID, versionID));
  }

  /**
   * Stellt eine Version als ein Undo-Schritt wieder her. Vorher wird die aktuelle Fassung eine Version („before
   * restore“), nichts geht verloren; scheitert das Speichern, wird nicht wiederhergestellt.
   */
  restore(pageID: string, versionID: number): HistoryRestoreResult {
    const v = this.find(pageID, versionID);
    const { blocks, missing } = this.history.blocksOf(v);
    if (missing.length) throw new Error(`This version is incomplete (${missing.length} missing ${missing.length === 1 ? "object" : "objects"}); nothing was changed.`);
    const title = () => titleOf(this.store, pageID);
    this.dirty.delete(pageID);
    // wirft bei einem Schreibfehler: dann bleibt die Seite, wie sie ist
    this.history.record(pageID, structuredClone(versionBlocks(this.store, pageID)), title(), "before restore", this.now() / 1000);
    const r = restoreVersion(this.store, pageID, blocks);
    if (!r) throw new Error("This page can't be restored.");
    if (this.store.isReadOnly) throw new Error("read-only: " + (this.store.writeFailure?.message ?? ""));
    this.snapshot(pageID, "restored");
    return { restored: r.restored, removed: r.removed, copied: Object.keys(r.copied).length, trashed: r.trashed.length };
  }

  /** Seiten werden endgültig gelöscht: ihr Verlauf (und der ihrer Unterseiten) geht mit. */
  forget(ids: string[]) {
    const pages = new Set<string>();
    for (const id of ids) {
      pages.add(id);
      for (const d of subtree(this.store, id)) if (isPageLike(this.store.blocks.get(d))) pages.add(d);
    }
    for (const p of pages) this.dirty.delete(p);
    try {
      this.history.forgetAll(pages);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  /** Alte Versionen ausdünnen und unbenutzte Objekte wegräumen. */
  maintain(): { removed: number; swept: number } {
    try {
      return { removed: this.history.prune(this.now() / 1000), swept: this.history.collectGarbage() };
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return { removed: 0, swept: 0 };
    }
  }
}
