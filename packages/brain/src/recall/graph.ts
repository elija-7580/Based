// BSD-541: Relationen des Workspaces als Graph für Agenten. Keine eigene Ablage – die Kanten stehen schon in den
// Records: Datenbank-Relationen (Zeile → Zeilen/Seiten), Erwähnungen und Links (Block → Seite), Eltern/Kind und
// Zeile ↔ Datenbank. Hier wird nur der Rückweg mitgeführt (wer zeigt auf mich?), inkrementell wie der `LinkIndex`.
// Abgeleitet, nie synchronisiert, jederzeit neu berechenbar.
import { containingPage, isPageLike, isTrashed, linkedPages, LinkIndex, pageAncestors, parseKey, titleOf, type Block, type RecordKeyString, type WorkspaceStore } from "@based/core";

export type EdgeKind = "relation" | "mention" | "parent" | "child";

export interface Neighbor {
  id: string;
  kind: EdgeKind;
  /** `true`: die Seite zeigt auf den Nachbarn; `false`: der Nachbar zeigt auf die Seite. */
  out: boolean;
  /** Name der Relation-Spalte (nur `relation`). */
  label?: string;
}

/** Gewicht einer Kante beim Weiterreichen von Treffern (Relation zählt am meisten, Hierarchie am wenigsten). */
export const EDGE_WEIGHT: Record<EdgeKind, number> = { relation: 1, mention: 0.7, parent: 0.35, child: 0.25 };

/** Was im JSON eines Blocks stehen muss, damit er eine Relation tragen kann (Vorfilter für `scanBlocks`). */
const RELATION_HINTS = ['"relation"'] as const;

/** Ziele der Relationen einer Zeile, je Ziel die Spalte. */
function relationsOf(b: Block): Map<string, string> {
  const out = new Map<string, string>();
  for (const [pid, v] of Object.entries(b.values ?? {})) {
    const x = (v as { relation?: { _0?: unknown } } | undefined)?.relation?._0;
    if (Array.isArray(x)) for (const id of x) if (typeof id === "string" && id !== b.id && !out.has(id)) out.set(id, pid);
  }
  return out;
}

export class RelationGraph {
  private readonly links: LinkIndex;
  private readonly relTargets = new Map<string, Map<string, string>>(); // Zeile → Ziel → Spalte
  private readonly relSources = new Map<string, Set<string>>(); // Ziel → Zeilen

  private constructor(private readonly store: WorkspaceStore) {
    this.links = LinkIndex.fromStore(store);
    store.scanBlocks(RELATION_HINTS, (b) => this.reindex(b.id, b));
  }

  /** Graph, der dem Store folgt. `dispose()` meldet ab. */
  static attach(store: WorkspaceStore): { graph: RelationGraph; dispose: () => void } {
    const graph = new RelationGraph(store);
    const dispose = store.observe((change) => graph.apply(change.keys));
    return { graph, dispose };
  }

  static fromStore(store: WorkspaceStore): RelationGraph {
    return new RelationGraph(store);
  }

  apply(keys: Iterable<RecordKeyString>): void {
    const list = [...keys];
    this.links.apply(this.store, list);
    for (const key of list) {
      const { kind, id } = parseKey(key);
      if (kind === "block") this.reindex(id, this.store.blocks.get(id));
    }
  }

  private reindex(id: string, b: Block | undefined): void {
    const next = b ? relationsOf(b) : new Map<string, string>();
    const prev = this.relTargets.get(id);
    if (prev) for (const t of prev.keys()) {
      if (next.has(t)) continue;
      const s = this.relSources.get(t);
      s?.delete(id);
      if (s && s.size === 0) this.relSources.delete(t);
    }
    for (const t of next.keys()) {
      let s = this.relSources.get(t);
      if (!s) this.relSources.set(t, (s = new Set()));
      s.add(id);
    }
    if (next.size) this.relTargets.set(id, next);
    else this.relTargets.delete(id);
  }

  private live(id: string): boolean {
    const b = this.store.blocks.get(id);
    return !!b && isPageLike(b) && !isTrashed(this.store, id);
  }

  private propertyName(row: Block, pid: string): string | undefined {
    const dbID = row.parent.startsWith("d:") ? row.parent.slice(2) : undefined;
    return dbID ? this.store.databases.get(dbID)?.properties.find((p) => p.id === pid)?.name : undefined;
  }

  /** Seiten, die der Inhalt einer Seite erwähnt (ohne Unterseiten – die haben ihren eigenen Inhalt). */
  private mentionsOut(pageID: string, into: Set<string>): void {
    const page = this.store.blocks.get(pageID);
    if (page) for (const t of linkedPages(page)) into.add(t);
    const walk = (parent: string, depth: number) => {
      if (depth > 40) return;
      for (const id of this.store.children("b:" + parent)) {
        const b = this.store.blocks.get(id);
        if (!b || b.trashedAt !== undefined || isPageLike(b)) continue;
        for (const t of linkedPages(b)) into.add(t);
        walk(id, depth + 1);
      }
    };
    walk(pageID, 0);
  }

  /**
   * Nachbarn einer Seite, wichtigste Kantenart zuerst (Relation, Erwähnung, Eltern, Kinder); je Nachbar nur die
   * stärkste Kante. Nur lebende Seiten. `limit` begrenzt je Art (Kinder und Rückverweise können viele sein);
   * `hidden` blendet Seiten aus (z. B. überholte Memories).
   */
  neighbors(pageID: string, limit = 25, hidden?: ReadonlySet<string>): Neighbor[] {
    const page = this.store.blocks.get(pageID);
    if (!page) return [];
    const out: Neighbor[] = [];
    const seen = new Set<string>([pageID]);
    const push = (n: Neighbor) => {
      if (seen.has(n.id) || hidden?.has(n.id) || !this.live(n.id)) return false;
      seen.add(n.id);
      out.push(n);
      return true;
    };
    const capped = (items: Iterable<Neighbor>) => {
      let n = 0;
      for (const it of items) {
        if (n >= limit) break;
        if (push(it)) n += 1;
      }
    };
    capped([...relationsOf(page)].map(([id, pid]) => {
      const label = this.propertyName(page, pid);
      return { id, kind: "relation" as const, out: true, ...(label ? { label } : {}) };
    }));
    capped([...(this.relSources.get(pageID) ?? [])].map((src) => {
      const row = this.store.blocks.get(src);
      const pid = this.relTargets.get(src)?.get(pageID);
      const label = row && pid ? this.propertyName(row, pid) : undefined;
      return { id: src, kind: "relation" as const, out: false, ...(label ? { label } : {}) };
    }));
    const mentioned = new Set<string>();
    this.mentionsOut(pageID, mentioned);
    capped([...mentioned].map((id) => ({ id, kind: "mention" as const, out: true })));
    const back = new Set<string>();
    for (const src of this.links.sourcesOf(pageID)) {
      const b = this.store.blocks.get(src);
      if (!b || b.trashedAt !== undefined) continue;
      const from = (b.props as { linkSource?: unknown } | undefined)?.linkSource;
      const p = typeof from === "string" && from !== "" ? from : containingPage(this.store, src);
      if (p) back.add(p);
    }
    capped([...back].map((id) => ({ id, kind: "mention" as const, out: false })));
    const up = pageAncestors(this.store, pageID).at(-1);
    if (up) push({ id: up, kind: "parent", out: true });
    capped(this.store.children("b:" + pageID).map((id) => ({ id, kind: "child" as const, out: true })));
    return out;
  }

  /** Eine Zeile Text je Kantenart, nur Titel – für die knappe Antwort an Agenten. */
  describe(pageID: string, perKind = 4, hidden?: ReadonlySet<string>): string[] {
    const groups = new Map<string, string[]>();
    for (const n of this.neighbors(pageID, perKind * 3, hidden)) {
      const key = n.kind === "relation" ? (n.out ? n.label ?? "related" : `${n.label ?? "related"} of`) : n.kind === "mention" ? (n.out ? "mentions" : "mentioned by") : n.kind === "parent" ? "in" : "contains";
      const list = groups.get(key) ?? [];
      if (list.length < perKind) list.push(titleOf(this.store, n.id) || "Untitled");
      groups.set(key, list);
    }
    return [...groups].map(([k, titles]) => `${k}: ${titles.join(", ")}`);
  }
}
