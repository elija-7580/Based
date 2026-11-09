// Quick-Find-Suche (Titel, Inhalt, Zeilenwerte), portiert aus BasedCore Search/SearchCorpus.swift und
// Search/SearchEngine.swift (BSD-137). Der Index wird einmal pro Stand gebaut; Texte sind gefaltet
// (Groß/klein und Akzente egal). Anders als Swift ist das Ergebnis stabil: Inhalts-Snippet aus dem ersten
// passenden Block in Dokumentreihenfolge, Gleichstand nach pageID. Verifiziert über fixtures/search (BSD-175).
import type { Block, PropertyValue } from "../model/records.js";
import { isTrashed, placeDisplay, plainTextResolvingMentions, richPlain, titleOf } from "../query/engine.js";
import { fromJSDate } from "../query/value.js";
import type { WorkspaceStore } from "../store/store.js";

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

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (s: string) => [...segmenter.segment(s)].map((x) => x.segment);

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

/** Text eines Nicht-Seiten-Blocks: Text (Erwähnungen mit aktuellem Titel), Tabellenzellen, Bildunterschrift, Transkript. */
export function contentText(store: WorkspaceStore, b: Block): string {
  let text = plainTextResolvingMentions(store, b.text);
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

function containingPage(store: WorkspaceStore, id: string): string | undefined {
  let cur = store.blocks.get(id);
  for (let n = 0; cur && n < 1000; n++) {
    if (isPageLike(cur)) return cur.id;
    const p = cur.parent;
    if (p === "w") return undefined;
    cur = p.startsWith("b:") ? store.blocks.get(p.slice(2)) : store.blocks.get(store.databases.get(p.slice(2))?.blockID ?? "");
  }
  return undefined;
}

function isDescendant(store: WorkspaceStore, id: string, ancestor: string): boolean {
  let p = store.blocks.get(id)?.parent;
  for (let n = 0; p && n < 10_000; n++) {
    if (p === "w") return false;
    if (p.startsWith("b:")) {
      const pid = p.slice(2);
      if (pid === ancestor) return true;
      p = store.blocks.get(pid)?.parent;
    } else {
      const owner = store.databases.get(p.slice(2))?.blockID;
      if (!owner) return false;
      if (owner === ancestor) return true;
      p = store.blocks.get(owner)?.parent;
    }
  }
  return false;
}

interface ContentEntry { blockID: string; page: string; folded: string; order: number }

/** Suchindex über einen Stand des Stores. */
export class SearchCorpus {
  private readonly titles: { id: string; folded: string }[] = [];
  readonly contents: ContentEntry[] = [];
  private readonly rows: { id: string; folded: string }[] = [];

  constructor(private readonly store: WorkspaceStore) {
    // Dokumentreihenfolge: Tiefensuche ab dem Workspace, damit „erster Block“ eindeutig ist.
    const order = new Map<string, number>();
    const visit = (parent: string) => {
      for (const id of store.children(parent)) {
        order.set(id, order.size);
        visit("b:" + id);
        const b = store.blocks.get(id);
        if (b?.props?.databaseID && store.databases.get(b.props.databaseID)?.blockID === b.id) visit("d:" + b.props.databaseID);
      }
    };
    visit("w");
    const live = new Map<string, boolean>();
    const isLive = (id: string) => {
      let l = live.get(id);
      if (l === undefined) live.set(id, (l = !isTrashed(store, id)));
      return l;
    };
    for (const b of store.blocks.values()) {
      const ownsDb = b.type === "databaseInline" && b.props?.databaseID !== undefined && store.databases.get(b.props.databaseID)?.blockID === b.id;
      if ((isPageLike(b) || ownsDb) && isLive(b.id)) this.titles.push({ id: b.id, folded: fold(titleOf(store, b.id)) });
      if (!isPageLike(b) && b.trashedAt === undefined) {
        const text = contentText(store, b);
        const page = text ? containingPage(store, b.id) : undefined;
        if (text && page && store.blocks.has(page) && isLive(page)) {
          this.contents.push({ blockID: b.id, page, folded: fold(text), order: order.get(b.id) ?? Number.MAX_SAFE_INTEGER });
        }
      }
      if (b.parent.startsWith("d:") && b.values && Object.keys(b.values).length > 0 && isLive(b.id)) {
        const text = rowText(b);
        if (text) this.rows.push({ id: b.id, folded: fold(text) });
      }
    }
    this.contents.sort((a, b) => a.order - b.order);
  }

  static has(hay: string, needle: string) {
    return needle === "" || hay.includes(needle);
  }

  search(query: string, filters: SearchFilters = {}, sort: SearchSort = "bestMatch", limit = 50, now = fromJSDate(new Date())): SearchHit[] {
    const q = fold(query.trim());
    if (!q) return [];
    const terms = q.split(" ").filter((t) => t.length > 0);
    const blocks = this.store.blocks;
    const allowed = (page: Block) => {
      if (page.props?.isTemplate === true) return false;
      if (filters.createdBy !== undefined && page.createdBy !== filters.createdBy) return false;
      if (filters.editedAfter !== undefined && page.updatedAt < filters.editedAfter) return false;
      if (filters.editedBefore !== undefined && page.updatedAt > filters.editedBefore) return false;
      if (filters.inPage !== undefined && page.id !== filters.inPage && !isDescendant(this.store, page.id, filters.inPage)) return false;
      return true;
    };
    const recency = (b: Block) => Math.max(0, 10 - (now - b.updatedAt) / 86_400 / 3);
    const hits = new Map<string, SearchHit>();
    for (const e of this.titles) {
      const b = blocks.get(e.id);
      if (!b || !allowed(b)) continue;
      const s = titleScore(e.folded, q, terms);
      if (s !== undefined) hits.set(e.id, { pageID: e.id, score: s + recency(b) });
    }
    if (!filters.titleOnly) {
      for (const e of this.contents) {
        if (!terms.every((t) => SearchCorpus.has(e.folded, t))) continue;
        const pb = blocks.get(e.page);
        if (!pb || !allowed(pb)) continue;
        const h = hits.get(e.page);
        const b = blocks.get(e.blockID);
        if (h) {
          if (h.snippet === undefined && b) {
            h.snippet = snippet(contentText(this.store, b), e.folded, terms[0]!);
            h.blockID = e.blockID;
            h.score += 5;
          }
        } else if (b) {
          hits.set(e.page, { pageID: e.page, score: 20 + recency(pb), snippet: snippet(contentText(this.store, b), e.folded, terms[0]!), blockID: e.blockID });
        }
      }
      for (const e of this.rows) {
        const b = blocks.get(e.id);
        if (hits.has(e.id) || !b || !allowed(b) || !terms.every((t) => SearchCorpus.has(e.folded, t))) continue;
        hits.set(e.id, { pageID: e.id, score: 15, snippet: snippet(rowText(b), e.folded, terms[0]!) });
      }
    }
    const out = [...hits.values()];
    const date = (h: SearchHit, created: boolean) => { const b = blocks.get(h.pageID); return b ? (created ? b.createdAt : b.updatedAt) : -Infinity; };
    const byId = (a: SearchHit, b: SearchHit) => (a.pageID < b.pageID ? -1 : a.pageID > b.pageID ? 1 : 0);
    out.sort((a, b) => {
      switch (sort) {
        case "bestMatch": {
          if (a.score !== b.score) return b.score - a.score;
          const ta = titleOf(this.store, a.pageID), tb = titleOf(this.store, b.pageID);
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
}
