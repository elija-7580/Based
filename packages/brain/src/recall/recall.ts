// BSD-541: `recall` – ein Abruf für Agenten statt vieler Einzelschritte. Drei Quellen laufen zusammen:
//   1. Wörter: die Suche von Quick Find (Tippfehler, Wortformen, Zeilenwerte), als ganze Anfrage und Wort für Wort,
//      damit auch ganze Sätze („what did we decide about sync?“) etwas finden.
//   2. Bedeutung: der Vektor-Index, wenn ein lokales Embedding-Modell geladen ist (sonst entfällt die Quelle).
//   3. Nachbarn: von den besten Treffern einen Schritt über die Kanten (Relation, Erwähnung, Eltern/Kind).
// Zusammengeführt per Reciprocal Rank Fusion. Die Antwort ist knapper Text: Memories zuerst, dann Seiten mit Auszug
// und ihren wichtigsten Nachbarn (nur Titel), dann Seiten, die mehrere Treffer verbinden.
import { isPageLike, isTrashed, pageLocation, titleOf, type SearchIndex, type WorkspaceStore } from "@based/core";
import type { AgentBrain } from "../agentbrain/store.js";
import type { MemoryRecord } from "../memory/suggestions.js";
import type { TextEmbedder } from "../semantic/index.js";
import { contentWords } from "../semantic/text.js";
import { EDGE_WEIGHT, type RelationGraph } from "./graph.js";
import { pageSections } from "./indexer.js";
import type { VectorIndex } from "./vectors.js";

/** Konstante der Reciprocal Rank Fusion (üblicher Wert; dämpft den Abstand zwischen den ersten Rängen). */
export const RRF_K = 60;
/** Gewicht der Wort-für-Wort-Suche gegenüber der ganzen Anfrage. */
const TERM_WEIGHT = 0.5;
const MAX_TERMS = 6;

export interface RecallOptions {
  /** Höchstens so viele Seiten (Memories und Verbundenes kommen dazu). */
  limit?: number | undefined;
  /** Nur im Umfeld dieser Seite suchen (sie selbst, ihre Nachbarn, deren Inhalt zählt stärker). */
  about?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface RecallItem {
  id: string;
  title: string;
  score: number;
  snippet?: string;
  blockID?: string;
  location?: string;
  row?: boolean;
  /** Nachbarn als Text je Kantenart („Project: Based“, „mentioned by: Roadmap“). */
  links: string[];
}

export interface RecallMemory extends MemoryRecord {
  score: number;
  /** Titel der Seiten, um die es geht. */
  aboutTitles: string[];
}

export interface RecallConnected {
  id: string;
  title: string;
  /** Titel der Treffer, die auf diese Seite führen. */
  via: string[];
}

export interface RecallResult {
  query: string;
  about?: { id: string; title: string };
  memories: RecallMemory[];
  pages: RecallItem[];
  connected: RecallConnected[];
  /** Ob die Bedeutungssuche mitlief (lokales Modell geladen und Index nicht leer). */
  semantic: boolean;
}

export interface RecallDeps {
  search: () => SearchIndex;
  graph: () => RelationGraph;
  /** Vektor-Index und Modell, wenn eingeschaltet und geladen. */
  vectors?: (() => { index: VectorIndex; embedder: TextEmbedder } | undefined) | undefined;
}

const flat = (s: string, max = 220) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

export class Recall {
  constructor(private readonly store: WorkspaceStore, private readonly brain: AgentBrain, private readonly deps: RecallDeps) {}

  private live(id: string): boolean {
    const b = this.store.blocks.get(id);
    return !!b && isPageLike(b) && !isTrashed(this.store, id);
  }

  /** Seiten, die nie als Treffer taugen: das Gerüst des Agent Brain und Skills (Anweisungen, kein Wissen). */
  private structural(): Set<string> {
    const ids = this.brain.find();
    const out = new Set<string>();
    if (!ids) return out;
    out.add(ids.root);
    for (const id of this.store.children("d:" + ids.skillsDB)) out.add(id);
    return out;
  }

  async run(query: string, opts: RecallOptions = {}): Promise<RecallResult> {
    const q = query.trim();
    const limit = Math.max(1, Math.min(opts.limit ?? 8, 30));
    const skip = this.structural();
    const graph = this.deps.graph();
    const ids = this.brain.find();
    const memories = new Map(this.brain.memories().map((m) => [m.id, m]));
    // Überholte und noch nicht freigegebene Memories zählen nirgends: nicht als Treffer, nicht als Nachbar.
    const hidden = new Set<string>(skip);
    for (const m of memories.values()) if ((m.status ?? "Active") !== "Active") hidden.add(m.id);
    const about = opts.about && this.live(opts.about) ? opts.about : undefined;
    const scope = about ? new Set([about, ...graph.neighbors(about, 200, hidden).map((n) => n.id)]) : undefined;

    // 1. Ranglisten sammeln
    const score = new Map<string, number>();
    const best = new Map<string, { snippet?: string; blockID?: string }>();
    const fuse = (list: readonly { pageID: string; snippet?: string | undefined; blockID?: string | undefined }[], weight: number) => {
      let rank = 0;
      const seen = new Set<string>();
      for (const h of list) {
        if (seen.has(h.pageID) || hidden.has(h.pageID) || !this.live(h.pageID)) continue;
        seen.add(h.pageID);
        rank += 1;
        score.set(h.pageID, (score.get(h.pageID) ?? 0) + weight / (RRF_K + rank));
        if (h.snippet && !best.get(h.pageID)?.snippet) best.set(h.pageID, { snippet: h.snippet, ...(h.blockID ? { blockID: h.blockID } : {}) });
      }
    };
    if (q) {
      const index = this.deps.search();
      fuse(index.run(q, { extended: true, limit: 40 }) ?? [], 1);
      const words = contentWords(q);
      if (words.length > 1) for (const w of [...words].sort((a, b) => b.length - a.length).slice(0, MAX_TERMS)) fuse(index.run(w, { extended: true, limit: 25 }) ?? [], TERM_WEIGHT);
    }
    let semantic = false;
    const vec = q ? this.deps.vectors?.() : undefined;
    if (vec && vec.index.size > 0) {
      try {
        const [qv] = await vec.embedder.embed([q], opts.signal, "query");
        if (qv) {
          const hits = vec.index.search(qv, 40, { filter: (id) => !hidden.has(id) });
          const sections = new Map<string, ReturnType<typeof pageSections>>();
          fuse(hits.map((h) => {
            let s = sections.get(h.pageID);
            if (!s) sections.set(h.pageID, (s = pageSections(this.store, h.pageID)));
            const sec = s[h.chunk];
            return { pageID: h.pageID, snippet: sec?.body ? flat(sec.body) : undefined, blockID: sec?.blockID };
          }), 1);
          semantic = true;
        }
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        // Modell nicht nutzbar: die Wortsuche trägt allein.
      }
    }

    // 2. Umfeld: innerhalb von `about` zählt stärker; ohne Anfrage ist das Umfeld selbst das Ergebnis.
    if (scope) {
      if (!q) for (const n of graph.neighbors(about!, 200, hidden)) score.set(n.id, EDGE_WEIGHT[n.kind] / RRF_K);
      else for (const [id, s] of score) score.set(id, scope.has(id) ? s * 2 : s * 0.5);
      if (q) score.delete(about!);
    }

    // 3. Ein Schritt über die Kanten der besten Treffer
    const ranked = [...score].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const via = new Map<string, { score: number; from: Set<string> }>();
    for (const [id, s] of ranked.slice(0, 8)) {
      for (const n of graph.neighbors(id, 12, hidden)) {
        if (n.id === about) continue;
        const v = via.get(n.id) ?? { score: 0, from: new Set<string>() };
        v.score += s * EDGE_WEIGHT[n.kind];
        v.from.add(id);
        via.set(n.id, v);
      }
    }
    // Wer schon Treffer ist, steigt durch seine Verbindungen; wer es nicht ist, wird „verbunden“, wenn ihn
    // mindestens zwei Treffer erreichen.
    for (const [id, v] of via) if (score.has(id)) score.set(id, score.get(id)! + v.score * 0.5);
    const final = [...score].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

    const memoryHits: RecallMemory[] = [];
    const pages: RecallItem[] = [];
    for (const [id, s] of final) {
      const m = memories.get(id);
      if (m) {
        if (memoryHits.length >= 8) continue;
        memoryHits.push({ ...m, score: s, aboutTitles: (m.about ?? []).filter((a) => this.live(a)).map((a) => titleOf(this.store, a) || "Untitled") });
        continue;
      }
      if (ids && id === ids.about) continue; // „About me“ liefert `about_me`
      if (pages.length >= limit) continue;
      const b = this.store.blocks.get(id)!;
      const location = pageLocation(this.store, id);
      const hit = best.get(id);
      pages.push({
        id, title: titleOf(this.store, id) || "Untitled", score: s, links: graph.describe(id, 3, hidden),
        ...(hit?.snippet ? { snippet: flat(hit.snippet) } : {}), ...(hit?.blockID ? { blockID: hit.blockID } : {}),
        ...(location ? { location } : {}), ...(b.parent.startsWith("d:") ? { row: true } : {}),
      });
    }
    const shown = new Set([...pages.map((p) => p.id), ...memoryHits.map((m) => m.id)]);
    const connected: RecallConnected[] = [...via]
      .filter(([id, v]) => !shown.has(id) && !score.has(id) && v.from.size >= 2 && !memories.has(id) && id !== ids?.about)
      .sort((a, b) => b[1].from.size - a[1].from.size || b[1].score - a[1].score || (a[0] < b[0] ? -1 : 1))
      .slice(0, 5)
      .map(([id, v]) => ({ id, title: titleOf(this.store, id) || "Untitled", via: [...v.from].filter((f) => shown.has(f)).map((f) => titleOf(this.store, f) || "Untitled").slice(0, 4) }))
      .filter((c) => c.via.length >= 2);

    return { query: q, ...(about ? { about: { id: about, title: titleOf(this.store, about) || "Untitled" } } : {}), memories: memoryHits, pages, connected, semantic };
  }

  /** Knapper Text für das Modell: volle IDs nur bei Treffern, Nachbarn nur als Titel. */
  static format(r: RecallResult): string {
    const out: string[] = [];
    if (r.memories.length) {
      out.push("## Memories");
      for (const m of r.memories) {
        const body = m.body.split("\n").filter((l) => l.trim() && !/^(About|Source|Replaces):/.test(l.trim())).join(" ");
        out.push(`- ${m.title} (${m.kind}${m.aboutTitles.length ? `; about: ${m.aboutTitles.join(", ")}` : ""}; id: ${m.id})${body && body !== m.title ? `\n  ${flat(body, 300)}` : ""}`);
      }
    }
    if (r.pages.length) {
      out.push(r.about ? `## Around “${r.about.title}”` : "## Pages");
      r.pages.forEach((p, i) => {
        out.push(`${i + 1}. ${p.title}${p.location ? ` — ${p.location}` : ""}${p.row ? " (row)" : ""} (id: ${p.id})`);
        if (p.snippet) out.push(`   “${p.snippet}”${p.blockID ? ` [block: ${p.blockID}]` : ""}`);
        if (p.links.length) out.push(`   ${p.links.join(" · ")}`);
      });
    }
    if (r.connected.length) {
      out.push("## Connected");
      for (const c of r.connected) out.push(`- ${c.title} (id: ${c.id}) — linked with ${c.via.join(", ")}`);
    }
    if (out.length === 0) return r.query ? `Nothing found for “${r.query}”.` : "Nothing found.";
    if (!r.semantic && r.query) out.push("", "(Matched by words and links; search by meaning is off.)");
    return out.join("\n");
  }
}
