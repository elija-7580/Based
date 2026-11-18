// Der Workspace für MCP: hält den Suchindex, den Relationen-Graphen und das Agent Brain über dem Store des Servers
// und baut daraus die Werkzeug-Schicht (`WorkspaceTools`, @based/brain). Alle Werkzeuge leben dort – hier steht keines
// (docs/agent-parity.md, Regel 1). Jede Änderung ist eine lokale Änderung des Servers und kommt per Sync v2 bei den
// Geräten an.
import { attachSearchIndex, isPageLike, isTrashed, titleOf, type JSONValue, type SearchIndex, type WorkspaceStore } from "@based/core";
import { AgentBrain, PAGE_URI, Recall, RelationGraph, ToolError, WorkspaceTools, type RecallDeps, type ToolCtx, type ToolDef } from "@based/brain";
import type { AssetStore } from "./assets.js";
import { assetFileInfo } from "./board-files.js";
import { fileTools, LinkPreviews, prepareForTool } from "./file-tools.js";
import { exportTools } from "./export-tools.js";

export { PAGE_URI, ToolError };

export class Pages {
  private search: { index: SearchIndex; dispose: () => void } | undefined;

  private relations: { graph: RelationGraph; dispose: () => void } | undefined;
  private brainRef: AgentBrain | undefined;
  /** Je Art des Zugangs eine Werkzeug-Instanz (über alle Anfragen: `undo_last` kennt den letzten Schritt je Client). */
  private readonly toolSets = new Map<string, WorkspaceTools>();
  /**
   * BSD-541: Vektor-Index und Modell für die Suche nach Bedeutung – setzt der Server, wenn das lokale Modell
   * eingeschaltet und geladen ist (`BrainIndex`). Ohne bleibt `recall` bei Wörtern und Nachbarn.
   */
  vectors: RecallDeps["vectors"];
  /** Link-Vorschauen für Bookmarks, die Agenten anlegen (Tests setzen einen eigenen Holer). */
  previews = new LinkPreviews();

  constructor(readonly store: WorkspaceStore) {}

  dispose() {
    for (const t of this.toolSets.values()) t.dispose();
    this.toolSets.clear();
    this.search?.dispose();
    this.search = undefined;
    this.relations?.dispose();
    this.relations = undefined;
  }

  /** Relationen, Erwähnungen und Hierarchie als Graph (folgt dem Store, wird beim ersten Gebrauch gebaut). */
  get graph(): RelationGraph {
    return (this.relations ??= RelationGraph.attach(this.store)).graph;
  }

  get brain(): AgentBrain {
    return (this.brainRef ??= new AgentBrain(this.store));
  }

  /** Abruf für Agenten: Wörter, Bedeutung (falls geladen) und Nachbarn in einer Antwort. */
  recall(): Recall {
    return new Recall(this.store, this.brain, { search: () => this.index, graph: () => this.graph, vectors: () => this.vectors?.() });
  }

  private get index(): SearchIndex {
    return (this.search ??= attachSearchIndex(this.store)).index;
  }

  /**
   * Die Werkzeuge für MCP. `assets`: Dateispeicher (Maße und PDF-Seiten aus den Bytes, `upload_file`); `localFiles`:
   * der Client läuft auf diesem Rechner (stdio) und darf Pfade nennen.
   */
  /** Werkzeuge zum Teilen (nur wo es einen ShareService gibt: HTTP-Server). Vor dem ersten `tools()` setzen. */
  shareTools: ((ctx: ToolCtx) => ToolDef[]) | undefined;

  tools(opts: { assets?: AssetStore | undefined; localFiles?: boolean | undefined } = {}): WorkspaceTools {
    const key = opts.assets ? (opts.localFiles ? "local" : "remote") : "plain";
    let t = this.toolSets.get(key);
    if (!t) {
      const assets = opts.assets;
      t = new WorkspaceTools(this.store, {
        index: () => this.index, graph: () => this.graph, brain: () => this.brain, vectors: () => this.vectors?.(),
        ...(assets ? { fileInfo: (ref: string) => assetFileInfo(assets, ref), extra: (ctx: ToolCtx) => [...fileTools(assets, opts.localFiles === true)(ctx), ...exportTools(assets, opts.localFiles === true)(ctx), ...(this.shareTools?.(ctx) ?? [])], before: (name: string, input: JSONValue) => prepareForTool(assets, this.store, this.previews)(name, input), linkPreview: (url: string) => this.previews.get(url) } : {}),
      });
      this.toolSets.set(key, t);
    }
    return t;
  }

  title(id: string): string {
    return titleOf(this.store, id);
  }

  /** Seite als Markdown (für die Ressource based://page/<id>). */
  read(id: string): string {
    const r = this.tools().callSync("read_page", { id });
    if (r.isError) throw new Error(r.text);
    return r.text;
  }

  // MARK: Kurzwege für den Server selbst und Tests – über dieselben Werkzeuge, keine eigene Logik.

  private run(name: string, input: Record<string, string>): string {
    const r = this.tools().callSync(name, input);
    if (r.isError) throw new ToolError(r.text);
    return r.text;
  }

  /** Neue Seite aus Markdown; gibt die ID zurück. */
  create(opts: { title?: string | undefined; markdown?: string | undefined; parent?: string | undefined }): string {
    const text = this.run("create_page", Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as Record<string, string>);
    return /\(id: ([^)]+)\)/.exec(text)![1]!;
  }

  append(id: string, markdown: string): void {
    this.run("append_markdown", { id, markdown });
  }

  /** Treffer wie `search`, als Daten. */
  searchPages(query: string, limit = 20): { id: string; title: string }[] {
    const out: { id: string; title: string }[] = [];
    for (const h of this.tools().ctx.search(query, limit)) {
      if (out.length >= limit) break;
      if (out.some((x) => x.id === h.pageID) || !isPageLike(this.store.blocks.get(h.pageID)) || isTrashed(this.store, h.pageID)) continue;
      out.push({ id: h.pageID, title: this.title(h.pageID) });
    }
    return out;
  }

  /** Alle Seiten außerhalb des Papierkorbs (für die Ressourcenliste). */
  allPages(limit: number): string[] {
    const out: string[] = [];
    for (const b of this.store.blocks.values()) {
      if (out.length >= limit) break;
      if (isPageLike(b) && !isTrashed(this.store, b.id)) out.push(b.id);
    }
    return out;
  }
}
