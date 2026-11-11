// BSD-317: Ablauf des Hybrid-Imports. Struktur zuerst (API), dann Inhalt im Hintergrund (ZIP, wo nötig API), zuletzt
// bearbeitete Seiten zuerst; fortsetzbar und für den Delta-Abgleich wiederverwendbar.
//
// Der Ablauf kennt den Store nicht direkt, sondern ein `HybridTarget`: in Tests und der CLI der Store selbst
// (`storeHybridTarget`), in der App der Store-Worker hinter Nachrichten. Rechnen (HTML lesen, API) und Schreiben sind
// so getrennt, wie die App es braucht.
//
// Fortsetzen: welche Seiten noch Inhalt brauchen, steht an den Seiten selbst (`importPending`). Der kleine
// `HybridImportState` daneben merkt sich nur Phase, Zeitmarke für den Delta-Abgleich und den Bericht.
import type { WorkspaceStore } from "../../store/store.js";
import type { AssetSink } from "../builder.js";
import { NotionAPIError, type NotionClient } from "../notion-api/client.js";
import { ImportCancelled } from "../zip.js";
import { commitHybridContent, commitHybridStructure, hybridPending, hybridStructureToWire, type HybridContentResult, type HybridPendingPage, type HybridStructureResult, type HybridStructureWire } from "./commit.js";
import { fetchApiPageContent, readZipPageContent, type HybridPageContent } from "./content.js";
import { HybridImportError, type NotionExportIndex } from "./export-index.js";
import { crawlHybridStructure, type HybridDeviation, type HybridDeviationKind } from "./structure.js";

export type HybridMode = "full" | "resume" | "delta";
export type HybridPhase = "structure" | "content" | "done";

/** Dauerhafter Stand eines Imports (klein, JSON). */
export interface HybridImportState {
  version: 1;
  phase: HybridPhase;
  mode: HybridMode;
  startedAt: string;
  /** Bis hierher kennt Based Notions Stand (ISO) – der nächste Delta-Abgleich fragt ab hier. */
  watermark: string | undefined;
  /** Zeitmarke des laufenden Struktur-Laufs; wird `watermark`, sobald die Struktur geschrieben ist. */
  nextWatermark: string | undefined;
  exportedAt: number | undefined;
  zipName: string | undefined;
  totals: { pages: number; rows: number; databases: number; content: number };
  done: { fromZip: number; viaApi: number; blocks: number; conflicts: number };
  requests: number;
  deviations: HybridDeviation[];
  warnings: string[];
  finishedAt: string | undefined;
}

/** Wo geschrieben und der Stand gehalten wird. */
export interface HybridTarget {
  commitStructure(wire: HybridStructureWire): Promise<HybridStructureResult>;
  pending(): Promise<HybridPendingPage[]>;
  commitContent(batch: HybridPageContent[]): Promise<HybridContentResult>;
  loadState(): Promise<HybridImportState | undefined>;
  saveState(state: HybridImportState): Promise<void>;
}

/** Ablage für den Stand (in der App: lokal je Workspace). */
export interface HybridStateStore {
  load(): HybridImportState | undefined;
  save(state: HybridImportState): void;
}

export class MemoryHybridState implements HybridStateStore {
  state: HybridImportState | undefined;
  load() { return this.state === undefined ? undefined : structuredClone(this.state); }
  save(s: HybridImportState) { this.state = structuredClone(s); }
}

/** Ziel direkt über einem Store (Tests, CLI). */
export function storeHybridTarget(store: WorkspaceStore, state: HybridStateStore = new MemoryHybridState(), parent = "w"): HybridTarget {
  return {
    commitStructure: (w) => Promise.resolve(commitHybridStructure(store, w, parent)),
    pending: () => Promise.resolve(hybridPending(store)),
    commitContent: (b) => Promise.resolve(commitHybridContent(store, b)),
    loadState: () => Promise.resolve(state.load()),
    saveState: (s) => { state.save(s); return Promise.resolve(); },
  };
}

export interface HybridProgress {
  phase: HybridPhase;
  /** 0…1 innerhalb der Phase. */
  fraction: number;
  message: string;
  /** Inhalt: erledigte / alle Seiten dieses Laufs. */
  done: number;
  total: number;
}

export interface HybridImportOptions {
  downloadFiles?: boolean | undefined;
  /** Seiten je Schreibschritt aus dem ZIP. */
  zipBatch?: number | undefined;
  /** Gleichzeitige Seiten über die API (das Ratenlimit hält der Client). */
  apiConcurrency?: number | undefined;
  exportedAt?: number | undefined;
  exportSkewHours?: number | undefined;
  zipName?: string | undefined;
  /** Uhr für Zeitmarken (Tests). */
  clock?: (() => Date) | undefined;
  isCancelled?: (() => boolean) | undefined;
  /** Nach jedem Schreibschritt: der Oberfläche Luft lassen. */
  yield?: (() => Promise<void>) | undefined;
}

export interface HybridImportReport {
  state: HybridImportState;
  /** Seiten, die noch auf Inhalt warten (z. B. weil das ZIP fehlt oder abgebrochen wurde). */
  remaining: number;
  /** Davon solche, die das ZIP brauchen. */
  waitingForZip: number;
  cancelled: boolean;
}

const WATERMARK_OVERLAP_MS = 120_000;
const MAX_DEVIATIONS = 5000;
const TOO_MANY = `More than ${MAX_DEVIATIONS} differences between the export, Notion and Based — only the first ${MAX_DEVIATIONS} are listed.`;

export class HybridNotionImport {
  onProgress: ((p: HybridProgress) => void) | undefined;
  private readonly urgent: string[] = [];
  private state!: HybridImportState;

  constructor(private readonly client: NotionClient, private readonly index: NotionExportIndex | undefined, private readonly target: HybridTarget,
              private readonly assets: AssetSink | undefined, private readonly options: HybridImportOptions = {}) {}

  /** Eine Seite vorziehen (jemand hat sie geöffnet). */
  prioritize(pageID: string) {
    const i = this.urgent.indexOf(pageID);
    if (i >= 0) this.urgent.splice(i, 1);
    this.urgent.unshift(pageID);
  }

  private now() { return (this.options.clock?.() ?? new Date()); }
  private cancelled() { return this.options.isCancelled?.() === true || this.client.signal?.aborted === true; }
  private checkCancel() { if (this.cancelled()) throw new ImportCancelled(); }

  /**
   * `full`: alles (auch erneut – vorhandene Seiten werden aktualisiert, nichts doppelt). `resume`: dort weitermachen,
   * wo ein früherer Lauf aufgehört hat. `delta`: nur, was sich in Notion seit dem letzten Lauf geändert hat.
   */
  async run(mode: HybridMode): Promise<HybridImportReport> {
    const prev = await this.target.loadState();
    if (mode !== "full" && prev === undefined) {
      if (mode === "delta") throw new HybridImportError("noState", "There's no earlier Notion import to update. Run the import first.");
      mode = "full";
    }
    if (mode === "delta" && prev?.watermark === undefined) mode = "full";
    const resumeContent = mode === "resume" && prev !== undefined && prev.phase !== "structure";
    if (resumeContent) {
      this.state = { ...prev, phase: prev.phase === "done" ? "content" : prev.phase, finishedAt: undefined };
      this.baseRequests = prev.requests;
    } else {
      // Ein abgebrochener Struktur-Lauf beginnt neu – er kostet Minuten und schreibt erst am Ende.
      const effective: HybridMode = mode === "resume" ? prev?.mode ?? "full" : mode;
      this.state = {
        version: 1, phase: "structure", mode: effective, startedAt: this.now().toISOString(),
        watermark: prev?.watermark, nextWatermark: undefined,
        exportedAt: this.options.exportedAt ?? this.index?.exportedAt ?? prev?.exportedAt, zipName: this.options.zipName ?? prev?.zipName,
        totals: { pages: 0, rows: 0, databases: 0, content: 0 }, done: { fromZip: 0, viaApi: 0, blocks: 0, conflicts: 0 },
        requests: 0, deviations: [], warnings: [], finishedAt: undefined,
      };
      if (this.state.mode === "full" && this.index === undefined) {
        throw new HybridImportError("needsZip", "The fast import needs the Notion HTML export (ZIP). Without it, use the API-only import.");
      }
    }
    await this.target.saveState(this.state);
    let cancelled = false;
    try {
      if (this.state.phase === "structure") await this.structure();
      await this.content();
      const left = await this.target.pending();
      if (left.length === 0) { this.state.phase = "done"; this.state.finishedAt = this.now().toISOString(); }
    } catch (e) {
      if (e instanceof ImportCancelled || (e instanceof NotionAPIError && e.kind === "cancelled")) cancelled = true;
      else { this.state.requests = this.client.requestCount + this.baseRequests; await this.target.saveState(this.state).catch(() => undefined); throw e; }
    }
    this.state.requests = this.client.requestCount + this.baseRequests;
    await this.target.saveState(this.state);
    const left = await this.target.pending();
    return { state: this.state, remaining: left.length, waitingForZip: this.index === undefined ? left.filter((p) => p.source === "zip").length : 0, cancelled };
  }

  private baseRequests = 0;

  /** Abweichungen in den Stand; der Stand bleibt klein (der Bericht nennt die Gesamtzahl je Art trotzdem nicht falsch: ab der Grenze steht es dabei). */
  private note(list: readonly HybridDeviation[]) {
    const s = this.state;
    for (const d of list) {
      if (s.deviations.length < MAX_DEVIATIONS) s.deviations.push(d);
      else if (!s.warnings.includes(TOO_MANY)) s.warnings.push(TOO_MANY);
    }
  }

  private async structure() {
    const s = this.state;
    const delta = s.mode === "delta";
    // Etwas Überlappung: was während des Laufs geändert wird, sieht der nächste Abgleich sicher.
    s.nextWatermark = new Date(this.now().getTime() - WATERMARK_OVERLAP_MS).toISOString();
    this.onProgress?.({ phase: "structure", fraction: 0, message: delta ? "Checking Notion for changes…" : "Reading the workspace structure from Notion…", done: 0, total: 0 });
    const structure = await crawlHybridStructure(this.client, this.index, {
      downloadFiles: this.options.downloadFiles, exportedAt: s.exportedAt, exportSkewHours: this.options.exportSkewHours, assets: this.assets,
      ...(delta && s.watermark !== undefined ? { editedSince: s.watermark } : {}),
      onProgress: (done, total, message) => this.onProgress?.({ phase: "structure", fraction: Math.min(0.95, done / Math.max(total, 1)), message, done: 0, total: 0 }),
    });
    this.checkCancel();
    this.onProgress?.({ phase: "structure", fraction: 0.97, message: "Adding pages and databases…", done: 0, total: 0 });
    const r = await this.target.commitStructure(hybridStructureToWire(structure));
    s.totals.pages = structure.stats.pages; s.totals.rows = structure.stats.rows; s.totals.databases = structure.stats.databases;
    s.totals.content = r.pending;
    this.note(r.deviations);
    s.warnings.push(...r.report.warnings);
    if (structure.stats.pages + structure.stats.rows + structure.stats.databases === 0 && !delta && s.warnings.length === 0) {
      s.warnings.push("Nothing was imported. Make sure the pages are shared with the integration (••• → Connections).");
    }
    s.watermark = s.nextWatermark;
    s.nextWatermark = undefined;
    s.phase = "content";
    s.requests = this.client.requestCount + this.baseRequests;
    await this.target.saveState(s);
    this.onProgress?.({ phase: "structure", fraction: 1, message: "Structure is ready", done: 0, total: r.pending });
  }

  private async content() {
    const s = this.state;
    const queue = await this.target.pending();
    const total = Math.max(queue.length, 1);
    let done = 0;
    const zip: HybridPendingPage[] = [];
    const api: HybridPendingPage[] = [];
    for (const p of queue) (p.source === "zip" ? zip : api).push(p);
    const report = (title: string) => this.onProgress?.({ phase: "content", fraction: done / total, message: title ? `Page ${title}` : "Loading page content…", done, total: queue.length });
    report("");
    const take = (list: HybridPendingPage[], n: number): HybridPendingPage[] => {
      const out: HybridPendingPage[] = [];
      for (const id of [...this.urgent]) {
        const i = list.findIndex((p) => p.id === id);
        if (i < 0) continue;
        out.push(...list.splice(i, 1));
        this.urgent.splice(this.urgent.indexOf(id), 1);
        if (out.length >= n) return out;
      }
      out.push(...list.splice(0, n - out.length));
      return out;
    };
    const apply = async (batch: HybridPageContent[]) => {
      if (batch.length === 0) return;
      const r = await this.target.commitContent(batch);
      s.done.blocks += r.blocks;
      s.done.conflicts += r.deviations.filter((d) => d.kind === "conflict").length;
      for (const c of batch) if (r.retryViaApi.includes(c.pageID)) { const p = queue.find((q) => q.id === c.pageID); if (p) api.push({ ...p, source: "api" }); }
      const ok = r.pages;
      if (batch[0]!.source === "zip") s.done.fromZip += ok; else s.done.viaApi += ok;
      this.note(r.deviations);
      for (const w of r.warnings) if (!s.warnings.includes(w)) s.warnings.push(w);
      done += batch.length - r.retryViaApi.length;
      s.requests = this.client.requestCount + this.baseRequests;
      await this.target.saveState(s);
    };
    const zipLane = async () => {
      const index = this.index;
      if (index === undefined) return;
      const size = Math.max(1, this.options.zipBatch ?? 40);
      while (zip.length > 0) {
        this.checkCancel();
        const batch = take(zip, size).map((p) => readZipPageContent(index, p.id, { assets: this.assets }) ?? ({ pageID: p.id, source: "zip", builder: emptyWire(), failed: "not in the export", warnings: [] } satisfies HybridPageContent));
        await apply(batch);
        report(queue.find((q) => q.id === batch[batch.length - 1]!.pageID)?.title ?? "");
        await (this.options.yield?.() ?? Promise.resolve());
      }
    };
    const apiLane = async () => {
      const n = Math.max(1, this.options.apiConcurrency ?? 3);
      // Auch Seiten, die das ZIP nicht lesen konnte, landen hier – deshalb erst enden, wenn beide Listen leer sind.
      for (;;) {
        if (api.length === 0) { if (zip.length === 0 || this.index === undefined) break; await tick(); continue; }
        this.checkCancel();
        const pages = take(api, n);
        const batch = await Promise.all(pages.map((p) => fetchApiPageContent(this.client, p.id, { assets: this.assets, downloadFiles: this.options.downloadFiles })));
        await apply(batch);
        report(pages[pages.length - 1]!.title);
      }
    };
    await Promise.all([zipLane(), apiLane()]);
    if (api.length > 0) { this.checkCancel(); await apiLaneDrain(api, take, apply, this.client, this.assets, this.options, () => this.checkCancel()); }
    report("");
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function apiLaneDrain(api: HybridPendingPage[], take: (l: HybridPendingPage[], n: number) => HybridPendingPage[], apply: (b: HybridPageContent[]) => Promise<void>,
                            client: NotionClient, assets: AssetSink | undefined, options: HybridImportOptions, check: () => void) {
  while (api.length > 0) {
    check();
    const pages = take(api, Math.max(1, options.apiConcurrency ?? 3));
    await apply(await Promise.all(pages.map((p) => fetchApiPageContent(client, p.id, { assets, downloadFiles: options.downloadFiles }))));
  }
}

const emptyWire = () => ({ blocks: [], databases: [], views: [], roots: [], complete: [], warnings: [], notes: [], pendingAssets: [], storedAssets: 0, createdBy: null });

// MARK: Bericht

const LABEL: Record<HybridDeviationKind, (n: number) => string> = {
  missingInZip: (n) => `${n} page${n === 1 ? " is" : "s are"} in Notion but not in the export — read through the API instead`,
  editedAfterExport: (n) => `${n} page${n === 1 ? " was" : "s were"} edited in Notion around or after the export — read through the API instead`,
  onlyInZip: (n) => `${n} page${n === 1 ? " is" : "s are"} only in the export (not shared with the integration, or deleted since) — imported from the ZIP without views and relations`,
  titleDiffers: (n) => `${n} page title${n === 1 ? "" : "s"} differ between the export and Notion — kept Notion's`,
  conflict: (n) => `${n} page${n === 1 ? " was" : "s were"} changed in both Notion and Based — kept the Based version`,
  unmatchedDatabase: (n) => `${n} embedded database${n === 1 ? "" : "s"} or sub-page${n === 1 ? "" : "s"} in the export couldn't be matched to Notion`,
  danglingRelation: (n) => `${n} row${n === 1 ? " has" : "s have"} relations to pages that weren't imported (not shared with the integration)`,
  deletedInNotion: (n) => `${n} page${n === 1 ? "" : "s"} no longer exist${n === 1 ? "s" : ""} in Notion — kept in Based`,
  unreadable: (n) => `${n} page${n === 1 ? "" : "s"} couldn't be read`,
};

/** Abweichungen als Warnzeilen: je Art eine Zeile mit Anzahl und den ersten Titeln. */
export function hybridDeviationWarnings(deviations: readonly HybridDeviation[], sample = 8): string[] {
  const by = new Map<HybridDeviationKind, HybridDeviation[]>();
  for (const d of deviations) by.set(d.kind, [...(by.get(d.kind) ?? []), d]);
  const out: string[] = [];
  for (const [kind, list] of by) {
    const names = [...new Set(list.map((d) => (d.detail !== undefined && (kind === "titleDiffers" || kind === "unmatchedDatabase") ? `${d.title} (${d.detail})` : d.title)))];
    const shown = names.slice(0, sample).map((t) => `“${t}”`).join(", ");
    out.push(`${LABEL[kind](list.length)}: ${shown}${names.length > sample ? `, and ${names.length - sample} more` : ""}.`);
  }
  return out;
}

/** Bericht zum Kopieren: ohne Token und ohne Seiteninhalt; alle Abweichungen einzeln (Titel und IDs). */
export function hybridDiagnosticReport(state: HybridImportState, remaining = 0): string {
  const lines = [
    "Based — Notion hybrid import report",
    `Started: ${state.startedAt}`,
    `Finished: ${state.finishedAt ?? "not finished"}`,
    `Mode: ${state.mode} · phase: ${state.phase}`,
    `Export: ${state.zipName ?? "—"}${state.exportedAt !== undefined ? ` (${new Date(state.exportedAt).toISOString()})` : ""}`,
    `Structure: ${state.totals.pages} pages, ${state.totals.rows} rows, ${state.totals.databases} databases`,
    `Content: ${state.done.fromZip} pages from the ZIP, ${state.done.viaApi} through the API, ${state.done.blocks} blocks; ${remaining} waiting`,
    `Requests: ${state.requests}`,
    `Next update from: ${state.watermark ?? "—"}`,
  ];
  if (state.warnings.length > 0) { lines.push(`Warnings (${state.warnings.length}):`); lines.push(...state.warnings.slice(0, 200).map((w) => "  • " + w)); }
  if (state.deviations.length > 0) {
    lines.push(`Differences (${state.deviations.length}):`);
    lines.push(...state.deviations.slice(0, 2000).map((d) => `  • ${d.kind} ${d.id.slice(0, 8)}… “${d.title}”${d.detail !== undefined ? ` — ${d.detail}` : ""}`));
    if (state.deviations.length > 2000) lines.push(`  … and ${state.deviations.length - 2000} more`);
  }
  return lines.join("\n");
}
