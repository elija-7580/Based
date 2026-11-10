// Quick-Find- und Volltextsuche (Titel, Inhalt, Zeilenwerte), portiert aus BasedCore Search/SearchCorpus.swift und
// Search/SearchEngine.swift (BSD-137, BSD-157). Texte liegen gefaltet im Index (Groß/klein und Akzente egal).
//
// `SearchIndex` ist reines TypeScript ohne DOM und ohne Store: er hält eine eigene Kopie der Blöcke und Datenbanken
// und wird mit Records gefüttert (`load`, `apply`). Damit läuft er im Hauptthread (`attachSearchIndex(store)`) oder
// in einem Worker (`searchDeltaFrom`/`observeSearchDeltas` im Hauptthread, `handleSearchMessage` im Worker).
// Änderungen werden inkrementell eingearbeitet: neu berechnet werden nur die geänderten Blöcke, bei Struktur-
// änderungen (Eltern, Reihenfolge, Papierkorb, Typ) ihr Teilbaum und Blöcke, die sie erwähnen.
//
// Anders als Swift ist das Ergebnis stabil: Inhalts-Snippet aus dem ersten passenden Block in Dokumentreihenfolge,
// Zeilen-Snippet über die Werte nach Property-ID, Gleichstand nach pageID. Verifiziert über fixtures/search.
import type { Block, Database, PropertyValue, RichText, WireRecord } from "../model/records.js";
import { placeDisplay, richPlain } from "../query/engine.js";
import { fromJSDate } from "../query/value.js";
import { graphemes } from "../graphemes.js";
import type { RecordKeyString, StoreChange, WorkspaceStore } from "../store/store.js";

export interface SearchHit {
  pageID: string;
  score: number;
  /** Passender Inhaltstext (fehlt, wenn nur der Titel passt). */
  snippet?: string;
  blockID?: string;
}

export interface SearchFilters {
  titleOnly?: boolean;
  inPage?: string;
  createdBy?: string;
  /** Swift-Datum (Sekunden seit 2001). */
  editedAfter?: number;
  editedBefore?: number;
}

export type SearchSort = "bestMatch" | "lastEditedNewest" | "lastEditedOldest" | "createdNewest" | "createdOldest";

export interface SearchOptions {
  filters?: SearchFilters;
  sort?: SearchSort;
  limit?: number;
  /** Swift-Datum für die Aktualitäts-Punkte (Standard: jetzt). */
  now?: number;
  /** Wird regelmäßig gefragt; `true` bricht ab (Ergebnis `undefined`), z. B. bei einer neueren Eingabe. */
  isCancelled?: () => boolean;
}

/** Was die Suche aus dem Arbeitsbereich braucht (ein `WorkspaceStore` passt). */
export interface SearchSource {
  readonly blocks: ReadonlyMap<string, Block>;
  readonly databases: ReadonlyMap<string, Database>;
}

/** Änderungen für den Index (strukturiert klonbar, also auch per `postMessage`). `deletions`: `block:<id>`, `database:<id>`. */
export interface SearchDelta {
  upserts: WireRecord[];
  deletions: RecordKeyString[];
}



/** Groß/klein und Akzente falten (Swift `folding([.caseInsensitive, .diacriticInsensitive])`). */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC").toLowerCase().replaceAll("ß", "ss");
}

const isPageLike = (b: Block) => b.type === "page" || b.type === "databasePage";

function titleScore(title: string, q: string, terms: string[]): number | undefined {
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  const words = title.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
  if (terms.every((t) => words.some((w) => w.startsWith(t)))) return 60;
  if (title.includes(q)) return 45;
  if (terms.every((t) => title.includes(t))) return 35;
  return undefined;
}

/** Ausschnitt um den ersten Treffer (Swift `SearchEngine.snippet`). */
export function snippet(text: string, folded: string, term: string): string {
  const i = folded.indexOf(term);
  const chars = graphemes(text);
  if (i < 0) return chars.slice(0, 120).join("");
  const offset = graphemes(folded.slice(0, i)).length;
  const start = Math.max(0, offset - 40);
  const end = Math.min(chars.length, offset + graphemes(term).length + 80);
  if (start >= end) return chars.slice(0, 120).join("");
  return (start > 0 ? "…" : "") + chars.slice(start, end).join("") + (end < chars.length ? "…" : "");
}

// MARK: Hierarchie-Helfer über eine Quelle (Swift `SearchCorpus.Snapshot`)

function parentBlock(src: SearchSource, b: Block): Block | undefined {
  const p = b.parent;
  if (p === "w") return undefined;
  if (p.startsWith("b:")) return src.blocks.get(p.slice(2));
  const owner = src.databases.get(p.slice(2))?.blockID;
  return owner === undefined ? undefined : src.blocks.get(owner);
}

function isTrashedIn(src: SearchSource, id: string): boolean {
  let cur = src.blocks.get(id);
  for (let n = 0; cur && n < 1000; n++) {
    if (cur.trashedAt !== undefined) return true;
    const p = cur.parent;
    if (p === "w") return false;
    if (p.startsWith("b:")) cur = src.blocks.get(p.slice(2));
    else {
      const owner = src.databases.get(p.slice(2))?.blockID;
      if (owner === undefined) return true;
      cur = src.blocks.get(owner);
    }
    if (!cur) return true;
  }
  return false;
}

function containingPage(src: SearchSource, id: string): string | undefined {
  let cur = src.blocks.get(id);
  for (let n = 0; cur && n < 1000; n++) {
    if (isPageLike(cur)) return cur.id;
    cur = parentBlock(src, cur);
  }
  return undefined;
}

function isDescendant(src: SearchSource, id: string, ancestor: string): boolean {
  let p = src.blocks.get(id)?.parent;
  for (let n = 0; p && n < 10_000; n++) {
    if (p === "w") return false;
    if (p.startsWith("b:")) {
      const pid = p.slice(2);
      if (pid === ancestor) return true;
      p = src.blocks.get(pid)?.parent;
    } else {
      const owner = src.databases.get(p.slice(2))?.blockID;
      if (!owner) return false;
      if (owner === ancestor) return true;
      p = src.blocks.get(owner)?.parent;
    }
  }
  return false;
}

const ownsDatabase = (src: SearchSource, b: Block) =>
  b.props?.databaseID !== undefined && src.databases.get(b.props.databaseID)?.blockID === b.id;

/** Titel wie Swift `title(of:)` (Datenbank-Container: Titel der Datenbank). */
export function searchTitle(src: SearchSource, id: string): string {
  const b = src.blocks.get(id);
  if (!b) return "Untitled";
  if ((b.type === "databasePage" || b.type === "databaseInline") && b.props?.databaseID) {
    const db = src.databases.get(b.props.databaseID);
    if (db) {
      const t = richPlain(db.title);
      return t ? t : "Untitled";
    }
  }
  const t = richPlain(b.text).replace(/^[ \t]+|[ \t]+$/g, "");
  return t ? t : "Untitled";
}

function mentionTarget(mention: unknown): string | undefined {
  if (!mention || typeof mention !== "object") return undefined;
  const page = (mention as { page?: { _0?: unknown } }).page;
  return page && typeof page._0 === "string" ? page._0 : undefined;
}

function mentionTargets(t: RichText | undefined): string[] {
  if (t === undefined || typeof t === "string") return [];
  const out: string[] = [];
  for (const r of t) {
    const m = mentionTarget(r.mention);
    if (m !== undefined) out.push(m);
  }
  return out;
}

function resolvingMentions(src: SearchSource, t: RichText | undefined): string {
  if (t === undefined || typeof t === "string") return t ?? "";
  return t.map((r) => {
    const m = mentionTarget(r.mention);
    return m !== undefined && src.blocks.has(m) ? searchTitle(src, m) : r.t ?? "";
  }).join("");
}

/** Text eines Nicht-Seiten-Blocks: Text (Erwähnungen mit aktuellem Titel), Tabellenzellen, Bildunterschrift, Transkript. */
export function contentText(src: SearchSource, b: Block): string {
  let text = resolvingMentions(src, b.text);
  if (b.props?.cells) text += " " + b.props.cells.map(richPlain).join(" ");
  if (b.props?.caption !== undefined) text += " " + richPlain(b.props.caption);
  if (b.props?.segments) text += " " + b.props.segments.filter((s) => s.p !== true).map((s) => s.t).join(" ");
  return text;
}

/** Text-artige Werte einer Zeile (Property-IDs sortiert, damit das Snippet stabil ist). */
export function rowText(b: Block): string {
  const values = b.values ?? {};
  return Object.keys(values).sort().flatMap((k) => {
    const v = values[k] as PropertyValue;
    const [kind] = Object.keys(v);
    const x = (v as Record<string, { _0: unknown }>)[kind!]?._0;
    switch (kind) {
      case "text": return [richPlain(x as Block["text"])];
      case "url": case "email": case "phone": return [x as string];
      case "place": return [placeDisplay(x as string)];
      default: return [];
    }
  }).join(" ");
}

// MARK: Index

interface ContentEntry {
  blockID: string;
  page: string;
  folded: string;
  /** Weg von der Seite zum Block: (sk, id) je Ebene – vergleichbar in Dokumentreihenfolge. */
  path: string[];
}

function comparePaths(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return a.length - b.length;
}

const isRowBlock = (b: Block) => b.parent.startsWith("d:");

/** Suchindex. Pure Datenstruktur: ohne DOM, ohne Store – im Worker benutzbar. */
export class SearchIndex implements SearchSource {
  readonly blocks = new Map<string, Block>();
  readonly databases = new Map<string, Database>();
  private readonly children = new Map<string, Set<string>>();
  /** Erwähnungsziel → Blöcke, deren Text es erwähnt. */
  private readonly mentionedBy = new Map<string, Set<string>>();
  private readonly mentionsOf = new Map<string, string[]>();
  private readonly titles = new Map<string, string>();
  private readonly contentEntries = new Map<string, ContentEntry>();
  private readonly rows = new Map<string, string>();
  /** Zählt jede Änderung (wie Swift `revision`). */
  revision = 0;

  /** Index über alle Records (z. B. `store.allRecords()` oder ein Archiv). */
  static fromRecords(records: Iterable<WireRecord>): SearchIndex {
    const index = new SearchIndex();
    index.apply({ upserts: [...records], deletions: [] });
    return index;
  }

  /** Index über einen Store-Stand (Kopie; spätere Änderungen über `apply` oder `attachSearchIndex`). */
  static fromSource(src: SearchSource): SearchIndex {
    const index = new SearchIndex();
    index.load(src);
    return index;
  }

  /** Ersetzt den Inhalt durch einen vollständigen Stand. */
  load(src: SearchSource) {
    for (const m of [this.blocks, this.databases, this.children, this.mentionedBy, this.mentionsOf, this.titles, this.contentEntries, this.rows]) m.clear();
    for (const d of src.databases.values()) this.databases.set(d.id, d);
    for (const b of src.blocks.values()) this.putBlock(b);
    for (const id of this.blocks.keys()) this.recompute(id);
    this.revision += 1;
  }

  get entryCount() {
    return this.titles.size + this.contentEntries.size + this.rows.size;
  }

  /** Inhaltseinträge in Dokumentreihenfolge innerhalb jeder Seite (für Tests und Fixtures). */
  get contents(): readonly ContentEntry[] {
    return [...this.contentEntries.values()];
  }

  /** Arbeitet Änderungen ein (Records anderer Arten werden übergangen). */
  apply(delta: SearchDelta) {
    const dirty = new Set<string>();
    const subtree = (root: string) => {
      const stack = [root];
      while (stack.length) {
        const id = stack.pop()!;
        for (const c of this.children.get("b:" + id) ?? []) if (!dirty.has(c)) { dirty.add(c); stack.push(c); }
        const b = this.blocks.get(id);
        const db = b?.props?.databaseID;
        if (b && db !== undefined && this.databases.get(db)?.blockID === id) {
          for (const r of this.children.get("d:" + db) ?? []) if (!dirty.has(r)) { dirty.add(r); stack.push(r); }
        }
      }
    };
    const mentioning = (id: string) => { for (const m of this.mentionedBy.get(id) ?? []) dirty.add(m); };
    const databaseRows = (dbID: string) => {
      for (const r of this.children.get("d:" + dbID) ?? []) { dirty.add(r); subtree(r); }
    };
    for (const r of delta.upserts) {
      if (r.kind === "block") {
        const b = r.data;
        const old = this.blocks.get(b.id);
        this.putBlock(b);
        dirty.add(b.id);
        mentioning(b.id);
        const structural = !old || old.parent !== b.parent || old.sk !== b.sk || old.type !== b.type ||
          old.trashedAt !== b.trashedAt || old.props?.databaseID !== b.props?.databaseID;
        if (structural) subtree(b.id);
      } else if (r.kind === "database") {
        const d = r.data;
        const old = this.databases.get(d.id);
        this.databases.set(d.id, d);
        for (const owner of new Set([d.blockID, old?.blockID])) {
          if (owner === undefined) continue;
          dirty.add(owner);
          mentioning(owner);
        }
        if (!old || old.blockID !== d.blockID) databaseRows(d.id);
      }
    }
    for (const key of delta.deletions) {
      const i = key.indexOf(":");
      const kind = key.slice(0, i), id = key.slice(i + 1);
      if (kind === "block") {
        if (!this.blocks.has(id)) continue;
        subtree(id);
        mentioning(id);
        this.removeBlock(id);
        dirty.add(id);
      } else if (kind === "database") {
        const old = this.databases.get(id);
        if (!old) continue;
        databaseRows(id);
        this.databases.delete(id);
        dirty.add(old.blockID);
        mentioning(old.blockID);
      }
    }
    for (const id of dirty) this.recompute(id);
    if (delta.upserts.length > 0 || delta.deletions.length > 0) this.revision += 1;
  }

  private putBlock(b: Block) {
    const old = this.blocks.get(b.id);
    if (old && old.parent !== b.parent) this.children.get(old.parent)?.delete(b.id);
    this.blocks.set(b.id, b);
    let set = this.children.get(b.parent);
    if (!set) this.children.set(b.parent, (set = new Set()));
    set.add(b.id);
    this.setMentions(b.id, mentionTargets(b.text));
  }

  private removeBlock(id: string) {
    const old = this.blocks.get(id);
    if (!old) return;
    this.children.get(old.parent)?.delete(id);
    this.blocks.delete(id);
    this.setMentions(id, []);
  }

  private setMentions(id: string, targets: string[]) {
    for (const t of this.mentionsOf.get(id) ?? []) this.mentionedBy.get(t)?.delete(id);
    if (targets.length === 0) { this.mentionsOf.delete(id); return; }
    this.mentionsOf.set(id, targets);
    for (const t of targets) {
      let set = this.mentionedBy.get(t);
      if (!set) this.mentionedBy.set(t, (set = new Set()));
      set.add(id);
    }
  }

  private pathFromPage(id: string, page: string): string[] {
    const out: string[] = [];
    let cur = this.blocks.get(id);
    for (let n = 0; cur && cur.id !== page && n < 1000; n++) {
      out.push(cur.sk + "\u0000" + cur.id);
      cur = parentBlock(this, cur);
    }
    return out.reverse();
  }

  /** Einträge eines Blocks neu (Swift `SearchCorpus.build` für einen Block). */
  private recompute(id: string) {
    this.titles.delete(id);
    this.contentEntries.delete(id);
    this.rows.delete(id);
    const b = this.blocks.get(id);
    if (!b) return;
    let live: boolean | undefined;
    const isLive = () => (live ??= !isTrashedIn(this, id));
    if ((isPageLike(b) || (b.type === "databaseInline" && ownsDatabase(this, b))) && isLive()) {
      this.titles.set(id, fold(searchTitle(this, id)));
    }
    if (!isPageLike(b) && b.trashedAt === undefined) {
      const text = contentText(this, b);
      const page = text ? containingPage(this, id) : undefined;
      if (text && page !== undefined && this.blocks.has(page) && !isTrashedIn(this, page)) {
        this.contentEntries.set(id, { blockID: id, page, folded: fold(text), path: this.pathFromPage(id, page) });
      }
    }
    if (isRowBlock(b) && b.values && Object.keys(b.values).length > 0 && isLive()) {
      const text = rowText(b);
      if (text) this.rows.set(id, fold(text));
    }
  }

  /** Suche; `undefined`, wenn `isCancelled` abbricht. Eine leere Anfrage liefert keine Treffer (die Shell zeigt dann zuletzt besuchte Seiten). */
  run(query: string, opts: SearchOptions = {}): SearchHit[] | undefined {
    const filters = opts.filters ?? {}, sort = opts.sort ?? "bestMatch", limit = opts.limit ?? 50;
    const now = opts.now ?? fromJSDate(new Date());
    const cancelled = opts.isCancelled ?? (() => false);
    const q = fold(query.trim());
    if (!q) return [];
    const terms = q.split(" ").filter((t) => t.length > 0);
    const blocks = this.blocks;
    const allowed = (page: Block) => {
      if (page.props?.isTemplate === true) return false;
      if (filters.createdBy !== undefined && page.createdBy !== filters.createdBy) return false;
      if (filters.editedAfter !== undefined && page.updatedAt < filters.editedAfter) return false;
      if (filters.editedBefore !== undefined && page.updatedAt > filters.editedBefore) return false;
      if (filters.inPage !== undefined && page.id !== filters.inPage && !isDescendant(this, page.id, filters.inPage)) return false;
      return true;
    };
    const recency = (b: Block) => Math.max(0, 10 - (now - b.updatedAt) / 86_400 / 3);
    const hits = new Map<string, SearchHit>();
    let n = 0;
    const tick = () => (++n & 4095) === 0 && cancelled();
    for (const [id, folded] of this.titles) {
      if (tick()) return undefined;
      const b = blocks.get(id);
      if (!b || !allowed(b)) continue;
      const s = titleScore(folded, q, terms);
      if (s !== undefined) hits.set(id, { pageID: id, score: s + recency(b) });
    }
    if (!filters.titleOnly) {
      // Erster passender Block je Seite in Dokumentreihenfolge.
      const firstMatch = new Map<string, ContentEntry>();
      for (const e of this.contentEntries.values()) {
        if (tick()) return undefined;
        if (!terms.every((t) => e.folded.includes(t))) continue;
        const best = firstMatch.get(e.page);
        if (!best || comparePaths(e.path, best.path) < 0) firstMatch.set(e.page, e);
      }
      for (const [page, e] of firstMatch) {
        const pb = blocks.get(page), b = blocks.get(e.blockID);
        if (!pb || !b || !allowed(pb)) continue;
        const text = snippet(contentText(this, b), e.folded, terms[0]!);
        const h = hits.get(page);
        if (h) {
          h.snippet = text;
          h.blockID = e.blockID;
          h.score += 5;
        } else {
          hits.set(page, { pageID: page, score: 20 + recency(pb), snippet: text, blockID: e.blockID });
        }
      }
      for (const [id, folded] of this.rows) {
        if (tick()) return undefined;
        const b = blocks.get(id);
        if (hits.has(id) || !b || !allowed(b) || !terms.every((t) => folded.includes(t))) continue;
        hits.set(id, { pageID: id, score: 15, snippet: snippet(rowText(b), folded, terms[0]!) });
      }
    }
    const out = [...hits.values()];
    const date = (h: SearchHit, created: boolean) => { const b = blocks.get(h.pageID); return b ? (created ? b.createdAt : b.updatedAt) : -Infinity; };
    const byId = (a: SearchHit, b: SearchHit) => (a.pageID < b.pageID ? -1 : a.pageID > b.pageID ? 1 : 0);
    const titleCache = new Map<string, string>();
    const title = (id: string) => {
      let t = titleCache.get(id);
      if (t === undefined) titleCache.set(id, (t = searchTitle(this, id)));
      return t;
    };
    out.sort((a, b) => {
      switch (sort) {
        case "bestMatch": {
          if (a.score !== b.score) return b.score - a.score;
          const ta = title(a.pageID), tb = title(b.pageID);
          if (ta !== tb) return ta < tb ? -1 : 1;
          return byId(a, b);
        }
        case "lastEditedNewest": return date(b, false) - date(a, false) || byId(a, b);
        case "lastEditedOldest": return date(a, false) - date(b, false) || byId(a, b);
        case "createdNewest": return date(b, true) - date(a, true) || byId(a, b);
        case "createdOldest": return date(a, true) - date(b, true) || byId(a, b);
      }
    });
    return out.slice(0, limit);
  }

  /** Wie `run`, ohne Abbruch (Signatur wie Swift `SearchCorpus.search`). */
  search(query: string, filters: SearchFilters = {}, sort: SearchSort = "bestMatch", limit = 50, now = fromJSDate(new Date())): SearchHit[] {
    return this.run(query, { filters, sort, limit, now }) ?? [];
  }
}

/** Index über einen Store-Stand (Swift `SearchCorpus.build`); bleibt für bestehende Aufrufer erhalten. */
export class SearchCorpus extends SearchIndex {
  constructor(src: SearchSource) {
    super();
    this.load(src);
  }
}

// MARK: Anbindung an den Store

/** Vollständiger Stand für einen neuen Index (z. B. als erste Nachricht an den Worker). */
export function searchSnapshot(store: WorkspaceStore): SearchDelta {
  const upserts: WireRecord[] = [];
  for (const data of store.databases.values()) upserts.push({ kind: "database", data });
  for (const data of store.blocks.values()) upserts.push({ kind: "block", data });
  return { upserts, deletions: [] };
}

/** Die Änderung einer Store-Transaktion als Index-Delta (Blöcke und Datenbanken). */
export function searchDeltaFrom(store: WorkspaceStore, change: StoreChange): SearchDelta {
  const upserts: WireRecord[] = [];
  const deletions: RecordKeyString[] = [];
  for (const key of change.keys) {
    if (!key.startsWith("block:") && !key.startsWith("database:")) continue;
    const r = store.record(key);
    if (r) upserts.push(r);
    else deletions.push(key);
  }
  return { upserts, deletions };
}

/** Meldet jede Store-Änderung als Delta (für einen Worker: `send = (d) => worker.postMessage({type: "apply", delta: d})`). */
export function observeSearchDeltas(store: WorkspaceStore, send: (delta: SearchDelta) => void): () => void {
  return store.observe((change) => {
    const d = searchDeltaFrom(store, change);
    if (d.upserts.length > 0 || d.deletions.length > 0) send(d);
  });
}

/** Index im selben Thread, der dem Store folgt. `dispose()` meldet ab. */
export function attachSearchIndex(store: WorkspaceStore): { index: SearchIndex; dispose: () => void } {
  const index = SearchIndex.fromSource(store);
  const dispose = observeSearchDeltas(store, (d) => index.apply(d));
  return { index, dispose };
}

// MARK: Worker-Protokoll

export type SearchRequest =
  | { type: "load"; delta: SearchDelta }
  | { type: "apply"; delta: SearchDelta }
  | { type: "search"; id: number; query: string; filters?: SearchFilters; sort?: SearchSort; limit?: number; now?: number };

export type SearchResponse = { type: "result"; id: number; hits: SearchHit[]; revision: number };

/**
 * Eine Nachricht im Worker verarbeiten. `isCancelled` kann eine neuere Anfrage melden (z. B. über einen
 * SharedArrayBuffer-Zähler); dann gibt es keine Antwort.
 */
export function handleSearchMessage(index: SearchIndex, msg: SearchRequest, isCancelled?: () => boolean): SearchResponse | undefined {
  switch (msg.type) {
    case "load": {
      const fresh = SearchIndex.fromRecords(msg.delta.upserts);
      index.load(fresh);
      return undefined;
    }
    case "apply":
      index.apply(msg.delta);
      return undefined;
    case "search": {
      const opts: SearchOptions = {};
      if (msg.filters !== undefined) opts.filters = msg.filters;
      if (msg.sort !== undefined) opts.sort = msg.sort;
      if (msg.limit !== undefined) opts.limit = msg.limit;
      if (msg.now !== undefined) opts.now = msg.now;
      if (isCancelled !== undefined) opts.isCancelled = isCancelled;
      const hits = index.run(msg.query, opts);
      return hits === undefined ? undefined : { type: "result", id: msg.id, hits, revision: index.revision };
    }
  }
}
