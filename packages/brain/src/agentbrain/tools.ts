// BSD-163: Werkzeuge des Agent Brain für Engines – Skill laden (progressive Offenlegung: nur Name + Beschreibung
// stehen im Prompt, die volle SKILL.md holt das Modell bei Bedarf), Seite mit Block-IDs lesen (zum Zitieren),
// Suche nach Bedeutung, verwandte Seiten, Memories nachschlagen. Alle nur lesend. Dazu `combineToolHosts`, das
// mehrere Werkzeug-Quellen zu einer macht (Workspace-Werkzeuge + diese).
import { isPageLike, isTrashed, MarkdownExporter, titleOf, type Block, type JSONValue, type WorkspaceStore } from "@based/core";
import type { ToolHost, ToolResult } from "../engine.js";
import type { ToolSpec } from "../messages.js";
import { EmbeddingCache, relatedByMeaning, rerankByMeaning, type LocalSemanticIndex, type SemanticHit, type TextEmbedder } from "../semantic/index.js";
import type { AgentBrain } from "./store.js";

const obj = (properties: Record<string, JSONValue>, required: string[] = []): JSONValue => ({ type: "object", properties, required, additionalProperties: false });

export const BRAIN_TOOL_SPECS: ToolSpec[] = [
  { name: "load_skill", description: "Load the full instructions of a skill (by name) before following it.", inputSchema: obj({ name: { type: "string" } }, ["name"]) },
  {
    name: "read_page_blocks",
    description: "A page's blocks with their ids ([block:<id>] before each block) — use these ids to cite with [[block:<id>]].",
    inputSchema: obj({ page_id: { type: "string", description: "Page id (UUID)" } }, ["page_id"]),
  },
  { name: "semantic_search", description: "Find pages by meaning (local index), with the best-matching passage.", inputSchema: obj({ query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 30 } }, ["query"]) },
  { name: "related_pages", description: "Pages related to a page (local index).", inputSchema: obj({ page_id: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, ["page_id"]) },
  { name: "recall_memories", description: "What Based remembers about the user (About me and saved memories), optionally filtered by a query.", inputSchema: obj({ query: { type: "string" } }) },
];

export const BRAIN_TOOL_LABELS: Record<string, string> = {
  load_skill: "Load skill", read_page_blocks: "Read page", semantic_search: "Search by meaning", related_pages: "Related pages", recall_memories: "Recall memories",
};

export class BrainTools {
  private vectors = new EmbeddingCache();

  /**
   * `embedder` (BSD-231 Teil 3b): lokales Embedding-Modell, wenn eingeschaltet und geladen – dann ordnet `callAsync`
   * die Treffer von semantic_search nach Bedeutung neu; ohne bleibt es beim TF-IDF-Index.
   */
  constructor(private readonly store: WorkspaceStore, private readonly brain: AgentBrain, private readonly semantic: () => LocalSemanticIndex,
    private readonly embedder?: () => Promise<TextEmbedder | undefined>) {}

  /**
   * Verwandte Seiten (BSD-231 Teil 3b): mit Modell nach Bedeutung neu geordnet (Kandidaten aus TF-IDF), sonst bzw. bei
   * einem Fehler TF-IDF. Für das Werkzeug related_pages und die Anzeige „Related pages“.
   */
  async relatedPages(pageID: string, limit = 5): Promise<SemanticHit[]> {
    const index = this.semantic();
    const plain = () => index.related(pageID, limit).filter((h) => this.live(h.pageID));
    if (!this.embedder) return plain();
    try {
      const embedder = await this.embedder();
      if (!embedder) return plain();
      const candidates = index.related(pageID, Math.max(30, limit * 4), 0).filter((h) => this.live(h.pageID)).map((h) => ({ pageID: h.pageID, chunks: index.chunks(h.pageID) }));
      if (this.vectors.model !== embedder.id) this.vectors = new EmbeddingCache(4000, embedder.id);
      return await relatedByMeaning(embedder, index.chunks(pageID), candidates, { limit, cache: this.vectors });
    } catch {
      return plain();
    }
  }

  /** Wie `call`, aber semantic_search/related_pages mit dem Embedding-Modell (falls vorhanden; bei Fehlern TF-IDF). */
  async callAsync(name: string, input: JSONValue): Promise<ToolResult> {
    if (name === "related_pages" && this.embedder) {
      const a = (input !== null && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, JSONValue>;
      const hits = await this.relatedPages(typeof a.page_id === "string" ? a.page_id : "", typeof a.limit === "number" ? Math.max(1, Math.floor(a.limit)) : 5);
      return { text: hits.length ? hits.map((h) => `- ${titleOf(this.store, h.pageID)} (id: ${h.pageID})`).join("\n") : "No related pages found.", isError: false };
    }
    if (name !== "semantic_search" || !this.embedder) return this.call(name, input);
    const a = (input !== null && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, JSONValue>;
    const query = typeof a.query === "string" ? a.query : "";
    const limit = typeof a.limit === "number" ? Math.max(1, Math.floor(a.limit)) : 8;
    try {
      const embedder = await this.embedder();
      if (!embedder) return this.call(name, input);
      const index = this.semantic();
      const candidates = index.search(query, Math.max(40, limit * 4)).filter((h) => this.live(h.pageID)).map((h) => ({ pageID: h.pageID, chunks: index.chunks(h.pageID) }));
      if (this.vectors.model !== embedder.id) this.vectors = new EmbeddingCache(4000, embedder.id);
      const hits = await rerankByMeaning(embedder, query, candidates, { limit, cache: this.vectors });
      return { text: hits.length ? hits.map((h) => `- ${titleOf(this.store, h.pageID)} (id: ${h.pageID}, score ${h.score.toFixed(2)})\n  ${h.snippet}`).join("\n") : "No pages found.", isError: false };
    } catch {
      return this.call(name, input);
    }
  }

  get specs(): ToolSpec[] {
    return BRAIN_TOOL_SPECS;
  }

  call(name: string, input: JSONValue): ToolResult {
    const a = (input !== null && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, JSONValue>;
    const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
    const num = (k: string, d: number) => (typeof a[k] === "number" ? Math.max(1, Math.floor(a[k] as number)) : d);
    try {
      switch (name) {
        case "load_skill": {
          const s = this.brain.skillByName(str("name"));
          if (!s) return { text: `No skill named “${str("name")}”. Skills: ${this.brain.skills(true).map((x) => x.name).join(", ") || "(none)"}`, isError: true };
          return { text: `# Skill: ${s.name}\n${s.description}\n\n${s.body}`, isError: false };
        }
        case "read_page_blocks": {
          const id = str("page_id");
          const page = this.store.blocks.get(id);
          if (!page || !isPageLike(page) || isTrashed(this.store, id)) return { text: `No page with id ${id}`, isError: true };
          return { text: `# ${titleOf(this.store, id)}\n\n${pageWithBlockIDs(this.store, id)}`, isError: false };
        }
        case "semantic_search": {
          const hits = this.semantic().search(str("query"), num("limit", 8)).filter((h) => this.live(h.pageID));
          return { text: hits.length ? hits.map((h) => `- ${titleOf(this.store, h.pageID)} (id: ${h.pageID}, score ${h.score.toFixed(2)})\n  ${h.snippet}`).join("\n") : "No pages found.", isError: false };
        }
        case "related_pages": {
          const hits = this.semantic().related(str("page_id"), num("limit", 5)).filter((h) => this.live(h.pageID));
          return { text: hits.length ? hits.map((h) => `- ${titleOf(this.store, h.pageID)} (id: ${h.pageID})`).join("\n") : "No related pages found.", isError: false };
        }
        case "recall_memories": {
          const q = str("query").toLowerCase();
          const mems = this.brain.memories().filter((m) => !q || (m.title + " " + m.body).toLowerCase().split(/\s+/).some((w) => q.split(/\s+/).some((x) => x.length > 2 && w.includes(x))));
          const about = this.brain.about().trim();
          const out = [about ? `# About the user\n${about}` : "", mems.length ? "# Memories\n" + mems.slice(0, 12).map((m) => `## ${m.title} (${m.kind})\n${m.body}`).join("\n") : ""].filter(Boolean).join("\n\n");
          return { text: out || "Nothing saved about the user yet.", isError: false };
        }
      }
      return { text: `Unknown tool ${name}`, isError: true };
    } catch (e) {
      return { text: `Tool ${name} failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  }

  private live(id: string) {
    const b = this.store.blocks.get(id);
    return !!b && isPageLike(b) && !isTrashed(this.store, id);
  }
}

/** Oberste Blöcke einer Seite mit IDs, zum Zitieren (Swift `Citations.pageWithBlockIDs`). */
export function pageWithBlockIDs(store: WorkspaceStore, pageID: string): string {
  const ex = new MarkdownExporter(store);
  return store.children("b:" + pageID).map((k) => store.blocks.get(k)).filter((b): b is Block => !!b && b.trashedAt === undefined && !isPageLike(b))
    .map((b) => `[block:${b.id}]\n${ex.exportBlocks([b], 0).replace(/^\n+|\n+$/g, "")}`).join("\n\n");
}

/** Mehrere Werkzeug-Quellen als eine (der erste Host, der den Namen kennt, führt aus). */
export function combineToolHosts(...hosts: readonly ToolHost[]): ToolHost {
  const owner = (name: string) => hosts.find((h) => h.specs.some((s) => s.name === name));
  return {
    get specs() {
      const seen = new Set<string>();
      const out: ToolSpec[] = [];
      for (const h of hosts) for (const s of h.specs) if (!seen.has(s.name)) { seen.add(s.name); out.push(s); }
      return out;
    },
    isWrite: (name) => owner(name)?.isWrite(name) ?? true,
    call: (name, input, signal) => {
      const h = owner(name);
      return h ? h.call(name, input, signal) : Promise.resolve({ text: `Unknown tool ${name}`, isError: true });
    },
  };
}
