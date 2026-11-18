// Agent-Parität (docs/agent-parity.md): DIE Werkzeug-Schicht über dem Workspace. Jedes Werkzeug ist hier genau einmal
// gebaut (Dateien unter tools/), ausgeführt auf dem WorkspaceStore. Der MCP-Server (apps/server/src/mcp.ts) meldet
// sie nur an und reicht durch; Baseds eigene Agenten (worker/chat.ts, agent-engine.ts) benutzen dieselbe Instanz-Art.
//
// Regeln, die hier für alle gelten (nicht je Werkzeug):
// - Argumente werden vor dem Lauf gegen das Schema geprüft; die Meldung sagt, was richtig wäre.
// - Jedes synchrone Schreib-Werkzeug ist EINE Transaktion (`store.atomic`): ein Undo-Schritt, alles oder nichts –
//   auch wenn es intern mehrere Kern-Funktionen aufruft. Wirft der Rumpf, ist nichts geschrieben.
// - Geschrieben wird als Agent (BSD-522: Herkunft „ai“/„mixed“, Autor je Block).
// - `undo_last` nimmt den letzten eigenen Schreib-Aufruf zurück (genau diesen Schritt, auch wenn danach der Mensch
//   weitergeschrieben hat; was seither geändert wurde, bleibt).
import {
  attachSearchIndex, isPageLike, isTrashed, MarkdownExporter, MarkdownImporter, markdownWithDateMentions, pageFormat, titleOf,
  type Author, type Block, type BoardFileInfo, type BookmarkMeta, type JSONValue, type SearchFilters, type SearchIndex, type WorkspaceStore,
} from "@based/core";
import type { ToolHost, ToolResult } from "./engine.js";
import type { ToolSpec } from "./messages.js";
import { AgentBrain } from "./agentbrain/store.js";
import { Recall, type RecallDeps } from "./recall/recall.js";
import { RelationGraph } from "./recall/graph.js";
import { checkArgs, obj, PAGE_URI, ToolError, type Args, type ToolDef, type ToolGroup } from "./tools/base.js";
import { createToolRequest, resolveToolRequest, runApprovedRequests } from "./tools/requests.js";
import { historyTools, type HistoryHost } from "./tools/history.js";
import { meetingTools } from "./tools/meetings.js";
import { gatewayTools } from "./tools/gateway.js";
export { MORE_TOOLS, RUN_TOOL, unwrap } from "./tools/gateway.js";
import type { ToolCtx } from "./tools/context.js";
import { Databases } from "./tools/databases.js";
import { pageTools } from "./tools/pages.js";
import { blockTools } from "./tools/blocks.js";
import { boardTools } from "./tools/boards.js";
import { databaseTools } from "./tools/database-tools.js";
import { brainTools } from "./tools/brain-tools.js";
import { agentTools } from "./tools/agent-tools.js";
import { guideTools } from "./tools/guide.js";
import { workspaceTools } from "./tools/workspace.js";

export { PAGE_URI, ToolError, putMarkdownBlocks, checkArgs, type Args, type ToolDef, type ToolGroup, type ToolRunContext } from "./tools/base.js";
export type { ToolCtx } from "./tools/context.js";
export type { HistoryHost } from "./tools/history.js";
export { agentsWorkFreely } from "./tools/requests.js";
export { Databases, type ViewArgs } from "./tools/databases.js";
export { GUIDE } from "./tools/guide.js";
export * from "./tools/runs.js";

export const TOOL_GROUPS: readonly ToolGroup[] = ["pages", "blocks", "boards", "files", "databases", "brain", "agents"];

/** Was in der kurzen Werkzeugliste steht: suchen, lesen, Seiten schreiben, Zeilen, Gedächtnis, Undo. */
const CORE_TOOLS: ReadonlySet<string> = new Set([
  "based_guide", "search", "read_page", "list_pages", "create_page", "append_markdown", "update_page", "read_blocks", "edit_blocks",
  "list_databases", "database_schema", "query_database", "add_row", "update_row", "recall", "remember", "undo_last",
]);

export interface WorkspaceToolsOptions {
  /** Eigene Suche (z. B. der Index, den der Store-Host ohnehin pflegt). Ohne: `index` bzw. ein eigener Volltextindex. */
  search?: (query: string, limit: number, filters?: SearchFilters) => { pageID: string; snippet?: string | undefined }[];
  /** Der Suchindex des Hosts (auch für `recall`). Ohne: eigener Index, beim ersten Gebrauch gebaut. */
  index?: () => SearchIndex;
  /** Relationen-Graph und Agent Brain des Hosts (ohne: eigene, beim ersten Gebrauch). */
  graph?: () => RelationGraph;
  brain?: () => AgentBrain;
  /** Vektor-Index und Modell für die Suche nach Bedeutung, wenn eingeschaltet und geladen. */
  vectors?: RecallDeps["vectors"];
  /**
   * BSD-522: Als wer die Werkzeuge schreiben (Herkunft: Seite „ai“/„mixed“, Autor je Block). Ohne: wer gerade am Store
   * eingetragen ist (z. B. der MCP-Client), sonst „Based agent“ – diese Werkzeuge benutzen immer Agenten.
   */
  actor?: Author;
  /**
   * Was der Host aus den Bytes einer Datei weiß (Art, Größe, Bildmaße, PDF-Seiten) – ergänzt, was die Records kennen,
   * damit ein Agent Dateien aufs Board legen kann. Ohne: nur das Wissen der Records.
   */
  fileInfo?: (ref: string) => Partial<BoardFileInfo> | undefined;
  /**
   * Was der Host vor einem Aufruf erledigen muss und wofür er warten muss (z. B. PDFs im Dateispeicher vermessen,
   * bevor `draw_board` sie anordnet). Läuft nur über `call()`; die Werkzeuge selbst bleiben synchron und eine Transaktion.
   */
  before?: (name: string, input: JSONValue) => Promise<void> | void;
  /** Vorschau eines Links (Titel, Beschreibung, Bild), wenn der Host sie in `before` geholt hat. */
  linkPreview?: (url: string) => BookmarkMeta | undefined;
  /** Versionsverlauf des Hosts (in der App der Store-Worker). Ohne: keine Verlaufs-Werkzeuge. */
  history?: () => HistoryHost | undefined;
  /** Nur diese Bereiche anbieten (ohne: alle). */
  groups?: readonly ToolGroup[];
  /**
   * Werkzeuge, die nur dieser Host bauen kann (Netz, Dateisystem, Dateispeicher), z. B. `upload_file` am Server. Sie
   * stehen in derselben Liste und laufen durch dieselbe Prüfung.
   */
  extra?: (ctx: ToolCtx) => ToolDef[];
}

const DEFAULT_ACTOR: Author = { kind: "agent", name: "Based agent" };

export class WorkspaceTools implements ToolHost {
  private readonly defs = new Map<string, ToolDef>();
  private ownIndex: ReturnType<typeof attachSearchIndex> | undefined;
  private ownGraph: ReturnType<typeof RelationGraph.attach> | undefined;
  private ownBrain: AgentBrain | undefined;
  /**
   * Undo-Schritt des letzten Schreib-Aufrufs je Agent (für `undo_last`) mit dem Namen des Werkzeugs. Je Agent, weil
   * sich am Server mehrere MCP-Clients diese Instanz teilen: keiner nimmt den Schritt eines anderen zurück.
   */
  private readonly lastWrite = new Map<string, { step: number; tool: string }>();
  readonly ctx: ToolCtx;
  /** Undo-Kennungen gelten nur für diesen Lauf der App (die Schrittnummern des Stores beginnen danach neu). */
  private readonly undoSession = Math.random().toString(36).slice(2, 10);
  get undoSessionID(): string { return this.undoSession; }
  private readonly gateway = new Map(gatewayTools(() => this.all).map((d) => [d.spec.name, d] as const));

  constructor(readonly store: WorkspaceStore, private readonly opts: WorkspaceToolsOptions = {}) {
    this.ctx = this.context();
    const groups = opts.groups ? new Set(opts.groups) : undefined;
    const all = [...guideTools(), ...pageTools(this.ctx), ...(opts.history ? historyTools(this.ctx, opts.history) : []), ...workspaceTools(this.ctx), ...meetingTools(this.ctx), ...blockTools(this.ctx), ...boardTools(this.ctx), ...databaseTools(this.ctx), ...brainTools(this.ctx), ...agentTools(this.ctx), ...(opts.extra?.(this.ctx) ?? []), this.undoTool()];
    for (const d of all) {
      if (groups && !groups.has(d.group)) continue;
      if (this.defs.has(d.spec.name)) throw new Error(`Tool ${d.spec.name} is defined twice`);
      this.defs.set(d.spec.name, CORE_TOOLS.has(d.spec.name) ? { ...d, core: true } : d);
    }
  }

  dispose() {
    this.ownIndex?.dispose();
    this.ownIndex = undefined;
    this.ownGraph?.dispose();
    this.ownGraph = undefined;
  }

  get specs(): ToolSpec[] {
    return [...this.defs.values()].map((d) => d.spec);
  }

  /** Die Definition eines Werkzeugs (Bereich, schreibend, zerstörend) – für Hosts, die es anmelden. */
  def(name: string): ToolDef | undefined {
    return this.defs.get(name) ?? this.gateway.get(name);
  }

  /**
   * Die kurze Werkzeugliste: Kernwerkzeuge plus `more_tools` und `run_tool` (tools/gateway.ts). Aufrufbar bleibt
   * jedes Werkzeug; `run_tool` packt der Host mit `unwrap` aus, bevor er Rechte prüft.
   */
  get compact(): ToolDef[] {
    return [...this.all.filter((d) => d.core), ...this.gateway.values()];
  }

  get all(): ToolDef[] {
    return [...this.defs.values()];
  }

  /**
   * Als Werkzeug-Host für eine Engine mit kurzer Liste: alle Werkzeuge sind aufrufbar, das Modell sieht `listed`
   * (Kern + more_tools/run_tool).
   */
  host(): { specs: ToolSpec[]; listed: string[]; isWrite: (name: string) => boolean; call: WorkspaceTools["call"] } {
    const compact = this.compact.map((d) => d.spec);
    return {
      specs: [...this.specs, ...compact.filter((c) => !this.defs.has(c.name))],
      listed: compact.map((s) => s.name),
      isWrite: (name) => this.isWrite(name),
      call: (name, input, signal, actor) => this.call(name, input, signal, actor),
    };
  }

  isWrite(name: string): boolean {
    return this.def(name)?.write ?? true;
  }

  isDestructive(name: string): boolean {
    return this.defs.get(name)?.destructive === true;
  }

  /** Jedes Werkzeug; `actor`: als wer geschrieben wird (sonst wie in den Optionen). */
  async call(name: string, input: JSONValue, _signal?: AbortSignal, actor?: Author): Promise<ToolResult> {
    if (this.opts.before && this.defs.has(name)) {
      try {
        await this.opts.before(name, input);
      } catch (e) {
        return this.failed(name, e);
      }
    }
    const started = this.start(name, input, actor);
    if ("text" in started) return started;
    try {
      const text = await started.pending;
      return { text, isError: false };
    } catch (e) {
      return this.failed(name, e);
    }
  }

  /** Synchron (der Store ist es auch); Fehler eines Werkzeugs werden zur Antwort, nie zu einem halben Schreiben. */
  callSync(name: string, input: JSONValue, actor?: Author): ToolResult {
    const started = this.start(name, input, actor);
    if ("text" in started) return started;
    // Nur wenige Werkzeuge warten (Suche nach Bedeutung, Dateien); die gehen über `call`.
    void started.pending.catch(() => undefined);
    return { text: `Tool ${name} needs to wait for its result; this host can only run it with call().`, isError: true };
  }

  /**
   * Einen Aufruf ausführen, dem ein Mensch in Based zugestimmt hat (Rückfrage aus der Inbox). Nicht für Agenten
   * erreichbar: kein Werkzeug ruft das auf.
   */
  callApproved(name: string, input: JSONValue, actor?: Author): ToolResult {
    const started = this.start(name, input, actor, true);
    if ("text" in started) return started;
    void started.pending.catch(() => undefined);
    return { text: `Tool ${name} can't run from a request.`, isError: true };
  }

  /**
   * Antwort auf eine Rückfrage (Allow/Deny in Based). Kennt dieser Host das Werkzeug nicht (z. B. Teilen: das kann
   * nur der Server), wird die Zustimmung am Lauf vermerkt; der Host, der es kennt, führt es aus (`runApprovedRequests`).
   */
  resolveRequest(runID: string, ok: boolean): ToolResult {
    try {
      return { text: resolveToolRequest(this.store, runID, ok, (n, i, a) => this.callApproved(n, i, a), (n) => this.defs.has(n)), isError: false };
    } catch (e) {
      return this.failed("resolve_request", e);
    }
  }

  /**
   * „Undo“ des Menschen an einer Agenten-Aktion: genau diesen Schritt zurücknehmen, auch wenn danach weitergearbeitet
   * wurde. Was seither jemand an denselben Stellen geändert hat, bleibt. Geht es nicht mehr, sagt die Antwort warum.
   */
  undoByToken(token: string): ToolResult {
    const [session, seq] = token.split(":");
    const gone = "This can't be undone here any more (Based was restarted since). The page's version history still has the earlier state.";
    if (session !== this.undoSession || !/^\d+$/.test(seq ?? "")) return { text: gone, isError: true };
    if (this.store.isReadOnly) return { text: "The workspace is read-only right now. Nothing was changed.", isError: true };
    const r = this.store.undoStep(Number(seq));
    if (r.name === null) return { text: "This was already undone, or it is too far back. The page's version history still has the earlier state.", isError: true };
    if (r.applied === 0) return { text: "Nothing was undone: everything this step touched has been edited since. The page's version history still has the earlier state.", isError: true };
    return { text: r.skipped ? `Undone, except ${r.skipped} place${r.skipped === 1 ? "" : "s"} edited since.` : "Undone.", isError: false };
  }

  /** Zugestimmte Rückfragen ausführen, deren Werkzeug dieser Host hat. Gibt zurück, wie viele liefen. */
  runApprovedRequests(): number {
    return runApprovedRequests(this.store, (n, i, a) => this.callApproved(n, i, a), (n) => this.defs.has(n));
  }

  private failed(name: string, e: unknown): ToolResult {
    if (e instanceof ToolError) return { text: e.message, isError: true };
    return { text: `Tool ${name} failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }

  /** Prüfen und laufen lassen: fertige Antwort, oder das Promise eines wartenden Werkzeugs. */
  private start(name: string, input: JSONValue, given: Author | undefined, approved = false): ToolResult | { pending: Promise<string> } {
    const def = this.def(name);
    if (!def) return { text: `Unknown tool ${name}`, isError: true };
    try {
      const args = checkArgs(def, input);
      const actor = given ?? this.opts.actor ?? this.store.actor ?? DEFAULT_ACTOR;
      if (!def.write) {
        const out = def.run(args, { actor });
        return typeof out === "string" ? { text: out, isError: false } : { pending: out };
      }
      if (this.store.isReadOnly) throw new ToolError("The workspace is read-only right now (saving failed). Nothing was changed.");
      // Rückfrage statt Ausführung: nur `callApproved` (Knopf in Based) führt so ein Werkzeug wirklich aus.
      const question = def.ask && !approved ? def.ask(args) : undefined;
      if (question !== undefined) return { text: createToolRequest(this.store, { name, input: args as JSONValue, actor, title: question }), isError: false };
      // Wartende Schreib-Werkzeuge (Netz, Dateien) schreiben über `ctx.callSync` – jeder dieser Schritte ist eine Transaktion.
      if (def.wait) return { pending: Promise.resolve().then(() => def.run(args, { actor })) };
      const revision = this.store.revision;
      const before = this.store.lastUndoStep;
      const text = this.store.withActor(actor, () => this.store.atomic(`Agent: ${name.replace(/_/g, " ")}`, () => {
        const out = def.run(args, { actor });
        if (typeof out !== "string") throw new Error(`Tool ${name} writes and waits: mark it with wait`);
        return out;
      }));
      // Ein Schreiben, das der Store abgewiesen hat (schreibgeschützt), darf nicht als Erfolg gemeldet werden.
      if (this.store.isReadOnly && this.store.revision === revision) throw new ToolError("Saving failed; nothing was changed.");
      const step = this.store.lastUndoStep;
      const fresh = name !== "undo_last" && step !== undefined && step !== before;
      if (fresh) this.lastWrite.set(actor.name, { step, tool: name });
      return fresh ? { text, isError: false, undo: `${this.undoSession}:${step}` } : { text, isError: false };
    } catch (e) {
      return this.failed(name, e);
    }
  }

  private undoTool(): ToolDef {
    return {
      group: "pages", write: true,
      spec: {
        name: "undo_last",
        description: "Take back your last change in this workspace (the last writing tool call you made here) – exactly that step, even if the user edited something else since. What someone changed afterwards in the same places stays as it is.",
        inputSchema: obj({}),
      },
      run: (_a, { actor }) => {
        const last = this.lastWrite.get(actor.name);
        if (!last) throw new ToolError("There is nothing of yours to undo here.");
        const r = this.store.undoStep(last.step);
        this.lastWrite.delete(actor.name);
        if (r.name === null) throw new ToolError(`Your last change (${last.tool}) can't be undone any more.`);
        if (r.applied === 0) throw new ToolError(`Your last change (${last.tool}) was not undone: everything it touched has been edited since.`);
        return `Undid ${last.tool} (${r.applied} record${r.applied === 1 ? "" : "s"} restored${r.skipped ? `, ${r.skipped} left as edited since` : ""}).`;
      },
    };
  }

  // MARK: Gemeinsame Helfer für die Werkzeug-Dateien

  private index(): SearchIndex {
    return this.opts.index?.() ?? (this.ownIndex ??= attachSearchIndex(this.store)).index;
  }

  private context(): ToolCtx {
    const store = this.store;
    const page = (id: string, allowTrashed = false): Block => {
      const b = store.blocks.get(id);
      if (!b || !isPageLike(b)) throw new ToolError(`No page with id ${id}`);
      if (!allowTrashed && isTrashed(store, id)) throw new ToolError(`Page ${id} is in the Trash (restore_page brings it back)`);
      return b;
    };
    const writable = (id: string): Block => {
      const b = page(id);
      if (pageFormat(store, id).locked) throw new ToolError(`“${titleOf(store, id) || "Untitled"}” is locked, so its content can't be changed. The user locked it on purpose; unlock it (update_page with locked: false) only if they ask.`);
      return b;
    };
    const graph = () => this.opts.graph?.() ?? (this.ownGraph ??= RelationGraph.attach(store)).graph;
    const brain = () => this.opts.brain?.() ?? (this.ownBrain ??= new AgentBrain(store));
    return {
      store,
      databases: new Databases(store),
      page,
      writable,
      title: (id) => titleOf(store, id) || "Untitled",
      line: (id) => `- ${titleOf(store, id) || "Untitled"} (id: ${id})`,
      importer: () => new MarkdownImporter({
        // Links auf based://page/<id> oder eine bekannte Seiten-ID werden Erwähnungen.
        resolveLink: (target) => {
          const id = target.startsWith(PAGE_URI) ? target.slice(PAGE_URI.length) : target;
          return isPageLike(store.blocks.get(id)) ? id : undefined;
        },
      }),
      markdown: (md) => markdownWithDateMentions(this.ctx.importer().parse(md)),
      linkPreview: (url) => this.opts.linkPreview?.(url),
      exporter: () => new MarkdownExporter(store, { pageLink: (id) => ({ title: titleOf(store, id), url: PAGE_URI + id }) }),
      search: (query, limit, filters) => {
        if (this.opts.search) return this.opts.search(query, limit, filters);
        // wie Quick Find: verteilte Begriffe, Tippfehler, Zeilen über Relationen
        return this.index().run(query, { ...(filters && Object.keys(filters).length ? { filters } : {}), limit: limit * 2, extended: true }) ?? [];
      },
      fileInfo: (ref, known) => {
        const host = this.opts.fileInfo?.(ref);
        if (!known && !host) return undefined;
        const out: BoardFileInfo = { ref, name: known?.name || host?.name || `file-${ref.slice(-64, -56)}`, mime: host?.mime || known?.mime || "", size: host?.size || known?.size || 0 };
        const w = host?.width ?? known?.width, h = host?.height ?? known?.height;
        if (w && h) { out.width = w; out.height = h; }
        const pages = host?.pages ?? known?.pages;
        if (pages?.length) out.pages = pages;
        return out;
      },
      graph,
      brain,
      recall: () => new Recall(store, brain(), { search: () => this.index(), graph, vectors: () => this.opts.vectors?.() }),
      callSync: (name: string, input: Args, actor?: Author) => this.callSync(name, input, actor),
    };
  }
}
