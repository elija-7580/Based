// Backlinks: welche Seiten erwähnen oder verlinken eine Seite? Portiert aus Swift Store/PageOps.swift
// (`linkedPages`, `reindexLinks`, `backlinks(to:)`): ein Index Block → Zielseiten und Zielseite → Blöcke, der
// inkrementell nachgeführt wird. Der Store-Host hält ihn im Worker (nie ein Scan aller Blöcke im Hauptthread).
import { isTrashed, titleOf } from "../query/engine.js";
import type { Block, RichText } from "../model/records.js";
import { pageIDFromLink } from "../interop/html.js";
import { isPageLike } from "./pages.js";
import { parseKey, type RecordKeyString, type WorkspaceStore } from "./store.js";

/** Seiten, die ein Text erwähnt (Seiten-Erwähnungen und `based://page/<id>`-Links). */
export function mentionedPages(t: RichText | undefined, into: Set<string> = new Set()): Set<string> {
  if (t === undefined || typeof t === "string") return into;
  for (const run of t) {
    const m = run.mention as { page?: { _0?: unknown } } | undefined;
    if (m?.page && typeof m.page._0 === "string") into.add(m.page._0);
    const link = run.m?.link;
    if (typeof link === "string" && link.startsWith("based:")) {
      const id = pageIDFromLink(link);
      if (id) into.add(id);
    }
  }
  return into;
}

/** Seiten, auf die ein Block verweist (Erwähnungen, Link-to-page, Tabellenzellen, Text-Eigenschaften). */
export function linkedPages(b: Block): Set<string> {
  const out = mentionedPages(b.text);
  const target = b.props?.linkTarget;
  if (typeof target === "string" && target !== "") out.add(target);
  for (const c of b.props?.cells ?? []) mentionedPages(c as RichText, out);
  if (b.props?.caption !== undefined) mentionedPages(b.props.caption as RichText, out);
  for (const v of Object.values(b.values ?? {})) {
    const text = (v as { text?: { _0?: RichText } } | undefined)?.text;
    if (text && text._0 !== undefined) mentionedPages(text._0, out);
  }
  return out;
}

/** Die Seite, auf der ein Block steht (er selbst, wenn er eine Seite ist); Zeilen-Inhalte gehören zur Zeile. */
export function containingPage(store: WorkspaceStore, id: string): string | undefined {
  let cur = store.blocks.get(id);
  for (let n = 0; cur && n < 10_000; n++) {
    if (isPageLike(cur)) return cur.id;
    if (!cur.parent.startsWith("b:")) return undefined;
    cur = store.blocks.get(cur.parent.slice(2));
  }
  return undefined;
}

export class LinkIndex {
  private targets = new Map<string, Set<string>>(); // Block → Zielseiten
  private sources = new Map<string, Set<string>>(); // Zielseite → Blöcke

  static fromStore(store: WorkspaceStore): LinkIndex {
    const idx = new LinkIndex();
    for (const b of store.blocks.values()) idx.reindex(b.id, b);
    return idx;
  }

  /** Einen Block neu einordnen (`undefined` = gelöscht). */
  reindex(id: string, b: Block | undefined): void {
    const next = b ? linkedPages(b) : new Set<string>();
    const prev = this.targets.get(id);
    if (prev) {
      for (const t of prev) {
        if (next.has(t)) continue;
        const s = this.sources.get(t);
        s?.delete(id);
        if (s && s.size === 0) this.sources.delete(t);
      }
    }
    for (const t of next) {
      if (prev?.has(t)) continue;
      let s = this.sources.get(t);
      if (!s) this.sources.set(t, (s = new Set()));
      s.add(id);
    }
    if (next.size) this.targets.set(id, next);
    else this.targets.delete(id);
  }

  /** Geänderte Records nachführen (Schlüssel aus `StoreChange.keys`). */
  apply(store: WorkspaceStore, keys: Iterable<RecordKeyString>): void {
    for (const key of keys) {
      const { kind, id } = parseKey(key);
      if (kind === "block") this.reindex(id, store.blocks.get(id));
    }
  }

  /** Blöcke, die auf `pageID` verweisen. */
  sourcesOf(pageID: string): ReadonlySet<string> {
    return this.sources.get(pageID) ?? new Set();
  }

  /**
   * Seiten, die `pageID` erwähnen oder verlinken: ohne die Seite selbst, ohne Papierkorb, nach Titel sortiert
   * (wie Swift `backlinks(to:)`).
   */
  backlinks(store: WorkspaceStore, pageID: string): string[] {
    const pages = new Set<string>();
    for (const src of this.sourcesOf(pageID)) {
      const b = store.blocks.get(src);
      if (!b || b.trashedAt !== undefined) continue;
      const page = containingPage(store, src);
      if (!page || page === pageID || pages.has(page) || isTrashed(store, page)) continue;
      pages.add(page);
    }
    return [...pages].sort((a, b) => titleOf(store, a).localeCompare(titleOf(store, b), undefined, { sensitivity: "base" }) || (a < b ? -1 : 1));
  }
}

/** Backlinks ohne gehaltenen Index (kleine Stores, Tests). */
export function backlinksTo(store: WorkspaceStore, pageID: string): string[] {
  return LinkIndex.fromStore(store).backlinks(store, pageID);
}
