// BSD-541: hält den Vektor-Index (`VectorIndex`) zum Workspace aktuell. Eine Seite wird in Abschnitte entlang ihrer
// Blöcke geteilt (~800 Zeichen); vor jedem Abschnitt stehen Seitentitel und aktuelle Überschrift, damit ein Absatz
// auch ohne seine Umgebung verständlich bleibt. Eingebettet wird nur, was sich geändert hat (Hash je Abschnitt).
// Läuft in kleinen Schritten (`step`), damit Server und App nebenher bedienbar bleiben.
import { contentText, isPageLike, isTrashed, parseKey, containingPage, rowText, titleOf, type RecordKeyString, type WorkspaceStore } from "@based/core";
import { SECTION_CHARS, type TextEmbedder } from "../semantic/index.js";
import { textHash, VectorIndex } from "./vectors.js";

export interface PageSection {
  /** Text, wie er eingebettet wird (mit Titel und Überschrift davor). */
  text: string;
  /** Nur der Inhalt (für Auszüge). */
  body: string;
  /** Erster Block des Abschnitts (zum Zitieren und Hinspringen). */
  blockID?: string;
}

const HEADINGS = new Set(["heading1", "heading2", "heading3", "heading4"]);

/** Abschnitte einer Seite in Lesereihenfolge. Unterseiten gehören nicht dazu (eigene Seiten). */
export function pageSections(store: WorkspaceStore, pageID: string, max = SECTION_CHARS): PageSection[] {
  const page = store.blocks.get(pageID);
  if (!page) return [];
  const title = titleOf(store, pageID) || "Untitled";
  const out: PageSection[] = [];
  let cur = "", first: string | undefined, heading = "", curHeading = "";
  const flush = () => {
    if (cur.trim()) out.push({ text: `${title}${curHeading ? " › " + curHeading : ""}\n${cur}`, body: cur, ...(first ? { blockID: first } : {}) });
    cur = "";
    first = undefined;
  };
  const add = (text: string, blockID?: string) => {
    const s = text.replace(/\s+/g, " ").trim();
    if (!s) return;
    if (cur && cur.length + s.length > max) flush();
    if (!cur) curHeading = heading;
    cur = cur ? cur + "\n" + s : s;
    first ??= blockID;
  };
  const values = rowText(page);
  if (values) add(values);
  const walk = (parent: string, depth: number) => {
    if (depth > 40) return;
    for (const id of store.children("b:" + parent)) {
      const b = store.blocks.get(id);
      if (!b || b.trashedAt !== undefined || isPageLike(b)) continue;
      const text = contentText(store, b);
      if (HEADINGS.has(b.type)) {
        flush();
        heading = text.replace(/\s+/g, " ").trim();
      }
      add(text, b.id);
      walk(id, depth + 1);
    }
  };
  walk(pageID, 0);
  flush();
  // Eine Seite ohne Inhalt ist über ihren Titel auffindbar.
  if (out.length === 0) out.push({ text: title, body: "" });
  return out;
}

export interface IndexerOptions {
  /** Seiten, die nicht in den Index gehören (z. B. Bereiche, die der Server nicht lesen darf). */
  include?: (pageID: string) => boolean;
}

export class SemanticIndexer {
  private readonly queue = new Set<string>();
  private unobserve: (() => void) | undefined;

  constructor(private readonly store: WorkspaceStore, private readonly embedder: TextEmbedder, readonly index: VectorIndex, private readonly opts: IndexerOptions = {}) {
    if (index.model !== embedder.id) throw new Error(`index was built with ${index.model}, embedder is ${embedder.id}`);
  }

  /** Noch nicht verarbeitete Seiten. */
  get pending(): number {
    return this.queue.size;
  }

  private wanted(id: string): boolean {
    const b = this.store.blocks.get(id);
    return !!b && isPageLike(b) && !isTrashed(this.store, id) && (this.opts.include?.(id) ?? true);
  }

  /** Alle Seiten vormerken (erster Lauf, oder nach einem Modellwechsel). Unveränderte kosten später nur den Hash. */
  enqueueAll(): void {
    const seen = new Set<string>();
    const walk = (key: string) => {
      for (const id of this.store.children(key)) {
        if (seen.has(id)) continue;
        seen.add(id);
        const b = this.store.blocks.get(id);
        if (!b || b.trashedAt !== undefined) continue;
        if (isPageLike(b)) this.queue.add(id);
        walk("b:" + id);
        const db = b.props?.databaseID;
        if (typeof db === "string" && (b.type === "databasePage" || b.type === "databaseInline")) walk("d:" + db);
      }
    };
    walk("w");
  }

  /** Dem Store folgen: geänderte Blöcke merken ihre Seite vor. */
  follow(): () => void {
    this.unobserve ??= this.store.observe((change) => this.touch(change.keys));
    return () => {
      this.unobserve?.();
      this.unobserve = undefined;
    };
  }

  touch(keys: Iterable<RecordKeyString>): void {
    for (const key of keys) {
      const { kind, id } = parseKey(key);
      if (kind !== "block") continue;
      const b = this.store.blocks.get(id);
      if (!b) {
        // Gelöscht: war es eine Seite, fliegt sie aus dem Index (ihr Inhalt kommt als eigene Schlüssel).
        this.index.removePage(id);
        continue;
      }
      const page = isPageLike(b) ? b.id : containingPage(this.store, id);
      if (page) this.queue.add(page);
    }
  }

  /** Eine Seite sofort nachführen. Gibt die Zahl neu eingebetteter Abschnitte zurück. */
  async indexPage(pageID: string, signal?: AbortSignal): Promise<number> {
    this.queue.delete(pageID);
    if (!this.wanted(pageID)) {
      this.index.removePage(pageID);
      return 0;
    }
    const sections = pageSections(this.store, pageID);
    const hashes = sections.map((s) => textHash(s.text));
    const known = new Map<number, number>();
    for (const h of this.index.hashesOf(pageID)) known.set(h, (known.get(h) ?? 0) + 1);
    const missing: number[] = [];
    hashes.forEach((h, i) => {
      const n = known.get(h) ?? 0;
      if (n > 0) known.set(h, n - 1);
      else missing.push(i);
    });
    const vectors: (Float32Array | undefined)[] = new Array<Float32Array | undefined>(sections.length).fill(undefined);
    if (missing.length) {
      const vs = await this.embedder.embed(missing.map((i) => sections[i]!.text), signal, "passage");
      missing.forEach((i, k) => { vectors[i] = vs[k]; });
    }
    // Zwischen Lesen und Einbetten kann die Seite verschwunden sein.
    if (!this.wanted(pageID)) {
      this.index.removePage(pageID);
      return 0;
    }
    this.index.setPage(pageID, hashes, vectors);
    return missing.length;
  }

  /** Bis zu `maxPages` vorgemerkte Seiten verarbeiten. Gibt zurück, wie viele noch warten. */
  async step(maxPages = 8, signal?: AbortSignal): Promise<number> {
    let n = 0;
    for (const id of [...this.queue]) {
      if (n >= maxPages) break;
      signal?.throwIfAborted();
      await this.indexPage(id, signal);
      n += 1;
    }
    return this.queue.size;
  }

  /** Alles Vorgemerkte verarbeiten (Tests, kleine Workspaces). */
  async drain(signal?: AbortSignal): Promise<void> {
    while ((await this.step(32, signal)) > 0) { /* weiter */ }
  }
}
